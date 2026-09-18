#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <napi.h>
#include <objbase.h>
#include <set>
#include <thread>
#include <uv.h>
#include <variant>
#include <vector>
#include <windows.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>

namespace smtc {
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Media::Control;
using namespace Windows::Storage::Streams;
using Session = GlobalSystemMediaTransportControlsSession;
using Manager = GlobalSystemMediaTransportControlsSessionManager;

/**
 * 跨线程消息的数据容器，拥有字符串、对象、数组和字节数据的所有权。
 * 原生线程只组装 Data，Node 环境线程再将它转换为 JS 值；
 * 容器中不保存 napi_value、JS Buffer 或 WinRT 流，避免跨线程使用这些对象。
 */
struct Data {
    using Object = std::map<std::string, Data>;
    using Array = std::vector<Data>;
    using Bytes = std::vector<uint8_t>;
    std::variant<std::nullptr_t, bool, double, std::string, Object, Array,
                 Bytes>
        value;
    // 构造空值，对应 JS 的 null。
    Data() : value(nullptr) {}
    // 保存布尔值。
    Data(bool v) : value(v) {}
    // 保存数值，统一映射为 JS number。
    Data(double v) : value(v) {}
    // 复制 C 字符串，使消息不依赖调用方的字符缓冲区寿命。
    Data(const char *v) : value(std::string(v)) {}
    // 接管按值传入的字符串。
    Data(std::string v) : value(std::move(v)) {}
    // 接管对象及其各字段的数据。
    Data(Object v) : value(std::move(v)) {}
    // 接管数组及其元素的数据。
    Data(Array v) : value(std::move(v)) {}
    // 接管原生字节数组，交付时再复制为独立的 JS Buffer。
    Data(Bytes v) : value(std::move(v)) {}

    // 仅在所属 Node 环境线程调用：递归创建 JS 值，失败时抛出 napi_status，
    // 交由派发层处理，避免在正在终止的环境中尝试构造 JS 错误对象。
    napi_value js(napi_env env) const {
        return std::visit(
            [env](const auto &v) -> napi_value {
                using T = std::decay_t<decltype(v)>;
                auto check = [](napi_status status) {
                    if (status != napi_ok)
                        throw status;
                };
                napi_value result = nullptr;
                if constexpr (std::is_same_v<T, std::nullptr_t>)
                    check(napi_get_null(env, &result));
                else if constexpr (std::is_same_v<T, bool>)
                    check(napi_get_boolean(env, v, &result));
                else if constexpr (std::is_same_v<T, double>)
                    check(napi_create_double(env, v, &result));
                else if constexpr (std::is_same_v<T, std::string>)
                    check(napi_create_string_utf8(env, v.data(), v.size(),
                                                  &result));
                else if constexpr (std::is_same_v<T, Object>) {
                    check(napi_create_object(env, &result));
                    for (const auto &[k, item] : v)
                        check(napi_set_named_property(env, result, k.c_str(),
                                                      item.js(env)));
                } else if constexpr (std::is_same_v<T, Array>) {
                    check(
                        napi_create_array_with_length(env, v.size(), &result));
                    for (size_t i = 0; i < v.size(); ++i)
                        check(napi_set_element(env, result,
                                               static_cast<uint32_t>(i),
                                               v[i].js(env)));
                } else
                    check(napi_create_buffer_copy(env, v.size(), v.data(),
                                                  nullptr, &result));
                return result;
            },
            value);
    }

};



using Object = Data::Object;
// 原生请求的预期失败，携带可供 TypeScript 层识别的稳定错误码。
struct Failure {
    std::string code;
};
// Node 线程提交给 executor 的纯数据请求；id 用于关联完成消息，
// operation 指定操作，session 指定会话，argument/value 携带该操作的参数。
struct Request {
    double id;
    std::string operation, session, argument;
};

/**
 * 单个媒体会话的原生资源记录，由 Runtime 的 executor 管理。
 * 保存 WinRT session、COM identity、订阅 token 和当前封面引用；
 * 各域的原子 epoch 可由 Windows 回调递增，用于识别读取期间的数据变化。
 * 不负责播放器选择或公共状态缓存，这些职责留在 TypeScript 层。
 */
struct Entry {
    Session session{nullptr};
    com_ptr<::IUnknown> identity;
    event_token media{}, playback{}, timeline{};
    bool mediaOn = false, playbackOn = false, timelineOn = false;
    IRandomAccessStreamReference thumbnail{nullptr};
    std::string thumbnailId;
    uint64_t revision = 0;
    std::shared_ptr<std::atomic<uint64_t>> mediaEpoch =
        std::make_shared<std::atomic<uint64_t>>(0);
    std::shared_ptr<std::atomic<uint64_t>> playbackEpoch =
        std::make_shared<std::atomic<uint64_t>>(0);
    std::shared_ptr<std::atomic<uint64_t>> timelineEpoch =
        std::make_shared<std::atomic<uint64_t>>(0);
};

/**
 * 一次监控运行的原生执行器，负责 WinRT 访问、会话注册表、消息传递与安全关闭。
 * 专用 MTA 线程串行操作 manager、session、订阅和异步操作表；Windows
 * 回调只投递任务。 Node 环境线程通过 TSFN 接收消息，并通过 libuv 与异步 cleanup
 * hook 等待资源释放。 shared/weak 所有权保证迟到回调不会访问已销毁的 JS
 * wrapper。
 */
class Runtime : public std::enable_shared_from_this<Runtime> {
  public:
    // Node 环境的消息桥，以及在线程退出后完成 join 和清理的 libuv 句柄。
    napi_threadsafe_function bridge = nullptr;
    uv_async_t cleanupSignal{};
    uv_work_t joinWork{};
    std::thread worker;
    bool joined = false, finalized = false, cleanupClosing = false;
    napi_async_cleanup_hook_handle cleanup = nullptr;
    bool mainReleased = false; // 仅由所属 Node 环境线程读写。
    bool environmentClosing = false;
    std::atomic<bool> closing{false};

