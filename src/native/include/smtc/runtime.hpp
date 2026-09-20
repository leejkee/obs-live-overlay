#pragma once

#include "protocol.hpp"
#include <memory>
#include <node_api.h>

namespace SMTC {

// 一次监控运行的原生执行器。构造和保活接口在所属 Node 环境线程调用；
// 请求、取消与关闭通过内部队列通知 executor，关闭不阻塞调用方。
class Runtime {
  public:
    // callback 必须是所属环境中的 JS 函数，由 Bridge 校验。
    Runtime(napi_env env, napi_value callback);
    ~Runtime();

    Runtime(const Runtime &) = delete;
    Runtime &operator=(const Runtime &) = delete;
    Runtime(Runtime &&) = delete;
    Runtime &operator=(Runtime &&) = delete;

    void enqueue(Request request);
    void cancel(double id);
    void close() noexcept;

    // 仅在所属 Node 环境线程调用，保持关闭后 ref 请求直接返回的行为。
    bool isReferenceReleased() const noexcept;
    void setReferenced(napi_env env, bool referenced);

  private:
    struct Impl;
    // executor 和 cleanup 句柄也持有 Impl，使外层销毁后的异步收尾仍然安全。
    std::shared_ptr<Impl> impl_;
};

} // namespace SMTC
