# OpenClaw Web Console Realtime Protocol

本文档描述 `openclaw-web-console` 当前 WebSocket realtime 协议的工作方式、消息方向、事件类型和前端消费约定。

> 说明：这是一份**当前实现导向**的协议文档，不是未来稳定 API 的承诺书。它的目标是帮助开发者理解现在前后端是如何通信的。

---

## 1. 总览

前端通过一个 WebSocket 端点接收当前 session 的实时事件：

```text
WS /api/realtime
```

该连接由 `openclaw-web-api` 提供；后端再把来自 OpenClaw Gateway 的 chat 事件转换成前端当前可消费的事件模型。

也就是说：

- 浏览器 **不直接** 连接 OpenClaw Gateway
- 浏览器连接的是本地 bridge：`/api/realtime`
- bridge 再负责和 Gateway 建立 operator 连接并转发/重组事件

---

## 2. 通信方向

### 前端 → 后端
当前前端主要发送两类 websocket 消息：

1. 建立连接后的默认握手（无需客户端主动发 hello）
2. `subscribe`：订阅某个 session 的实时流

### 后端 → 前端
后端会发送：

- `hello`
- `session.update`
- `message.batch`
- `message.upsert`
- `chat.event`
- `timeline.snapshot`
- `timeline.event`
- `session.error`

---

## 3. 连接建立流程

典型时序：

```text
Browser                      Web API bridge                 Gateway
   |                                |                          |
   | ---- WS connect -------------> |                          |
   | <--- {type:"hello"} --------- |                          |
   |                                | ---- connect ----------> |
   |                                | <--- hello-ok ---------- |
   | ---- subscribe(sessionId) ---> |                          |
   |                                | ---- chat.subscribe ---> |
   |                                | <--- subscribe ok ------ |
   | <--- session.update ---------- |                          |
   | <--- message.batch ----------- |                          |
   | <--- timeline.snapshot ------- |                          |
   |                                | <--- chat events ------- |
   | <--- message.upsert ---------- |                          |
   | <--- chat.event -------------- |                          |
   | <--- timeline.event ---------- |                          |
```

---

## 4. 客户端发送消息格式

## 4.1 订阅 session

前端发送：

```json
{
  "type": "subscribe",
  "sessionId": "<session-id>"
}
```

### 语义

- `sessionId` 是前端通过 `GET /api/sessions` 得到的 Web 侧 session id
- 后端会把这个 `sessionId` 解析成内部 `sessionKey`
- 然后调用 Gateway 的 `chat.subscribe`

### 注意

- 当前一个前端连接主要围绕一个活跃 session 使用
- 前端切换 session 时，会重新发送新的 `subscribe`
- 后端会在内部解除旧 session 的订阅引用，并在必要时发起 `chat.unsubscribe`

---

## 5. 服务端发送消息格式

## 5.1 `hello`

连接建立后，后端首先发送：

```json
{
  "type": "hello",
  "clientId": "<uuid>"
}
```

### 字段说明

- `type`: 固定为 `hello`
- `clientId`: 由 bridge 生成的当前 websocket 客户端 id

### 用途

- 告知前端连接已建立
- 可用于调试 / 关联日志

前端当前不会基于 `clientId` 做复杂逻辑，主要用于存在性确认。

---

## 5.2 `session.update`

在订阅某个 session 后，后端可能推送：

```json
{
  "type": "session.update",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "sendStatus": "idle",
  "toolActivityStatus": "idle",
  "messages": []
}
```

### 字段说明

- `sessionId`: Web 侧 session id
- `sessionKey`: OpenClaw 内部 session key
- `sendStatus`: 当前发送状态提示
- `toolActivityStatus`: 当前 runtime/tool 活动状态
- `messages`: 该 session 的一批消息快照（可能为空）

### 语义

这是一个“订阅已建立 / session 当前状态同步”的事件。

在当前实现里，前端收到它后通常会：

- 把 history 状态转成 ready / loading-history
- 如果没有足够消息，则安排一次 history refresh