    // 启动专用 executor；run 返回后通知 Node 环境线程安排异步 join。
    void launch() {
        auto self = shared_from_this();
        worker = std::thread([self] {
            self->run();
            uv_async_send(&self->cleanupSignal);
        });
    }
    // 在 Node 环境线程汇合“线程已 join”和“TSFN 已终结”两个条件。
    // 两者均完成后关闭清理句柄，解除 cleanup hook，并释放句柄持有的 Runtime
    // 引用。
    void finishCleanup() {
        if (!joined || !finalized || cleanupClosing)
            return;
        cleanupClosing = true;
        uv_close(reinterpret_cast<uv_handle_t *>(&cleanupSignal),
                 [](uv_handle_t *handle) {
                     auto owner =
                         static_cast<std::shared_ptr<Runtime> *>(handle->data);
                     if ((*owner)->cleanup)
                         napi_remove_async_cleanup_hook((*owner)->cleanup);
                     delete owner;
                 });
    }
    // executor 退出信号的 libuv 回调：将 join
    // 交给线程池，随后通知正常关闭完成， 释放消息生产者的 TSFN
    // 使用权，并尝试完成最终清理。
    static void exited(uv_async_t *handle) {
        auto self =
            static_cast<std::shared_ptr<Runtime> *>(handle->data)->get();
        self->joinWork.data = self;
        // 只有收到退出信号后才安排 join，且不在 Node 环境线程中等待。
        const int status = uv_queue_work(
            handle->loop, &self->joinWork,
            [](uv_work_t *work) {
                static_cast<Runtime *>(work->data)->worker.join();
            },
            [](uv_work_t *work, int) {
                auto self = static_cast<Runtime *>(work->data);
                self->joined = true;
                if (!self->environmentClosing)
                    self->send(Object{{"type", "closed"}});
                if (!self->producerReleased) {
                    self->producerReleased = true;
                    napi_release_threadsafe_function(self->bridge,
                                                     napi_tsfn_release);
                }
                self->finishCleanup();
            });
        if (status != 0)
            std::terminate(); // 无法 join
                              // 时不能安全卸载仍可能被线程使用的代码。
    }
    // TSFN 的环境线程回调：取出消息后释放队列锁，再转换数据并调用 JS。
    // 环境已关闭时只回收数据；正常关闭消息交付后释放环境侧的 TSFN 使用权。
    static void dispatch(napi_env rawEnv, napi_value rawCallback, void *context,
                         void *) {
        auto self = static_cast<Runtime *>(context);
        std::deque<Data> messages;
        {
            std::lock_guard guard(self->outputMutex);
            messages.swap(self->output);
            self->wakePending = false;
        }
        if (!rawEnv || !rawCallback || self->environmentClosing)
            return;
        for (auto &message : messages) {
            const auto &object = std::get<Object>(message.value);
            const bool closed =
                std::get<std::string>(object.at("type").value) == "closed";
            napi_status status = napi_ok;
            try {
                auto value = message.js(rawEnv);
                napi_value receiver = nullptr, ignored = nullptr;
                status = napi_get_undefined(rawEnv, &receiver);
                if (status == napi_ok)
                    status = napi_call_function(rawEnv, receiver, rawCallback,
                                                1, &value, &ignored);
            } catch (napi_status failed) {
                status = failed;
            } catch (...) {
                status = napi_generic_failure;
            }
            if (closed)
                self->releaseMain(false);
            if (status != napi_ok) {
                // Worker 终止时可能返回 pending_exception，却没有实际异常值。
                // 此时不能在正在终止的环境中尝试构造 Napi::Error。
                bool pending = false;
                napi_is_exception_pending(rawEnv, &pending);
                if (pending) {
                    napi_value exception = nullptr;
                    if (napi_get_and_clear_last_exception(rawEnv, &exception) ==
                        napi_ok)
                        napi_fatal_exception(rawEnv, exception);
                }
                self->close();
                break;
            }
        }
    }
    // 可跨线程调用的非阻塞关闭请求：置位关闭标志并唤醒
    // executor，不在调用方等待。
    void close() noexcept {
        closing.store(true);
        condition.notify_one();
    }
    // 将显式请求放入输入队列；关闭期间或队列达到上限时立即拒绝。
    void enqueue(Request request) {
        std::lock_guard lock(inputMutex);
        if (closing)
            throw Failure{"ERR_SMTC_SHUTTING_DOWN"};
        if (requests.size() >= 128)
            throw Failure{"ERR_SMTC_BUSY"};
        requests.push_back(std::move(request));
        condition.notify_one();
    }
    // 登记取消请求，由 executor 使请求失效并尝试取消对应 WinRT 异步操作。
    void cancel(double id) {
        std::lock_guard lock(inputMutex);
        if (!closing) {
            cancellations.insert(id);
            condition.notify_one();
        }
    }
    // 仅在 Node 环境线程调用，幂等释放环境侧的 TSFN 使用权；
    // abort 为 true 时同时阻止后续消息继续进入 TSFN。
    void releaseMain(bool abort) {
        if (mainReleased)
            return;
        mainReleased = true;
        napi_release_threadsafe_function(bridge, abort ? napi_tsfn_abort
                                                       : napi_tsfn_release);
    }
    // 自然退出、Worker 终止或启动线程失败时进入此清理路径。
    // 关闭运行时并禁止后续发送，同时保留清理句柄以等待线程和 TSFN 释放。
    void beginEnvironmentCleanup() {
        environmentClosing = true;
        uv_ref(reinterpret_cast<uv_handle_t *>(&cleanupSignal));
        close();
        {
            std::lock_guard lock(outputMutex);
            // 排除所有后续发送后，接管并释放生产者使用权。
            // 较旧 Node 版本在环境退出时可能不等使用计数归零就终结 TSFN。
            if (!producerReleased) {
                producerReleased = true;
                napi_release_threadsafe_function(bridge, napi_tsfn_release);
            }
        }
        releaseMain(true);
    }

