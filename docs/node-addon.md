# Windows SMTC 原生扩展

提供 Windows 10 1809+ / Windows 11 x64 的系统媒体会话读取、事件订阅、播放状态和封面读取。需要 Node.js 20 或更高版本。本模块只作为观察者，不提供播放、暂停、切歌或跳转进度的接口；这些操作由 QQ 音乐等播放器本体完成。统一 CLI 在同一端口下提供队列与音乐 Overlay，音乐服务优先展示 QQ 音乐会话，歌词尚未实现。

## 调用

CommonJS：

```js
const { createMonitor } = require('@leejkee/obs-live-overlay/native');
const monitor = createMonitor(event => console.log(event));
async function read() {
  try {
    const state = await monitor.start();
    for (const session of state.sessions) {
      await monitor.refresh(session.sessionId, 'media');
    }
    console.log(monitor.getState());
  } finally {
    await monitor.stop();
  }
}
read().catch(console.error);
```

本项目采用 ESM，TypeScript 可使用：

```ts
import { createRequire } from 'node:module';
import type { NativeMonitor } from '@leejkee/obs-live-overlay/native';
const require = createRequire(import.meta.url);
const { createMonitor }: typeof import('@leejkee/obs-live-overlay/native') =
  require('@leejkee/obs-live-overlay/native');
const monitor: NativeMonitor = createMonitor(event => console.log(event));
try {
  const state = await monitor.start();
  console.log(state.sessions);
} finally {
  await monitor.stop();
}
```

完整类型见 `native/index.d.cts`。开发示例 `node demo.js` 监控 30 秒或直到 Ctrl+C，并显式关闭监控。空闲监控不保持 Node 事件循环存活，长期订阅者应由自己的服务或其他任务保活。

## 接口契约

| 方法 | 行为 |
| --- | --- |
| `start()` | 获取 manager、先注册事件再枚举，返回轻量启动基线；不等待媒体远程读取，域可以为 null |
| `stop()` | 幂等取消请求、撤销订阅、等待本地线程退出；完成后该轮不再调用用户 callback |
| `getState()` | 同步返回独立缓存副本，不调用 Windows |
| `refresh(id, domain)` | 读取 `media`、`playback` 或 `timeline`，提交缓存并将事件入队后完成 |
| `setTimelineTracking(id / null)` | 顺序切换零个或一个时间线订阅，绑定后立即读取 |
| `getThumbnail(id, token)` | 按需打开 WinRT 流，返回 `{thumbnailId, contentType, data: Buffer}` 或 null |

默认订阅所有会话的媒体属性和播放状态。`currentSessionId` 仅代表 Windows current session，必须属于同一份列表；不代表扩展选择了播放器。时间线无需订阅也能主动 refresh。

字符串、Genres、AUMID 和位置均保留系统含义。不识别播放器、不选择活动会话、不解析歌曲 ID，也不做进度插值、时间线纠偏、网络访问、歌词读取或业务缓存。

会话 ID 根据 COM identity 管理，每轮运行重新生成，不暴露地址且不复用。来源相同不代表会话相同；身份变化按移除和新增处理。使用旧 ID 返回 `ERR_SMTC_STALE_SESSION`。

TimeSpan 转为毫秒，DateTime 从 Windows 纪元转换到 Unix UTC 毫秒。缺失的时间锚点保持 null。时间线中的 min/max seek 字段仅保留系统提供的范围信息，不提供跳转能力。

每次成功媒体读取产生新的封面 token，不按标题或歌手推断曲目身份。只缓存当前 token 的成功字节，同 token 并发请求合并，返回 Buffer 彼此独立。旧 token、移除或停止使请求失效；空图返回 null，失败允许重试，最大 4 MiB，实际读取长度必须与声明长度相符。状态事件不携带图片 Buffer。

## 事件与生命周期

事件包含 `runId` 和递增的 `sequence`：`sessions-changed`、`current-session-changed`、三个域的 `*-changed`、`resync` 和 `warning`。分域事件还包含 revision 与数据。事件表达观测状态，不保证捕获播放器的每个瞬间。