---

## 5.3 `message.batch`

bridge 会在以下时机发送 `message.batch`：

- 首次订阅某个 session 后，发送当前快照
- 某一轮事件被聚合后，一次性下发多条消息

示例：

```json
{
  "type": "message.batch",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "replace": true,
  "messages": [
    {
      "id": "run1:user:0",
      "timestamp": "2026-03-30T12:00:00.000Z",
      "role": "user",
      "content": "hello",
      "kind": "user",
      "runStatus": "completed"
    },
    {
      "id": "run1:text:1",
      "timestamp": "2026-03-30T12:00:01.000Z",
      "role": "assistant",
      "content": "hi",
      "kind": "text",
      "runStatus": "completed"
    }
  ],
  "hasMore": true
}
```

### 字段说明

- `replace`: 
  - `true` 表示这是当前 session 的完整快照，前端应替换当前消息列表
  - `false` 表示增量 batch，前端应合并而不是整体替换
- `messages`: 消息数组
- `hasMore`: 当前历史快照是否还有更早内容可加载

### 当前前端约定

- `replace: true` 时，会把 `messages` 作为当前可视历史基线
- 然后同步生成对应的 `renderItems`
- `hasMore` 会驱动“点击加载更早记录”按钮

---

## 5.4 `message.upsert`

表示单条消息的增量写入或更新。

示例：

```json
{
  "type": "message.upsert",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "message": {
    "id": "run2:text:0",
    "timestamp": "2026-03-30T12:00:05.000Z",
    "role": "assistant",
    "content": "partial output",
    "kind": "text",
    "runStatus": "running"
  }
}
```

### 语义

- 同一个 `id` 的消息可能会多次 upsert
- 常见场景是 assistant / verbose / tool 相关内容逐步补齐
- `runStatus` 可能随时间从 `running` 变成 `completed` / `failed` / `stopped`

### 当前前端行为

前端收到后不会只改消息本身，还会借此修正运行状态，例如：

- queued → waiting-response
- waiting-response → completed
- waiting-response → error

尤其是当 `message.role` 属于模型侧而不是 user 时，前端会把它当成“当前轮次确实开始/结束了”的重要信号。

---

## 5.5 `chat.event`

这是更偏运行生命周期层面的事件。

示例：

```json
{
  "type": "chat.event",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "state": "delta",
  "runId": "run2",
  "message": null,
  "errorMessage": null,
  "stopReason": null
}
```

也可能是：

```json
{
  "type": "chat.event",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "state": "final",
  "runId": "run2",
  "message": null,
  "errorMessage": null,
  "stopReason": null
}
```

或者：

```json
{
  "type": "chat.event",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "state": "error",
  "runId": "run2",
  "errorMessage": "gateway timeout"
}
```

### 字段说明

- `state`: 当前实现主要使用三种规范化状态
  - `delta`
  - `final`
  - `error`
- `runId`: 当前轮次运行 id
- `message`: 某些情况下会带聚合后的 message，但当前前端更多是依赖其他消息事件
- `errorMessage`: 错误文本
- `stopReason`: 停止原因（如果有）

### bridge 侧规范化

由于上游 Gateway 可能使用很多不同状态名，bridge 会先统一为：

- `final`
- `error`
- `delta`

例如：

- `completed` / `done` / `finished` → `final`
- `failed` / `cancelled` → `error`
- `streaming` / `running` / `partial` → `delta`

### 当前前端行为

前端会基于 `chat.event` 更新：

- `sendStatus`
- `toolActivityStatus`
- `runtimeNote`
- session 的状态（active / error / busy）

并在 `final` / `error` 时安排一次 history refresh，作为兜底同步。

---

## 5.6 `timeline.snapshot`

这是整个时间线的完整快照。

示例：

