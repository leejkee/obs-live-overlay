# OBS Live Overlay

一个用于 OBS Browser Source 的实时等候队列。通过本地控制台管理队列、提示消息和文字样式，画面会实时同步到 OBS。

## 界面预览

### 控制台

![OBS Live Overlay 控制台](docs/images/control-console.png)

### OBS Overlay

![OBS 等候队列 Overlay](docs/images/queue-overlay.png)

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install --global @leejkee/obs-live-overlay
```

## 使用

在终端启动：

```bash
obs-live-overlay
```

启动后打开：

- 控制台：<http://127.0.0.1:3000/control>
- OBS Overlay：<http://127.0.0.1:3000/overlay/queue>

将 Overlay 地址添加为 OBS 的 Browser Source。页面背景透明，可以直接叠加到直播画面。控制台支持管理队列、指定当前用户、修改显示文案和字体样式；按 `Ctrl+C` 停止服务。

### 常用选项

```text
obs-live-overlay --port 3000
obs-live-overlay --host 127.0.0.1
obs-live-overlay --data-file D:\overlay-data\profiles.json
obs-live-overlay --help
obs-live-overlay --version
```

Windows 默认数据文件位于 `%LOCALAPPDATA%\obs-live-overlay\profiles.json`。

### Windows 静默启动

Windows 11 可以将服务注册为登录后自动运行的计划任务。启用时会请求一次管理员授权：

```bash
obs-live-overlay startup-enable
```

查看状态：

```bash
obs-live-overlay startup-status
```

停止服务并取消自动启动：

```bash
obs-live-overlay startup-disable
```

静默启动固定使用 `127.0.0.1:3000` 和默认数据文件。全局卸载或更换 Node.js 安装位置前，请先运行 `startup-disable`；更换后可重新启用。

## 卸载

```bash
obs-live-overlay startup-disable
npm uninstall --global @leejkee/obs-live-overlay
```

卸载不会删除队列数据。如需完全清理，请手动删除默认数据文件。

## 开发文档

项目架构与实现说明见 [设计文档](docs/design.md)。
