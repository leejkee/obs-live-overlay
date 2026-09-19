#include <napi.h>
#include "bridge.hpp"

namespace {

// 初始化当前 Node environment 的模块导出，向内部加载层提供 Bridge 构造函数。
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    // 构造函数保存在当前环境的导出对象中，不使用跨 environment 的全局 JS 引用。
    auto constructor = SMTC::Node::Bridge::define(env);
    exports.Set("createBridge", constructor);
    return exports;
}
// Node-API 模块注册入口，将初始化工作转交给 smtc 命名空间内的实现。
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return initialize(env, exports);
}

} // namespace smtc

NODE_API_MODULE(smtc, Init)