```json
{
  "type": "timeline.snapshot",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "events": [
    {
      "eventId": "evt:run1:text:0",
      "sessionId": "123",
      "sessionKey": "agent:main:tui-xxxx",
      "runId": "run1",
      "ts": 1774862400000,
      "type": "message.assistant.completed",
      "payload": {
        "messageId": "run1:text:0",
        "kind": "text",
        "role": "assistant",
        "status": "completed",
        "content": "hello"
      }
    }
  ],
  "renderItems": [
    {
      "id": "run1:text:0",
      "sessionId": "123",
      "sessionKey": "agent:main:tui-xxxx",
      "runId": "run1",
      "kind": "assistant",
      "status": "completed",
      "title": "Assistant",
      "content": "hello",
      "timestamp": "2026-03-30T12:00:00.000Z"
    }
  ]
}
```

### 两个核心字段

- `events`: 更底层的时间线事件
- `renderItems`: 更接近 UI 使用的数据行

### 当前前端行为

当前前端会：

- 保存 `events`
- 使用 `renderItems` 作为当前可渲染快照的重要来源之一
- 如果 `messages` 为空，也能从 `renderItems` 反推显示内容

也就是说，`timeline.snapshot` 不只是调试数据，它对当前 UI 是有实际作用的。

---

## 5.7 `timeline.event`

表示对 timeline 的增量更新。

示例：

```json
{
  "type": "timeline.event",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "event": {
    "eventId": "run:run2:run.completed",
    "sessionId": "123",
    "sessionKey": "agent:main:tui-xxxx",
    "runId": "run2",
    "ts": 1774862405000,
    "type": "run.completed",
    "payload": {
      "stopReason": null,
      "errorMessage": null
    }
  },
  "renderItem": {
    "id": "run2:text:0",
    "sessionId": "123",
    "sessionKey": "agent:main:tui-xxxx",
    "runId": "run2",
    "kind": "assistant",
    "status": "completed",
    "title": "Assistant",
    "content": "done",
    "timestamp": "2026-03-30T12:00:05.000Z"
  }
}
```

### 语义

- `event` 是 timeline 层面的事实记录
- `renderItem` 是这次事件对应的 UI 行补丁（如果有）

### 常见 `event.type`

当前 bridge 会生成类似：

- `run.started`
- `run.completed`
- `run.failed`
- `run.stopped`
- `message.assistant.delta`
- `message.assistant.completed`
- `message.verbose.delta`
- `message.verbose.completed`
- `tool.call.started`
- `tool.call.completed`
- `tool.result.created`

### 当前前端行为

前端收到 `timeline.event` 后，会：

- upsert 到 `timelineEvents`
- 如果带 `renderItem`，也同步更新 `renderItems`
- 根据 `event.type` 决定运行状态是否切换

例如：

- `run.started` → session busy / waiting-response
- `run.completed` → session active / completed
- `run.failed` → session error / failed
- `run.stopped` → session active / stopped

---

## 5.8 `session.error`

表示 websocket 层或 session 订阅层出现错误。

示例：

```json
{
  "type": "session.error",
  "message": "invalid_ws_message"
}
```

或者：

```json
{
  "type": "session.error",
  "sessionId": "123",
  "message": "session_not_found"
}
```

### 当前前端行为

- 设置 `composerError`
- 将 `runtimeNote` 标记为 `realtime error`
- 必要时把连接状态降级为 `degraded`

---

## 6. 消息对象结构

当前 realtime / history / timeline 相关消息，前端最终会落到一类接近这样的结构：

```json
{
  "id": "run1:text:0",
  "timestamp": "2026-03-30T12:00:00.000Z",
  "role": "assistant",
  "content": "hello",
  "kind": "text",
  "label": "some label",
  "toolName": "search",
  "runStatus": "completed"
}
```

### 常见字段

- `id`: 消息唯一 id
- `timestamp`: 时间戳
- `role`: 常见有 `user` / `assistant` / `tool` / `toolResult` / `verbose` / `system`
- `content`: 文本内容
- `kind`: 消息种类
- `label`: 显示标签（例如 Tool 名称）
- `toolName`: 工具名
- `runStatus`: 运行状态