  private:
    // 输入与输出使用独立短锁；取出任务后才执行 WinRT 或 JS 调用。
    std::mutex inputMutex, outputMutex;
    std::condition_variable condition;
    std::deque<Request> requests;
    std::deque<std::function<void()>> completions;
    std::set<double> cancellations;
    std::set<std::pair<std::string, std::string>> notifications;
    std::deque<Data> output;
    bool wakePending = false;
    bool producerReleased =
        false; // 发送和环境清理时由输出锁保护；join 后由环境线程收尾。
    // 以下 WinRT 资源和注册表在 executor 上管理；实例前缀保证会话 ID
    // 不跨实例复用。
    Manager manager{nullptr};
    event_token sessionsToken{}, currentToken{};
    bool sessionsOn = false, currentOn = false;
    std::map<std::string, Entry> sessions;
    std::map<double, IAsyncInfo> operations;
    std::set<double> live;
    std::string tracked;
    uint64_t counter = 0;
    const std::string prefix = [] {
        GUID guid{};
        check_hresult(CoCreateGuid(&guid));
        wchar_t buffer[40]{};
        StringFromGUID2(guid, buffer, 40);
        return to_string(buffer);
    }();

    // 将 WinRT 异步完成任务送回 executor；关闭后丢弃任务，投递失败则发起关闭。
    void post(std::function<void()> action) noexcept {
        try {
            std::lock_guard lock(inputMutex);
            if (!closing) {
                completions.push_back(std::move(action));
                condition.notify_one();
            }
        } catch (...) {
            close();
        }
    }
    // 合并同一会话、同一域的系统通知，避免事件风暴挤占显式请求通道。
    // 通知集合超限时插入 resync，要求 TypeScript 层重新读取完整状态。
    void notify(std::string session, std::string domain) noexcept {
        try {
            std::lock_guard lock(inputMutex);
            if (closing)
                return;
            // 自动通知单独限流，不丢弃显式请求的完成任务。
            if (notifications.size() >= 256) {
                notifications.clear();
                notifications.emplace("", "resync");
            }
            notifications.emplace(std::move(session), std::move(domain));
            condition.notify_one();
        } catch (...) {
            close();
        }
    }
    // 将纯数据消息送入出站队列，并通过非阻塞 TSFN 调用唤醒 Node 环境线程。
    // 合并尚未交付的重复通知、在通知超限时要求重同步，保留请求结果和关闭消息。
    void send(Data message) noexcept {
        try {
            std::lock_guard lock(outputMutex);
            if (producerReleased)
                return;
            const auto &incoming = std::get<Object>(message.value);
            if (std::get<std::string>(incoming.at("type").value) == "notify") {
                size_t count = 0;
                for (auto it = output.begin(); it != output.end();) {
                    const auto &queued = std::get<Object>(it->value);
                    if (std::get<std::string>(queued.at("type").value) ==
                        "notify") {
                        ++count;
                        if (std::get<std::string>(
                                queued.at("sessionId").value) ==
                                std::get<std::string>(
                                    incoming.at("sessionId").value) &&
                            std::get<std::string>(queued.at("domain").value) ==
                                std::get<std::string>(
                                    incoming.at("domain").value)) {
                            it = output.erase(it);
                            continue;
                        }
                    }
                    ++it;
                }
                if (count >= 256) {
                    std::erase_if(output, [](const Data &item) {
                        return std::get<std::string>(
                                   std::get<Object>(item.value)
                                       .at("type")
                                       .value) == "notify";
                    });
                    message = Object{{"type", "notify"},
                                     {"sessionId", ""},
                                     {"domain", "resync"}};
                }
            }
            output.push_back(std::move(message));
            if (wakePending)
                return;
            wakePending = true;
            const auto status = napi_call_threadsafe_function(
                bridge, nullptr, napi_tsfn_nonblocking);
            if (status != napi_ok) {
                output.clear();
                wakePending = false;
                // napi_closing 已消耗生产者使用权，再次 Release
                // 可能访问已释放内存。
                if (status == napi_closing)
                    producerReleased = true;
            }
        } catch (...) {
            close();
        }
    }
    // 完成一个仍有效的请求，移除其异步操作记录，并发送成功结果；重复完成被忽略。
    void result(double id, Data data = {}) {
        if (!live.erase(id))
            return;
        operations.erase(id);
        send(Object{{"type", "result"}, {"id", id}, {"data", std::move(data)}});
    }
    // 完成一个仍有效的失败请求，返回稳定错误码及可选的原生诊断值。
    void fail(double id, const std::string &code,
              const std::string &native = {}) {
        if (!live.erase(id))
            return;
        operations.erase(id);
        Object failure{{"code", code}};
        if (!native.empty())
            failure.emplace("nativeCode", native);
        send(Object{
            {"type", "result"}, {"id", id}, {"error", std::move(failure)}});
    }
    // 只能从 catch 路径调用：将当前 C++ 异常转为请求失败消息。
    // 保留 Failure 的错误码，将 HRESULT 格式化为十六进制，其余异常使用
    // fallback。
    void
    exception(double id,
              const char *fallback = "ERR_SMTC_OPERATION_FAILED") noexcept {
        try {
            try {
                throw;
            } catch (const Failure &failure) {
                fail(id, failure.code);
            } catch (const hresult_error &e) {
                char hex[11]{};
                snprintf(hex, sizeof(hex), "0x%08X",
                         static_cast<unsigned>(e.code().value));
                fail(id, fallback, hex);
            } catch (...) {
                fail(id, fallback);
            }
        } catch (...) {
            close();
        }
    }
    // 在 executor 上登记 WinRT 异步操作并安装 Completed 回调，不同步等待结果。
    // 完成后通过 agile reference 回到 executor，检查请求仍有效后才 GetResults
    // 并执行 complete。
    template <class T, class F>
    void async(double id, IAsyncOperation<T> operation, F complete,
               const char *failure = "ERR_SMTC_OPERATION_FAILED") {
        operations[id] = operation.template as<IAsyncInfo>();
        auto weak = weak_from_this();
        // 回调不保存裸 wrapper 指针；通过 agile reference
        // 跨线程取得已完成的操作。
        operation.Completed([weak, id, complete, failure](
                                auto const &completed, AsyncStatus) noexcept {
            try {
                if (auto self = weak.lock()) {
                    auto reference = make_agile(completed);
                    self->post([self, reference, id, complete, failure] {
                        if (!self->live.contains(id) || self->closing)
                            return;
                        try {
                            complete(reference.get().GetResults());
                        } catch (...) {
                            self->exception(id, failure);
                        }
                    });
                }
            } catch (...) {
                if (auto self = weak.lock())
                    self->close();
            }
        });
    }
    // 查找仍登记在当前运行时中的会话；旧 ID 或未知 ID 统一返回 stale-session
    // 错误。
    Entry &entry(const std::string &id) {
        auto found = sessions.find(id);
        if (found == sessions.end())
            throw Failure{"ERR_SMTC_STALE_SESSION"};
        return found->second;
    }
    // 尝试撤销一项订阅；失败时记录诊断，确保其余资源的清理仍能继续。
    template <class F> void revoke(F action) noexcept {
        try {
            action();
        } catch (...) {
            // 一项订阅撤销失败不能中断后续资源释放。
            OutputDebugStringW(L"SMTC: event revocation failed\n");
            notify("", "revoke");
        }
    }
    // 撤销一个会话已安装的全部订阅并清除标志；不负责从注册表中删除该会话。
    void detach(Entry &item) noexcept {
        if (item.mediaOn)
            revoke([&] { item.session.MediaPropertiesChanged(item.media); });
        if (item.playbackOn)
            revoke([&] { item.session.PlaybackInfoChanged(item.playback); });
        if (item.timelineOn)
            revoke(
                [&] { item.session.TimelinePropertiesChanged(item.timeline); });
        item.mediaOn = item.playbackOn = item.timelineOn = false;
    }
    // 创建 Windows
    // 事件处理器：通过弱引用检查运行时寿命，递增可选的域版本并投递通知。
    // 处理器可能在系统线程执行，不直接访问 JS 或修改会话注册表。
    auto handler(std::string id, std::string domain,
                 std::shared_ptr<std::atomic<uint64_t>> epoch = {}) {
        return [weak = weak_from_this(), id, domain,
                epoch](auto const &, auto const &) noexcept {
            try {
                if (auto self = weak.lock()) {
                    if (epoch)
                        epoch->fetch_add(1);
                    self->notify(id, domain);
                }
            } catch (...) {
                if (auto self = weak.lock())
                    self->close();
            }
        };
    }
    // 在 executor 上枚举系统会话，以 COM identity
    // 对照注册表，新增订阅并移除失效会话。 返回会话
    // ID、原始来源标识和属于同一列表的 current session，不执行播放器选择策略。
    Data enumerate() {
        auto list = manager.GetSessions();
        std::set<std::string> retained;
        Data::Array data;
        for (const auto &session : list) {
            auto identity = session.as<::IUnknown>();
            std::string id;
            for (const auto &[key, item] : sessions)
                if (item.identity.get() == identity.get()) {
                    id = key;
                    break;
                }
            if (id.empty()) {
                id = prefix + "/" + std::to_string(++counter);
                Entry item;
                item.session = session;
                item.identity = identity;
                try {
                    item.media = session.MediaPropertiesChanged(
                        handler(id, "media", item.mediaEpoch));
                    item.mediaOn = true;
                    item.playback = session.PlaybackInfoChanged(
                        handler(id, "playback", item.playbackEpoch));
                    item.playbackOn = true;
                    sessions.emplace(id, std::move(item));
                } catch (...) {
                    detach(item);
                    throw;
                }
            }
            retained.insert(id);
            data.emplace_back(
                Object{{"sessionId", id},
                       {"sourceAppUserModelId",
                        to_string(session.SourceAppUserModelId())}});
        }
        for (auto it = sessions.begin(); it != sessions.end();) {
            if (!retained.contains(it->first)) {
                auto removed = std::move(it->second);
                if (tracked == it->first)
                    tracked.clear();
                it = sessions.erase(it); // 先使 ID 失效，再撤销订阅。
                detach(removed);
            } else
                ++it;
        }
        Data current;
        if (auto active = manager.GetCurrentSession()) {
            auto identity = active.as<::IUnknown>();
            for (const auto &[id, item] : sessions)
                if (item.identity.get() == identity.get()) {
                    current = id;
                    break;
                }
        }
        return Object{{"sessions", std::move(data)},
                      {"currentSessionId", current}};
    }
    // 在 executor
    // 上读取播放状态、可空的播放速率和系统控制能力，并转换为纯数据。
    Data playback(Entry &item) {
        auto info = item.session.GetPlaybackInfo();
        const char *status = "unknown";
        switch (info.PlaybackStatus()) {
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed:
            status = "closed";
            break;
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened:
            status = "opened";
            break;
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing:
            status = "changing";
            break;
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped:
            status = "stopped";
            break;
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing:
            status = "playing";
            break;
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused:
            status = "paused";
            break;
        }
        Data rate;
        if (auto value = info.PlaybackRate())
            rate = value.Value();
        return Object{
            {"status", status},
            {"playbackRate", rate}};
    }
    // 在 executor 上读取时间线，将 100ns 单位转换为毫秒、Windows 纪元转换为
    // Unix UTC。 缺失的更新时间保持
    // null，同时记录观测时间；不插值或修正播放器位置。
    Data timeline(Entry &item) {
        auto info = item.session.GetTimelineProperties();
        auto ms = [](TimeSpan value) {
            return static_cast<double>(value.count()) / 10000.0;
        };
        auto anchor = info.LastUpdatedTime().time_since_epoch().count();
        Data updated;
        if (anchor != 0)
            updated = static_cast<double>(anchor) / 10000.0 - 11644473600000.0;
        const auto now =
            std::chrono::duration<double, std::milli>(
                std::chrono::system_clock::now().time_since_epoch())
                .count();
        return Object{{"startTimeMs", ms(info.StartTime())},
                      {"endTimeMs", ms(info.EndTime())},
                      {"positionMs", ms(info.Position())},
                      {"minSeekTimeMs", ms(info.MinSeekTime())},
                      {"maxSeekTimeMs", ms(info.MaxSeekTime())},
                      {"lastUpdatedTimeUtcMs", updated},
                      {"observedAtUtcMs", now}};
    }
    // executor
    // 的请求分发入口：校验运行状态和会话，执行启动、枚举、跟踪、读取或控制。
    // 同步操作直接返回结果，异步操作交给 async；封面读取在此校验
    // token、大小和读取长度。
    void execute(const Request &r) {
        live.insert(r.id);
        if (live.size() > 128) {
            fail(r.id, "ERR_SMTC_BUSY");
            return;
        }
        try {
            if (r.operation == "start") {
                if (manager) {
                    result(r.id, enumerate());
                    return;
                }
                auto weak = weak_from_this();
                async(
                    r.id, Manager::RequestAsync(),
                    [weak, r](Manager value) {
                        auto self = weak.lock();
                        if (!self)
                            return;
                        self->manager = value;
                        self->sessionsToken = value.SessionsChanged(
                            self->handler("", "sessions"));
                        self->sessionsOn = true;
                        self->currentToken = value.CurrentSessionChanged(
                            self->handler("", "sessions"));
                        self->currentOn = true;
                        self->result(r.id, self->enumerate());
                    },
                    "ERR_SMTC_MANAGER_UNAVAILABLE");
                return;
            }
            if (!manager)
                throw Failure{"ERR_SMTC_NOT_STARTED"};
            if (r.operation == "sessions") {
                result(r.id, enumerate());
                return;
            }
            if (r.operation == "track") {
                if (!r.session.empty())
                    entry(r.session);
                if (!tracked.empty() && sessions.contains(tracked)) {
                    auto &old = entry(tracked);
                    if (old.timelineOn) {
                        old.session.TimelinePropertiesChanged(old.timeline);
                        old.timelineOn = false;
                    }
                }
                tracked.clear();
                if (!r.session.empty()) {
                    auto &item = entry(r.session);
                    item.timeline = item.session.TimelinePropertiesChanged(
                        handler(r.session, "timeline", item.timelineEpoch));
                    item.timelineOn = true;
                    tracked = r.session;
                }
                result(r.id);
                return;
            }
            auto &item = entry(r.session);
            if (r.operation == "playback" || r.operation == "timeline") {
                auto epoch = r.operation == "playback" ? item.playbackEpoch
                                                       : item.timelineEpoch;
                const auto version = epoch->load();
                auto data =
                    r.operation == "playback" ? playback(item) : timeline(item);
                result(r.id, epoch->load() == version
                                 ? std::move(data)
                                 : Data(Object{{"_smtcObsolete", true}}));
                return;
            }
            auto weak = weak_from_this();
            if (r.operation == "media") {
                auto epoch = item.mediaEpoch;
                const auto version = epoch->load();
                async(
                    r.id, item.session.TryGetMediaPropertiesAsync(),
                    [weak, r, epoch, version](auto media) {
                        auto self = weak.lock();
                        if (!self)
                            return;
                        auto &item = self->entry(r.session);
                        if (epoch->load() != version) {
                            self->result(r.id, Object{{"_smtcObsolete", true}});
                            return;
                        }
                        Data::Array genres;
                        for (const auto &genre : media.Genres())
                            genres.emplace_back(to_string(genre));
                        item.thumbnail = media.Thumbnail();
                        item.thumbnailId =
                            item.thumbnail ? r.session + "/image/" +
                                                 std::to_string(++item.revision)
                                           : "";
                        self->result(
                            r.id,
                            Object{
                                {"title", to_string(media.Title())},
                                {"subtitle", to_string(media.Subtitle())},
                                {"artist", to_string(media.Artist())},
                                {"albumTitle", to_string(media.AlbumTitle())},
                                {"albumArtist", to_string(media.AlbumArtist())},
                                {"genres", std::move(genres)},
                                {"trackNumber",
                                 static_cast<double>(media.TrackNumber())},
                                {"albumTrackCount",
                                 static_cast<double>(media.AlbumTrackCount())},
                                {"thumbnailId", item.thumbnail
                                                    ? Data(item.thumbnailId)
                                                    : Data()}});
                    });
            } else if (r.operation == "thumbnail") {
                if (r.argument != item.thumbnailId || r.argument.empty())
                    throw Failure{"ERR_SMTC_STALE_THUMBNAIL"};
                if (!item.thumbnail) {
                    result(r.id);
                    return;
                }
                async(r.id, item.thumbnail.OpenReadAsync(),
                      [weak, r](IRandomAccessStreamWithContentType stream) {
                          auto self = weak.lock();
                          if (!self)
                              return;
                          if (self->entry(r.session).thumbnailId != r.argument)
                              throw Failure{"ERR_SMTC_STALE_THUMBNAIL"};
                          const uint64_t size = stream.Size();
                          if (size > 4 * 1024 * 1024)
                              throw Failure{"ERR_SMTC_OPERATION_FAILED"};
                          if (!size) {
                              stream.Close();
                              self->result(r.id);
                              return;
                          }
                          auto reader = DataReader(stream.GetInputStreamAt(0));
                          auto reference = make_agile(reader);
                          auto streamReference = make_agile(stream);
                          self->async(
                              r.id,
                              reader.LoadAsync(static_cast<uint32_t>(size))
                                  .as<IAsyncOperation<uint32_t>>(),
                              [weak, r, reference, streamReference,
                               size](uint32_t loaded) {
                                  auto self = weak.lock();
                                  if (!self)
                                      return;
                                  auto reader = reference.get();
                                  auto stream = streamReference.get();
                                  if (self->entry(r.session).thumbnailId !=
                                      r.argument)
                                      throw Failure{"ERR_SMTC_STALE_THUMBNAIL"};
                                  if (loaded != size ||
                                      reader.UnconsumedBufferLength() != size)
                                      throw Failure{
                                          "ERR_SMTC_OPERATION_FAILED"};
                                  Data::Bytes bytes(loaded);
                                  reader.ReadBytes(bytes);
                                  auto contentType =
                                      to_string(stream.ContentType());
                                  reader.Close();
                                  stream.Close();
                                  self->result(
                                      r.id, Object{{"thumbnailId", r.argument},
                                                   {"contentType",
                                                    contentType.empty()
                                                        ? Data()
                                                        : Data(contentType)},
                                                   {"data", std::move(bytes)}});
                              });
                      });
            } else
                throw Failure{"ERR_SMTC_INVALID_ARGUMENT"};
        } catch (...) {
            exception(r.id, r.operation == "start"
                                ? "ERR_SMTC_MANAGER_UNAVAILABLE"
                                : "ERR_SMTC_OPERATION_FAILED");
        }
    }
    // 专用线程主循环：初始化 MTA，取出取消、通知、完成任务和请求后串行处理。
    // 关闭时使请求失效、取消操作、撤销订阅并释放 WinRT 引用，最后反初始化
    // apartment。
    void run() noexcept {
        bool initialized = false;
        try {
            init_apartment(apartment_type::multi_threaded);
            initialized = true;
            while (!closing) {
                std::deque<Request> work;
                std::deque<std::function<void()>> finished;
                std::set<std::pair<std::string, std::string>> signals;
                std::set<double> cancelled;
                {
                    std::unique_lock lock(inputMutex);
                    condition.wait(lock, [&] {
                        return closing || !requests.empty() ||
                               !completions.empty() || !notifications.empty() ||
                               !cancellations.empty();
                    });
                    if (closing)
                        break;
                    work.swap(requests);
                    finished.swap(completions);
                    signals.swap(notifications);
                    cancelled.swap(cancellations);
                }
                for (double id : cancelled) {
                    if (auto it = operations.find(id); it != operations.end()) {
                        try {
                            it->second.Cancel();
                        } catch (...) {
                        }
                        operations.erase(it);
                    }
                    live.erase(id);
                }
                // 同批次的变更通知先于读取结果交付，供上层识别已过期的读取。
                for (const auto &[id, domain] : signals) {
                    if (id.empty() || sessions.contains(id))
                        send(Object{{"type", "notify"},
                                    {"sessionId", id},
                                    {"domain", domain}});
                }
                for (auto &action : finished) {
                    if (closing)
                        break;
                    action();
                }
                for (const auto &request : work) {
                    if (closing)
                        break;
                    if (!cancelled.contains(request.id))
                        execute(request);
                }
            }
        } catch (...) {
            // 将初始化等异常返回给已经进入输入队列的请求。
            std::deque<Request> pending;
            {
                std::lock_guard lock(inputMutex);
                pending.swap(requests);
            }
            for (const auto &r : pending) {
                live.insert(r.id);
                exception(r.id, "ERR_SMTC_MANAGER_UNAVAILABLE");
            }
            closing = true;
        }
        live.clear();
        for (auto &[id, operation] : operations) {
            try {
                operation.Cancel();
            } catch (...) {
            }
        }
        operations.clear();
        for (auto &[id, item] : sessions)
            detach(item);
        sessions.clear();
        if (manager) {
            if (sessionsOn)
                revoke([&] { manager.SessionsChanged(sessionsToken); });
            if (currentOn)
                revoke([&] { manager.CurrentSessionChanged(currentToken); });
        }
        manager = nullptr;
        // 在锁外、且 apartment 尚未反初始化的 executor 上销毁任务捕获的 WinRT
        // 引用。
        std::deque<std::function<void()>> discarded;
        {
            std::lock_guard lock(inputMutex);
            discarded.swap(completions);
            requests.clear();
            notifications.clear();
        }
        discarded.clear();
        if (initialized)
            uninit_apartment();
    }
};

/**
 * Node-API 对象包装层，将 JS 内部传输接口连接到一个 Runtime。
 * 负责参数转换、TSFN/清理通道的创建及事件循环保活设置，不在此执行媒体业务逻辑。
 * 成员入口在所属 Node 环境线程调用；GC 析构只发起非阻塞关闭，最终释放由 Runtime
 * 协调。
 */
class Bridge : public Napi::ObjectWrap<Bridge> {
  public:
    // 为当前 Node environment 创建 SmtcBridge 构造函数并登记可调用的实例方法。
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "SmtcBridge",
                           {InstanceMethod("request", &Bridge::request),
                            InstanceMethod("cancel", &Bridge::cancel),
                            InstanceMethod("close", &Bridge::close),
                            InstanceMethod("ref", &Bridge::ref)});
    }
    // 校验 JS 回调，创建 Runtime、清理句柄与 TSFN，注册异步退出钩子并启动
    // executor。 TSFN 初始不保活；显式请求和关闭期间的保活由 TypeScript 层通过
    // ref 控制。
    Bridge(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Bridge>(info) {
        if (info.Length() != 1 || !info[0].IsFunction()){
            throw Napi::TypeError::New(info.Env(), "callback 必须是函数");
        }
        try {
            runtime = std::make_shared<Runtime>();
            auto owner = new std::shared_ptr<Runtime>(runtime);
            uv_loop_t *loop = nullptr;
            napi_get_uv_event_loop(info.Env(), &loop);
            if (uv_async_init(loop, &runtime->cleanupSignal, Runtime::exited) !=
                0) {
                delete owner;
                throw Napi::Error::New(info.Env(), "无法创建 SMTC 清理通道");
            }
            runtime->cleanupSignal.data = owner;
            uv_unref(reinterpret_cast<uv_handle_t *>(&runtime->cleanupSignal));
            const auto created = napi_create_threadsafe_function(
                info.Env(), info[0], nullptr,
                Napi::String::New(info.Env(), "SMTC"), 1, 2, owner,
                [](napi_env, void *data, void *) {
                    auto self =
                        static_cast<std::shared_ptr<Runtime> *>(data)->get();
                    self->finalized = true;
                    self->finishCleanup();
                },
                runtime.get(), Runtime::dispatch, &runtime->bridge);
            if (created != napi_ok) {
                runtime->joined = runtime->finalized = true;
                runtime->finishCleanup();
                throw Napi::Error::New(info.Env(), "无法创建 SMTC 事件桥");
            }
            napi_status status = napi_add_async_cleanup_hook(
                info.Env(),
                [](napi_async_cleanup_hook_handle, void *data) {
                    auto self = static_cast<Runtime *>(data);
                    self->beginEnvironmentCleanup();
                },
                runtime.get(), &runtime->cleanup);
            if (status != napi_ok) {
                runtime->joined = true;
                napi_release_threadsafe_function(runtime->bridge,
                                                 napi_tsfn_release);
                runtime->releaseMain(true);
                throw Napi::Error::New(info.Env(), "无法注册 SMTC 清理钩子");
            }
            napi_unref_threadsafe_function(info.Env(), runtime->bridge);
            try {
                runtime->launch();
            } catch (...) {
                runtime->joined = true;
                runtime->beginEnvironmentCleanup();
                throw;
            }
        } catch (const Napi::Error &) {
            throw;
        } catch (...) {
            throw Napi::Error::New(info.Env(), "无法初始化 SMTC 原生运行时");
        }
    }
    // wrapper 被 GC 回收时仅通知 Runtime 关闭，不在析构中等待原生线程。
    ~Bridge() {
        if (runtime)
            runtime->close();
    }

  private:
    std::shared_ptr<Runtime> runtime;
    // 校验内部请求的四个参数并转换为 Request；入队失败时向 JS 抛出错误。
    void request(const Napi::CallbackInfo &info) {
        if (info.Length() != 4 || !info[0].IsNumber() || !info[1].IsString() ||
            !info[2].IsString() || !info[3].IsString())
            throw Napi::TypeError::New(info.Env(), "无效的 SMTC 请求");
        try {
            runtime->enqueue({info[0].As<Napi::Number>().DoubleValue(),
                              info[1].As<Napi::String>().Utf8Value(),
                              info[2].As<Napi::String>().Utf8Value(),
                              info[3].As<Napi::String>().Utf8Value()});
        } catch (const Failure &failure) {
            auto error = Napi::Error::New(info.Env(), failure.code);
            error.Set("code", failure.code);
            throw error;
        } catch (...) {
            throw Napi::Error::New(info.Env(), "无法提交 SMTC 请求");
        }
    }
    // 校验请求 ID 并向 Runtime 登记取消，不在 Node 线程调用 WinRT Cancel。
    void cancel(const Napi::CallbackInfo &info) {
        if (info.Length() != 1 || !info[0].IsNumber())
            throw Napi::TypeError::New(info.Env(), "无效的请求 ID");
        try {
            runtime->cancel(info[0].As<Napi::Number>().DoubleValue());
        } catch (...) {
            throw Napi::Error::New(info.Env(), "无法取消 SMTC 请求");
        }
    }
    // JS 显式关闭入口，只发起关闭；完成情况由后续 closed 消息通知上层。
    void close(const Napi::CallbackInfo &) { runtime->close(); }
    // 设置 TSFN 是否保持 Node 事件循环存活；此操作不改变 TSFN 的使用权计数。
    void ref(const Napi::CallbackInfo &info) {
        if (runtime->mainReleased)
            return;
        if (info.Length() != 1 || !info[0].IsBoolean())
            throw Napi::TypeError::New(info.Env(), "ref 必须是布尔值");
        if (info[0].As<Napi::Boolean>())
            napi_ref_threadsafe_function(info.Env(), runtime->bridge);
        else
            napi_unref_threadsafe_function(info.Env(), runtime->bridge);
    }
};
// 初始化当前 Node environment 的模块导出，向内部加载层提供 Bridge 构造函数。
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    // 构造函数保存在当前环境的导出对象中，不使用跨 environment 的全局 JS 引用。
    auto constructor = Bridge::define(env);
    exports.Set("createBridge", constructor);
    return exports;
}
} // namespace smtc
// Node-API 模块注册入口，将初始化工作转交给 smtc 命名空间内的实现。
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return smtc::initialize(env, exports);
}
NODE_API_MODULE(smtc, Init)
