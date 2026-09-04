# OBS Live Overlay MVP

[![CI](https://github.com/leejkee/obs-live-overlay/actions/workflows/ci.yml/badge.svg)](https://github.com/leejkee/obs-live-overlay/actions/workflows/ci.yml)

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

## 本地安装命令行

无需发布到 npm，也可以将项目打包并安装为全局命令：

```bash
npm install
npm run pack:local
npm install --global ./obs-live-overlay-0.1.0.tgz
```

安装后可在任意终端直接运行：

```bash
obs-live-overlay
```

服务以前台方式运行，按 `Ctrl+C` 停止。常用选项：

```text
obs-live-overlay --port 3000
obs-live-overlay --host 127.0.0.1
obs-live-overlay --data-file D:\overlay-data\profiles.json
obs-live-overlay --help
```

Windows 默认数据文件位于 `%LOCALAPPDATA%\obs-live-overlay\profiles.json`。卸载本地命令可运行 `npm uninstall --global obs-live-overlay`。

Overlay 页面背景为透明；建议按直播画布设置 Browser Source 尺寸，再由 OBS 调整位置和裁剪。

## 可用命令

```bash
npm run dev      # 开发模式，文件变化自动重启服务
npm run check    # TypeScript 类型检查
npm test         # 单元和接口测试
npm run build    # 构建到 dist/
npm run verify   # 依次执行类型检查、测试和构建
npm start        # 运行已构建版本
npm run pack:local # 生成本地安装包
```

当前 MVP 提供 ID 入队、当前观众出队、“不排了”提示开关，以及一行可编辑的 Overlay 消息。控制台按队列内容、标题、消息和“不排了”提示拆分为四块独立控制区域，并将高频使用的队列操作放在首位。选中任一内容块后，可在共用字体面板中设置字体、字号、加粗、斜体、文字对齐、文字颜色、描边颜色和描边宽度；修改会实时同步到 Overlay，并随 Profile 独立保存。消息显示在“等候队列”下方，清空后自动隐藏；“不排了”开关仅控制提示，不会禁止继续添加 ID。编辑队列项、单独删除、清空队列及调序暂未实现。同一个 ID 不能重复排队。

## Profile 与持久化

Queue 控制页支持新建、切换、重命名和删除 Profile。`default` Profile 始终保留且不能删除；每个 Profile 独立保存队列、消息和“不排了”状态。切换当前 Profile 后，现有 `/overlay/queue` 页面会自动加载对应状态，OBS 地址无需改变。

数据以 JSON 格式原子写入 `data/profiles.json`。该运行时数据文件不会提交到 Git；停止并重新启动 Service 后会自动恢复。旧版 Profile 数据会自动补充默认字体及文字渲染设置，无需手工迁移。

如需自定义数据文件位置，可在启动前设置 `OBS_OVERLAY_DATA_FILE` 环境变量。

刷新浏览器、OBS 或重启 Service 后，Profile 与队列状态都会从 JSON 文件恢复。

## CI 与发布

推送到 `main` 或提交 Pull Request 时，GitHub Actions 会在 Node.js 20、22、24、26 上执行类型检查、测试和构建，并额外在 Windows 环境验证。依赖安装优先复用 npm 缓存，并跳过与构建无关的审计和赞助请求。发布产物不会上传 npm Registry，而是附加到 GitHub Release，保持当前本地工具的分发方式。

发布步骤：

1. 使用 `npm version patch --no-git-tag-version`（或 `minor`、`major`）更新 `package.json` 和 `package-lock.json`，通过 Pull Request 合并到 `main`。
2. 在最新的 `main` 提交上创建与包版本一致的带注释标签，例如 `git tag -a v0.1.1 -m "v0.1.1"`。
3. 使用 `git push origin v0.1.1` 推送标签。

标签触发的 Release 流程会再次执行完整校验，生成 `obs-live-overlay-<版本>.tgz` 及其 `.sha256` 文件，然后创建 GitHub Release。标签不是严格的 `vX.Y.Z` 格式，或与 `package.json` 中版本不一致时，发布会直接失败。
