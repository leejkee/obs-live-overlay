# OBS Live Overlay

## 1. 项目背景

OBS 自带的文本、图片、窗口捕获等 Source 可以完成基础信息展示，但当显示内容需要频繁修改、包含多个动态元素或具有业务状态时，直接在 OBS 中维护会比较繁琐。

典型需求包括：

* 排队观众列表
* 当前观众 / 当前玩家
* 当前歌曲信息
* 状态提示
* 动态排行榜
* 需要频繁增删、更新的数据列表

本项目提供一个由外部 WebUI 控制、通过 OBS Browser Source 展示的通用 Overlay 系统。

OBS 仅负责最终画面合成和 Overlay 在直播画面中的位置、尺寸等设置，不承担具体业务状态管理。

---

# 2. 设计目标

系统由三个核心部分组成：

1. **Overlay**

   * 被 OBS Browser Source 加载。
   * 只负责展示 Service 提供的数据。
   * 根据数据变化实时更新页面。
   * 不直接管理业务状态。

2. **Control WebUI**

   * 在普通浏览器中打开。
   * 用于查看和修改 Overlay 对应的数据。
   * 提供添加、删除、排序、清空等操作。
   * 一个控制台可以管理多个 Overlay。

3. **Service**

   * 本地运行的后台服务。
   * 作为系统唯一的数据源（Source of Truth）。
   * 保存所有 Overlay 当前状态。
   * 处理 Control WebUI 发出的操作。
   * 将最新状态实时同步给 Overlay。
   * 一个 Service 可以同时管理多个 Overlay。

整体关系：

```text
                   Browser
               Control WebUI
                     │
                     │ HTTP / WebSocket
                     ▼
              ┌──────────────┐
              │   Service    │
              │              │
              │ Overlay A    │
              │ Overlay B    │
              │ Overlay C    │
              └──────┬───────┘
                     │
                     │ WebSocket
            ┌────────┼────────┐
            ▼        ▼        ▼
       Overlay A Overlay B Overlay C
            │        │        │
            └────────┼────────┘
                     ▼
                    OBS
```

---

# 3. Overlay

Overlay 本质上是一个 HTML 页面，由 OBS Browser Source 加载。

例如：

```text
http://127.0.0.1:3000/overlay/queue
```

Overlay 页面负责：

* 从 Service 获取初始化状态。
* 与 Service 建立实时通信。
* 数据变化时更新 DOM。
* 根据数据变化执行必要的进入、退出、移动等动画。
* 保持透明背景。
* 不提供用户操作控件。
* 不直接修改 Service 状态。

例如 Queue Overlay 收到：

```json
{
    "items": [
        {
            "id": "user_a",
            "name": "User A"
        },
        {
            "id": "user_b",
            "name": "User B"
        }
    ]
}
```

则负责渲染：

```text
1. User A
2. User B
```

Overlay 不需要知道这些用户为什么进入队列，只负责将当前状态正确展示出来。

---

# 4. Control WebUI

Control WebUI 在普通浏览器中运行，例如：

```text
http://127.0.0.1:3000/control
```

控制台负责操作 Service 中保存的数据。

例如 Queue 控制界面：

```text
Queue

1. User A                 [删除]
2. User B                 [删除]
3. User C                 [删除]

[ Viewer ID / Name             ]
[ 添加 ]

[ 下一位 ] [ 清空 ]
```

第一版至少支持：

* 查看当前 Overlay 状态。
* 添加数据。
* 删除指定数据。
* 修改数据。
* 清空数据。
* 队列出队。
* 调整队列顺序。
* 在多个 Overlay 之间切换。

Control WebUI 本身不作为状态存储位置。

刷新控制页面后，应重新从 Service 获取当前完整状态。

---

# 5. Service

Service 是整个系统的核心。

第一版建议使用：

```text
Node.js + TypeScript
```

Service 负责：

## 5.1 HTTP Server

提供静态页面：

```text
/control
/overlay/:overlayId
```

以及必要的 API。

例如：

```text
GET    /api/overlays
GET    /api/overlays/:id/state

POST   /api/overlays/:id/items
PATCH  /api/overlays/:id/items/:itemId
DELETE /api/overlays/:id/items/:itemId
```

具体 API 可以在实现阶段调整。

---

## 5.2 状态管理

Service 是唯一可信状态源。

例如：

```ts
interface OverlayState {
    id: string;
    type: string;
    data: unknown;
}
```

Queue Overlay 可以具有：

```ts
interface QueueState {
    items: QueueItem[];
}

interface QueueItem {
    id: string;
    name: string;
}
```

所有：

```text
enqueue
dequeue
remove
move
clear
update
```

操作最终都必须修改 Service 中保存的状态。

Control 和 Overlay 都只是这个状态的不同 View。

---

# 6. 实时通信

Control WebUI 和 Overlay 需要能够实时获取 Service 中的状态变化。

第一版使用 WebSocket。

连接关系：

```text
Control ──────┐
              │
              ▼
           Service
              │
              ▼
Overlay ──────┘
```

例如 Control 发送：

```json
{
    "type": "queue.enqueue",
    "overlayId": "queue",
    "payload": {
        "id": "114514",
        "name": "Viewer"
    }
}
```

Service 修改状态后，不直接要求 Overlay 执行：

```text
添加某一个 DOM
```

而是向客户端同步新的业务状态：

```json
{
    "type": "state.updated",
    "overlayId": "queue",
    "state": {
        "items": [
            {
                "id": "114514",
                "name": "Viewer"
            }
        ]
    }
}
```

Overlay 根据新的 state 自行更新画面。