启动事件交付晚于 `start()` 返回基线。调用方应用返回的基线后，只处理同 run 且 sequence 更大的事件。同域最多一个在途读取；期间的新通知合并为 dirty，旧结果不提交，随后补读。读取失败保留旧缓存，自动读取失败发出 warning 并尝试重新枚举。

用户事件队列最多 256 项，超限丢弃尚未交付的增量并插入最新 `resync`。原生通知也分别合并和限流，丢失增量时触发完整重读。sequence 允许间隔，不能仅凭间隔判断错误。Promise 完成通道不丢弃，关闭通道独立保留。默认最多 128 个在途显式调用；启动和显式调用默认期限 10 秒。

重复 start 共享启动结果或返回当前缓存；停止期间 start 拒绝，停止后允许新 run。启动中 stop 取消启动请求。逻辑超时会丢弃迟到结果，但不能强杀 Windows 同步 getter。`stop()` 等待实际本地释放，不设置伪造的强制关闭期限。

Promise 方法的参数错误通过 reject 返回；factory 的使用错误同步抛出。错误包含 `code`、`operation`，必要时包含 `sessionId`、十六进制 `nativeCode`。主要错误码：

| code | 含义 |
| --- | --- |
| `ERR_SMTC_MANAGER_UNAVAILABLE` | 无法取得系统 manager，清理后可重试 |
| `ERR_SMTC_NOT_STARTED` / `ERR_SMTC_SHUTTING_DOWN` | 当前生命周期不允许调用 |
| `ERR_SMTC_INVALID_ARGUMENT` | 参数无效 |
| `ERR_SMTC_STALE_SESSION` / `ERR_SMTC_STALE_THUMBNAIL` | 会话或封面 token 已失效 |
| `ERR_SMTC_OPERATION_FAILED` / `ERR_SMTC_TIMEOUT` | 系统调用失败或超过逻辑期限 |
| `ERR_SMTC_BUSY` / `ERR_SMTC_ABORTED` | 请求达到上限或被 stop 取消 |
| `ERR_SMTC_UNSUPPORTED_PLATFORM` | 原生入口不支持当前平台或架构 |
| `ERR_SMTC_BINARY_UNAVAILABLE` | 缺少可加载二进制或二进制加载失败；保留 cause |

用户 callback 的异常按 Node 的未捕获异常机制传播。environment teardown 不调用用户 JS 或完成 Promise。

## 实现边界与资源释放

早期实现参考 `qq-music-lyrics-displayer/node-addon-archive.md`，当前契约已收窄为只读观察者，结合本项目“C++ 仅承担 Node.js 无法实现的能力”的约束，将缓存、revision、sequence、Promise、超时和出站状态事件放在 TypeScript。C++ 仅负责 WinRT 对象与 COM identity、订阅、异步操作、流读取、原生线程与跨线程消息。

原生 executor 在自己的 MTA 中串行管理 manager、registry 和订阅，不修改 Node 主线程的 apartment。异步 WinRT 操作通过 Completed 回调返回 executor，完成前不使用 `.get()` 阻塞等待。跨线程操作用 agile reference，Windows 回调通过 weak lifetime guard 入队。

每个实例和 Node Worker 独立拥有资源。TSFN 仅唤醒环境线程，消息只携带拥有所有权的纯 C++ 数据。关闭先失效任务和撤销订阅，再取消操作、释放 WinRT 对象和 apartment。executor 退出后由 libuv 工作任务 join；异步 cleanup hook 等待线程和 TSFN 均释放后才解除。GC 只触发非阻塞关闭。终止中的 Node environment 可能已经无法创建 JS 错误对象，派发层直接处理 Node-API 状态并回收数据。

## 构建、测试与交付

开发需要 Visual Studio 2022 C++ 工具、包含 C++/WinRT 的 Windows SDK、CMake 3.24+ 和 Ninja（也可使用 VS 自带的 Ninja）。CMake.js 作为项目本地开发依赖安装，不需要全局安装；开发 Node.js 需满足 CMake.js 8 的版本要求（20.17+ 的 Node 20，或 22.9+）。在普通 PowerShell / CMD 中运行下列命令，无需开发者终端或执行 `vcvars64.bat`。使用 Node-API v8、node-addon-api、C++20 和 windowsapp.lib，不依赖 Python 或 vcpkg。

