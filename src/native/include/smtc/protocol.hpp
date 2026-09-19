#pragma once
#include <string>
// 原生请求的预期失败，携带可供 TypeScript 层识别的稳定错误码。

namespace SMTC {

struct Failure {
    std::string code;
};
// Node 线程提交给 executor 的纯数据请求；id 用于关联完成消息，
// operation 指定操作，session 指定会话，argument/value 携带该操作的参数。
struct Request {
    double id;
    std::string operation, session, argument;
};
}