### 常见 `runStatus`

- `running`
- `completed`
- `failed`
- `stopped`

---

## 7. renderItem 结构

bridge 为前端额外提供一层更接近 UI 的渲染行：

```json
{
  "id": "run1:text:0",
  "sessionId": "123",
  "sessionKey": "agent:main:tui-xxxx",
  "runId": "run1",
  "kind": "assistant",
  "status": "completed",
  "title": "Assistant",
  "label": null,
  "toolName": null,
  "content": "hello",
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

### 作用

它主要是 bridge 已经替前端做过一轮分类和展示语义归并后的结果，便于 UI 直接用来渲染：

- 是 user 还是 assistant
- 是 verbose 还是 toolCall / toolResult
- 标题该显示什么
- 当前状态是什么

---

## 8. 状态语义约定

前端在 realtime 层主要维护两组状态：

### 8.1 `sendStatus`
常见值：

- `idle`
- `sending`
- `queued`
- `waiting-response`
- `completed`
- `stopped`
- `error`

### 8.2 `toolActivityStatus`
常见值：

- `idle`
- `running`
- `completed`
- `stopped`
- `failed`

### 状态来源

这些状态不是只靠一个事件决定，而是综合：

- `chat.event`
- `message.upsert`
- `timeline.event`
- history refresh 的结果

也就是说，realtime 协议当前是一种 **多信号修正型协议**，不是“只靠 run.completed 就结束”的简单模型。

---

## 9. 为什么需要 `message` / `renderItems` / `timeline` 三层

从协议设计上看，这会显得有点重，但它是由现实约束导致的。

### `messages`
用于保留最接近聊天历史的表示。

### `renderItems`
用于让 UI 直接渲染，不用每次重复做 role/kind/title 分类。

### `timelineEvents`
用于表达运行过程和中间状态，比单纯聊天记录更细。

当前前端会在这些表示之间做互相兜底：

- 有 `messages` 时优先用 `messages`
- 没 `messages` 时可以从 `renderItems` 反推
- timeline 用于决定运行状态和补足流式过程信息

---

## 10. 错误与兼容策略

当前 realtime 协议不是建立在“上游绝对稳定”的假设上，而是建立在“bridge 需要修正上游差异”的假设上。

bridge 当前做了这些兼容：

- Gateway 状态名规范化
- sessionId / sessionKey 双向映射
- 批量事件聚合后再发给前端
- 对 terminal 状态补发 timeline 事件
- 在 `final` / `error` 后安排 history refresh 兜底

这意味着：

- websocket 事件不是唯一真相来源
- history 接口仍然是重要的最终一致性兜底来源

---

## 11. 当前协议的局限

### 11.1 还不是稳定公开协议
字段和事件类型目前是实现导向，不排除后续重构。

### 11.2 前端仍然知道不少桥接细节
前端不仅消费事件，还要理解：

- 哪些事件可信度更高
- 哪些状态可能漏发
- 何时靠 history refresh 修正

### 11.3 有些结构偏“内部表示”
例如 `renderItems` / `timelineEvents` 更像 bridge 为当前前端量身定制的结构，而不是严格中立的公共协议。

---

## 12. 推荐的未来收敛方向

如果后续要把 realtime 协议收敛得更清晰，建议：

1. 明确把事件分成两层：
   - lifecycle events
   - message snapshot/update events
2. 统一 terminal 事件的唯一来源
3. 明确哪些字段是稳定 contract，哪些只是调试/派生字段
4. 给每类事件单独定义 schema
5. 尽量减少前端对 `renderItems` 和 `messages` 双轨并行的依赖

---

## 13. 一句话总结

当前 realtime 协议可以理解为：

> bridge 把 OpenClaw Gateway 的 chat 流重组成“前端可以稳定消费的 session realtime 事件 + timeline + message snapshot/update”。

它追求的不是极简，而是**在上游行为不完全稳定的情况下，尽量让 Web UI 保持一致和可恢复**。
