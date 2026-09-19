#include "bridge.hpp"
#include <smtc/runtime.hpp>

namespace SMTC::Node {

struct Bridge::Impl {
    explicit Impl(const Napi::CallbackInfo &info) {
        try {
            runtime = std::make_shared<Runtime>(info.Env(), info[0]);
        } catch (const Napi::Error &) {
            throw;
        } catch (...) {
            throw Napi::Error::New(info.Env(), "无法初始化 SMTC 原生运行时");
        }
    }
    std::shared_ptr<Runtime> runtime;
};

// 为当前 Node environment 创建 SmtcBridge 构造函数并登记可调用的实例方法。
Napi::Function Bridge::define(Napi::Env env) {
    return DefineClass(env, "SmtcBridge",
                       {InstanceMethod("request", &Bridge::request),
                        InstanceMethod("cancel", &Bridge::cancel),
                        InstanceMethod("close", &Bridge::close),
                        InstanceMethod("ref", &Bridge::ref)});
}

Bridge::Bridge(const Napi::CallbackInfo &info)
    : Napi::ObjectWrap<Bridge>(info) {
    if (info.Length() != 1 || !info[0].IsFunction()) {
        throw Napi::TypeError::New(info.Env(), "callback 必须是函数");
    }
    impl_ = std::make_unique<Impl>(info);
}
Bridge::~Bridge() {
    if (impl_->runtime) {
        impl_->runtime->close();
    }
}

// 校验内部请求的四个参数并转换为 Request；入队失败时向 JS 抛出错误。
void Bridge::request(const Napi::CallbackInfo &info) {
    if (info.Length() != 4 || !info[0].IsNumber() || !info[1].IsString() ||
        !info[2].IsString() || !info[3].IsString()) {
        throw Napi::TypeError::New(info.Env(), "无效的 SMTC 请求");
    }
    try {
        impl_->runtime->enqueue({info[0].As<Napi::Number>().DoubleValue(),
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
void Bridge::cancel(const Napi::CallbackInfo &info) {
    if (info.Length() != 1 || !info[0].IsNumber()) {
        throw Napi::TypeError::New(info.Env(), "无效的请求 ID");
    }
    try {
        impl_->runtime->cancel(info[0].As<Napi::Number>().DoubleValue());
    } catch (...) {
        throw Napi::Error::New(info.Env(), "无法取消 SMTC 请求");
    }
}
// JS 显式关闭入口，只发起关闭；完成情况由后续 closed 消息通知上层。
void Bridge::close(const Napi::CallbackInfo &) {
    impl_->runtime->close();
}
// 设置 TSFN 是否保持 Node 事件循环存活；此操作不改变 TSFN 的使用权计数。
void Bridge::ref(const Napi::CallbackInfo &info) {
    if (impl_->runtime->isReferenceReleased()) {
        return;
    }
    if (info.Length() != 1 || !info[0].IsBoolean()) {
        throw Napi::TypeError::New(info.Env(), "ref 必须是布尔值");
    }
    impl_->runtime->setReferenced(info.Env(),
                                  info[0].As<Napi::Boolean>().Value());
}
} // namespace SMTC::Node
