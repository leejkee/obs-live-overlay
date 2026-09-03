# OBS Live Overlay MVP

由本地控制台管理、通过 OBS Browser Source 展示的实时等候队列。控制台输入观众 ID 入队，Service 自动将队首标记为 `currentId`；当前观众出队后，下一位会自动成为 current。

## 运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

然后打开：

- 控制台：<http://127.0.0.1:3000/control>
- OBS Browser Source：<http://127.0.0.1:3000/overlay/queue>

Overlay 页面背景为透明；建议按直播画布设置 Browser Source 尺寸，再由 OBS 调整位置和裁剪。

## 可用命令

```bash
npm run dev      # 开发模式，文件变化自动重启服务
npm run check    # TypeScript 类型检查
npm test         # 单元和接口测试
npm run build    # 构建到 dist/
npm start        # 运行已构建版本
```

当前 MVP 提供 ID 入队、当前观众出队、“不排了”提示开关，以及一行可编辑的 Overlay 消息。消息显示在“等候队列”下方，清空后自动隐藏；“不排了”开关仅控制提示，不会禁止继续添加 ID。编辑队列项、单独删除、清空队列及调序暂未实现。同一个 ID 不能重复排队。

队列状态仅保存在服务内存中：刷新浏览器或 OBS 不会丢失，停止服务后会清空。
