# 项目协作约定

- 与用户沟通、进度更新和最终答复统一使用中文。
- 面向用户的界面文案默认使用中文，除非需求文档明确指定其他语言。
- 每次测试结束后必须关闭本项目启动的 Node.js 进程，不得让测试或开发服务残留在后台；结束前检查相关监听端口，确认进程已经退出。
- 每次 Release 前必须使用当前版本界面重新截取并更新 README 引用的控制台与 Overlay 截图：`docs/images/control-console.png`、`docs/images/queue-overlay.png`；截图需展示本次发布后的实际界面和主要功能状态。
- Agent Harness 使用 Git、GitHub CLI（`gh`）等工具时，如遇到沙箱权限限制，必须向用户申请提权并获得授权后再继续执行。
