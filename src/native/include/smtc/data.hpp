#pragma once
#include <map>
#include <napi.h>
#include <string>
#include <variant>
#include <vector>


namespace SMTC {
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
    Data() : value(nullptr) {
    }
    // 保存布尔值。
    Data(bool v) : value(v) {
    }
    // 保存数值，统一映射为 JS number。
    Data(double v) : value(v) {
    }
    // 复制 C 字符串，使消息不依赖调用方的字符缓冲区寿命。
    Data(const char *v) : value(std::string(v)) {
    }
    // 接管按值传入的字符串。
    Data(std::string v) : value(std::move(v)) {
    }
    // 接管对象及其各字段的数据。
    Data(Object v) : value(std::move(v)) {
    }
    // 接管数组及其元素的数据。
    Data(Array v) : value(std::move(v)) {
    }
    // 接管原生字节数组，交付时再复制为独立的 JS Buffer。
    Data(Bytes v) : value(std::move(v)) {
    }

    // 仅在所属 Node 环境线程调用：递归创建 JS 值，失败时抛出 napi_status，
    // 交由派发层处理，避免在正在终止的环境中尝试构造 JS 错误对象。
    napi_value js(napi_env env) const {
        return std::visit(
            [env](const auto &v) -> napi_value {
                using T = std::decay_t<decltype(v)>;
                auto check = [](napi_status status) {
                    if (status != napi_ok) {
                        throw status;
                    }
                };
                napi_value result = nullptr;
                if constexpr (std::is_same_v<T, std::nullptr_t>) {
                    check(napi_get_null(env, &result));
                } else if constexpr (std::is_same_v<T, bool>) {
                    check(napi_get_boolean(env, v, &result));
                } else if constexpr (std::is_same_v<T, double>) {
                    check(napi_create_double(env, v, &result));
                } else if constexpr (std::is_same_v<T, std::string>) {
                    check(napi_create_string_utf8(env, v.data(), v.size(),
                                                  &result));
                } else if constexpr (std::is_same_v<T, Object>) {
                    check(napi_create_object(env, &result));
                    for (const auto &[k, item] : v) {
                        check(napi_set_named_property(env, result, k.c_str(),
                                                      item.js(env)));
                    }
                } else if constexpr (std::is_same_v<T, Array>) {
                    check(
                        napi_create_array_with_length(env, v.size(), &result));
                    for (size_t i = 0; i < v.size(); ++i) {
                        check(napi_set_element(env, result,
                                               static_cast<uint32_t>(i),
                                               v[i].js(env)));
                    }
                } else {
                    check(napi_create_buffer_copy(env, v.size(), v.data(),
                                                  nullptr, &result));
                }
                return result;
            },
            value);
    }
};
} // namespace SMTC