```sh
npm ci
npm run configure:native
npm run build:native
npm run verify
npm run test:native
node scripts/check-native.cjs
npm run build:native:fixture
npm run test:media:native
npm run package:native
npm run test:package:native
```

`configure:native` 只配置 CMake，并生成 `build/native/compile_commands.json` 供 clangd 使用。`build:native` 将 SMTC 实现编译为静态库 `smtc_lib`，再链接生成 `build/native/Release/smtc-addon.node`；开发入口优先加载该文件。`build` 只构建 TypeScript；原生构建必须显式执行。

`CMakeLists.txt` 在 `project()` 前默认选择 `cmake/toolchains/msvc-x64.cmake`，因此 CMake.js 不需要读取 Presets。工具链通过 `vswhere` 定位 VS，通过注册表定位 SDK，并选择完整的 SDK 版本；编译器、资源工具、系统头文件和库搜索路径写入构建规则，独立启动的 Ninja 和 clangd 不依赖终端环境。可使用 `npm run configure:native -- --CDWINSDK_VERSION=10.0.26100.0` 指定 SDK；也支持 `SMTC_VS_ROOT` 和 `WINSDK_ROOT` 路径覆盖。

从旧构建配置迁移、或更换 VS / SDK 后，先执行一次 `npm run configure:native -- -- --fresh`，再执行 `npm run build:native`，重新探测工具链。其他构建目录（例如 `build/native-prebuild`）也需要在对应的 CMake.js configure 命令后追加 `-- --fresh`。这会刷新 CMake 配置缓存，不修改源码。

CMake.js 首次配置时下载并缓存完整 Node SDK；本模块使用 `uv.h` 和 libuv API，因此不启用仅含 Node-API 头文件的模式。`package:native` 在独立的 `build/native-prebuild` 目录使用 Node 20.0.0 SDK 构建，成功后复制到 `prebuilds/win32-x64`。保留 `node-gyp-build` 作为预编译二进制加载器，它不参与编译。普通安装只加载随包二进制，不调用编译工具、不自动下载；`PREBUILDS_ONLY=1` 跳过本地构建。非 Windows 可安装并运行原有队列服务。

CI 和 Release 共用 `.github/workflows/native.yml`：运行 `configure:native:prebuild`，由项目本地 CMake.js 准备 Node SDK 并配置 Ninja / MSVC，再用 `cmake --build` 构建 `smtc_lib` 和 `smtc-addon`，最后整理、上传预编译产物。Release 下载同一份已验证产物，不在 Linux 发布任务中重新编译 Windows addon。

CI 使用一份预编译二进制在 Node 24/26 上验证加载、启停、自然退出、GC 和 Worker terminate；没有媒体服务的 CI 允许明确的 manager 不可用错误，但不能当作真实媒体读取验收。`check-native.cjs` 必须在实际 Windows 用户环境运行，检查媒体、播放状态、时间线和封面，仅输出数量。当前默认测试不改变用户播放器状态。

接口测试使用可控的 TypeScript fake transport 注入过期结果、错误、超时和通知压力；原生生命周期通过真实二进制子进程测试。`test:media:native` 启动独立的静音测试播放器，通过测试播放器自身的输入通道模拟暂停、播放、切歌和进度变化，Monitor 仅观察具有本次随机标题的测试会话，验证媒体、播放、时间线事件、退出后的旧 ID 失效及超过 4 MiB 的实际封面流被拒绝，并清理播放器和临时媒体；不控制用户正在使用的播放器。fixture 只通过 `build:native:fixture` 显式构建，不进入发布包。

验证结果以当前运行的测试为准；Windows 10 和没有安装 VS 的干净机器仍需按实际环境验证。

每轮测试结束必须确认项目启动的 Node.js 进程及相关监听端口已退出。正式发布仍遵循根 `RELEASE.md`，更新当次实际界面截图并完成发布清单。

参考：[Node-API](https://nodejs.org/api/n-api.html)、[Windows.Media.Control](https://learn.microsoft.com/en-us/uwp/api/windows.media.control)、[node-gyp-build](https://github.com/prebuild/node-gyp-build)。