这样可以避免 Service 与具体 HTML DOM 结构耦合。

---

# 7. 多 Overlay 管理

一个 Service 可以管理多个 Overlay。

例如：

```text
queue
now-playing
notice
ranking
current-player
```

每个 Overlay 有唯一 ID：

```text
/overlay/queue
/overlay/now-playing
/overlay/ranking
```

Service 内部维护：

```ts
overlays = {
    queue: {...},
    nowPlaying: {...},
    ranking: {...}
}
```

一个 Overlay 只能连接一个明确的 Service。

Control WebUI 可以查看并操作该 Service 下的所有 Overlay。

---

# 8. OBS 职责边界

OBS 负责：

* 加载 Browser Source。
* Overlay 在整个直播画布中的位置。
* Source 的宽度和高度。
* Crop。
* Transform。
* Source 显示 / 隐藏。
* 与其他 Source 进行最终画面合成。

业务状态不应存储在 OBS 中。

例如：

```text
谁正在排队
现在播放什么歌曲
当前用户是谁
排行榜内容
```

都应该由 Service 管理。

---

# 9. 样式管理

Overlay 应提供能够直接使用的默认样式。

OBS Browser Source 的 Custom CSS 可以用于进行最终样式覆盖，例如：

```css
.queue {
    font-size: 32px;
}
```

职责建议划分为：

```text
Overlay：
组件内部布局
动画
默认字体
默认间距
元素结构

OBS：
整个 Overlay 的位置
整体尺寸
Crop
Transform
必要的 CSS Override
```

不建议要求所有内部样式都必须写入 OBS Custom CSS，否则复杂 Overlay 的样式会难以维护。

---

# 10. Overlay 动画

动态展示是采用 Browser Source 的主要原因之一。

Overlay 可以使用：

* CSS Transition
* CSS Animation
* Web Animations API

完成：

* 入队淡入
* 出队淡出
* 队列位置移动
* 歌曲名滚动
* 状态切换
* 数字变化动画

Service 只提供状态，不处理动画。

例如：

```text
Service：

[A, B, C]
    ↓
[B, C]

Overlay：

A → fade out
B → move up
C → move up
```

动画属于 View 层行为。

---

# 11. 生命周期

当 Overlay 首次加载时：

```text
OBS 打开 Overlay
        ↓
Overlay 加载 HTML / JS / CSS
        ↓
连接 Service
        ↓
请求当前完整 State
        ↓
Render
        ↓
建立 WebSocket
        ↓
等待后续 State Update
```

OBS Browser Source 被刷新后，不应该导致数据丢失。

只要 Service 仍然运行：

```text
Overlay Refresh
        ↓
重新连接 Service
        ↓
获取当前 State
        ↓
恢复显示
```

---

# 12. Service 重启与数据持久化

第一版可以仅将状态保存在内存中：

```ts
const state = {};
```

此时：

```text
Overlay 刷新
→ 数据保留

Control 刷新
→ 数据保留

OBS 重启
→ Service 仍然运行则数据保留

Service 重启
→ 数据清空
```

后续如果有需求，可以增加：

```text
state.json
```

或者 SQLite 持久化。

第一版暂不要求数据库。

---

# 13. 异常处理

Overlay 应能够处理：

### Service 暂时离线

Overlay 不应不断刷新整个页面。

应显示已有画面或进入 disconnected 状态，并尝试重新建立连接。

### WebSocket 断开

自动重连。

### OBS Browser Source 刷新

重新获取完整 State。

### Control WebUI 刷新

重新获取完整 State。

### 多个 Control 页面同时打开

所有 Control 页面都应从 Service 获取统一状态。

任意一个 Control 修改状态后，其他 Control 页面也应收到更新。

---

# 14. 第一阶段 MVP

第一阶段只实现一个 Queue Overlay，用它验证完整架构。

功能：

### Service

* Node.js + TypeScript。
* 本地 HTTP Server。
* WebSocket。
* 内存 Queue State。

### Control

支持：

```text
添加 Viewer
删除 Viewer
下一位
清空
调整顺序
```

### Overlay

实时显示：

```text
Waiting Queue

1. Viewer A
2. Viewer B
3. Viewer C
```

支持：

* 入队动画。
* 出队动画。
* 队列移动动画。
* OBS Browser Source 透明背景。

---

# 15. MVP 验收标准

启动 Service：

```bash
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:3000/control
```

OBS Browser Source 打开：

```text
http://127.0.0.1:3000/overlay/queue
```

完成以下操作：

```text
Control 输入 User A
        ↓
点击添加
        ↓
OBS 出现 User A

Control 输入 User B
        ↓
点击添加
        ↓
OBS 出现 User A / User B

点击下一位
        ↓
User A 在 OBS 中执行退出动画
        ↓
User B 移动到第一位
```

同时满足：

* OBS 无需手动修改 Text Source。
* Overlay 刷新后状态可以恢复。
* Control 刷新后状态可以恢复。
* Overlay 和 Control 数据始终与 Service 保持一致。

达到以上要求即证明整体技术方案可行。

---

# 16. 后续可扩展能力

MVP 完成后再考虑：

* 多种 Overlay Template。
* Overlay 配置页面。
* 主题系统。
* 字体和样式编辑。
* 数据持久化。
* SQLite。
* Bilibili 直播间事件接入。
* 弹幕指令自动排队。
* 用户头像。
* 当前歌曲 / 播放进度。
* 排行榜。
* OBS WebSocket 集成。
* 自动控制 OBS Source 显示隐藏。
* 打包为独立桌面程序。
