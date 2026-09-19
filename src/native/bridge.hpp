#pragma once
#include <memory>
#include <napi.h>

namespace SMTC::Node {

/**
 * Node-API 对象包装层，将 JS 内部传输接口连接到一个 Runtime。
 * 负责参数转换、TSFN/清理通道的创建及事件循环保活设置，不在此执行媒体业务逻辑。
 * 成员入口在所属 Node 环境线程调用；GC 析构只发起非阻塞关闭，最终释放由 Runtime
 * 协调。
 */
class Bridge : public Napi::ObjectWrap<Bridge> {
  public:
    // 为当前 Node environment 创建 SmtcBridge 构造函数并登记可调用的实例方法。
    static Napi::Function define(Napi::Env env);

    // 校验 JS 回调，创建 Runtime、清理句柄与 TSFN，注册异步退出钩子并启动
    // executor。 TSFN 初始不保活；显式请求和关闭期间的保活由 TypeScript 层通过
    // ref 控制。
    Bridge(const Napi::CallbackInfo &info);

    // wrapper 被 GC 回收时仅通知 Runtime 关闭，不在析构中等待原生线程。
    ~Bridge();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    void request(const Napi::CallbackInfo &info);
    void cancel(const Napi::CallbackInfo &info);
    void close(const Napi::CallbackInfo &);
    void ref(const Napi::CallbackInfo &info);
};

} // namespace SMTC::Node
