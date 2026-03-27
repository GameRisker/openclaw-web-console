# Web UI Timeline Architecture

## 背景

当前 OpenClaw Web UI 在消息展示上仍处于过渡态。

现状特征：

- TUI 能稳定看到 tool / verbose / assistant 的过程消息
- Web UI 更容易只看到最终 assistant 回复
- tool call / tool result / verbose 不能稳定、实时、独立显示
- Web UI 仍然依赖 server bridge 的整理、batch、snapshot、history fallback

这说明问题不在模型或 OpenClaw 本体，而在 **Web UI 消息链路没有与 TUI 对齐到同等级别的事件语义**。

---

## 问题定义

目标不是“最终把回复显示出来”这么简单，而是让 Web UI 具备接近 TUI 的过程可见性：

1. tool 调用独立显示
2. tool 结果独立显示
3. verbose / thinking 独立显示
4. assistant 文本增量显示
5. run 状态清晰可追踪
6. 前端不靠猜测合并消息
7. server 提供强语义的事件流

---

## 当前链路问题

当前链路大致是：

1. Gateway 推送原始 chat event
2. `server.mjs` 尝试拆解 content parts
3. server 做 batch / upsert / snapshot / fallback
4. 前端再 merge 成消息列表

这一设计存在几个结构性问题：

### 1. 事件语义不够强

当前主要事件是：

- `chat.event`
- `message.batch`
- `message.upsert`

这些更像“传输事件”或“渲染结果事件”，而不是“消息生命周期事件”。

例如 tool 调用真正需要的是：

- `tool.call.started`
- `tool.call.completed`
- `tool.result.created`

而不是把 tool 信息藏在 message part 里再交给前端猜。

### 2. 当前 message 模型偏渲染结果，不是过程模型

TUI 消费的是“过程”。

Web UI 当前更多消费“整理后的阶段性结果”，这会导致：

- 最终 assistant 文本容易显示
- tool / verbose 过程不稳定显示

### 3. server 仍然偏“合并后再发”

即使有 `message.upsert`，server 当前仍偏向：

- 收到一波 parts
- 合并、整理
- 再推给前端

这与真正的队列式事件流不同。

### 4. 前端缺少 timeline 概念

前端当前维护的是 message list，而不是 timeline state。

因此它没有明确建模：

- 当前 run
- 当前工具调用栈
- 当前 verbose block
- 当前 assistant block
- 当前步骤状态

tool / verbose 很容易沦为 assistant 附属信息，而不是一级节点。

---

## 设计目标

我们要把 Web UI 从“消息数组同步”升级为“时间线事件流”。

目标架构：

- Gateway 原始事件
- Server 规范化事件层
- Server Timeline Store
- Frontend Timeline Reducer
- Render Items

---

## 总体架构

### A. Gateway 原始事件层

server 接收 OpenClaw / Gateway 原始 chat event。

这一层：

- 不直接暴露给前端
- 不要求前端理解 raw payload

---

### B. Server 规范化事件层

在 server 内把原始事件转换成强语义事件。

建议定义这些事件类型：

#### Run 级

- `run.started`
- `run.queued`
- `run.waiting`
- `run.completed`
- `run.failed`
- `run.stopped`

#### User 消息

- `message.user.created`

#### Assistant 文本

- `message.assistant.started`
- `message.assistant.delta`
- `message.assistant.completed`

#### Verbose / Thinking

- `message.verbose.started`
- `message.verbose.delta`
- `message.verbose.completed`

#### Tool Call

- `tool.call.started`
- `tool.call.completed`

#### Tool Result

- `tool.result.created`

#### Snapshot / Recovery

- `timeline.snapshot`

---

### C. Server Timeline Store

server 维护一个真正的 Session Timeline Store，而不是仅仅缓存最后一份 message list。

建议结构：

```ts
type TimelineEvent = {
  eventId: string
  sessionKey: string
  runId?: string
  ts: number
  type:
    | 'run.started'
    | 'run.queued'
    | 'run.waiting'
    | 'run.completed'
    | 'run.failed'
    | 'run.stopped'
    | 'message.user.created'
    | 'message.assistant.started'
    | 'message.assistant.delta'
    | 'message.assistant.completed'
    | 'message.verbose.started'
    | 'message.verbose.delta'
    | 'message.verbose.completed'
    | 'tool.call.started'
    | 'tool.call.completed'
    | 'tool.result.created'
  payload: Record<string, unknown>
}

type SessionTimelineState = {
  events: TimelineEvent[]
  renderItems: RenderItem[]
  runs: Map<string, RunState>
}
```

server 每次收到 Gateway 原始事件后：

1. 转换成 TimelineEvent
2. 更新 RunState
3. 更新 RenderItem 集合
4. 推送增量给前端

---

### D. Frontend Timeline Reducer

前端不再自己猜 message list，而是消费：

- `timeline.snapshot`
- `timeline.event`

前端职责变成：

- 接收 timeline event
- reducer 更新本地 timeline state
- 将 renderItems 渲染为 UI

不再由前端决定：

- 这是不是 toolCall
- 这是不是 verbose
- 这条消息要不要 merge
- 哪个是最终状态

这些统一由 server 语义化。

---

## 协议设计

### 1. `timeline.snapshot`

用于：

- 初次进入 session
- websocket 重连后恢复
- fallback recovery

示例：

```json
{
  "type": "timeline.snapshot",
  "sessionId": "...",
  "sessionKey": "...",
  "events": [...],
  "renderItems": [...]
}
```

### 2. `timeline.event`

用于逐条增量推送：

```json
{
  "type": "timeline.event",
  "sessionId": "...",
  "sessionKey": "...",
  "event": {
    "eventId": "...",
    "type": "tool.call.started",
    "runId": "...",
    "ts": 1774420000000,
    "payload": {
      "toolName": "session_status"
    }
  }
}
```

### 3. 保留兼容层

在过渡期可以保留：

- `message.batch`
- `message.upsert`
- `chat.event`

但这些不再是最终主协议，只是兼容或临时桥接。

---

## Render Item 设计

建议最终渲染对象为：

```ts
type RenderItem = {
  id: string
  sessionKey: string
  runId?: string
  kind: 'user' | 'assistant' | 'verbose' | 'toolCall' | 'toolResult' | 'system'
  status?: 'running' | 'completed' | 'failed' | 'stopped'
  title?: string
  content: string
  ts: number
}
```

### 渲染规则

#### User
- 右侧气泡
- `message.user.created`

#### Assistant
- 左侧气泡
- started -> delta -> completed

#### Verbose
- 单独一类消息卡片
- 可与 assistant 平行显示

#### Tool Call
- 独立消息卡片
- 标题显示 tool name
- 状态显示 running/completed/failed

#### Tool Result
- 独立消息卡片
- 紧跟对应 tool call

#### System
- 更弱化展示

---

## 事件到渲染的映射

### Tool Call

收到 `tool.call.started`：

- 创建 RenderItem(kind=`toolCall`, status=`running`)

收到 `tool.call.completed`：

- 更新同一 RenderItem 状态

### Tool Result

收到 `tool.result.created`：

- 追加 RenderItem(kind=`toolResult`)

### Assistant

收到 `message.assistant.started`：

- 创建 RenderItem(kind=`assistant`, status=`running`)

收到 `message.assistant.delta`：

- 增量追加 content

收到 `message.assistant.completed`：

- 更新状态为 completed

### Verbose

收到 `message.verbose.started` / `delta` / `completed`：

- 与 assistant 类似，但独立 block

---

## 为什么这能解决当前问题

### 问题 1：看不见工具调用日志

因为当前系统没有把 tool 调用建模成一级事件，只是 message part。

Timeline 方案中：

- `tool.call.started`
- `tool.call.completed`
- `tool.result.created`

都是一级事件，因此工具调用天然独立显示。

### 问题 2：消息最后一坨才出来

因为当前仍然偏 batch/merge。

Timeline 方案中：

- `delta` 是逐条事件
- tool/verbose/assistant 都可逐条进入前端

### 问题 3：前端容易重复/覆盖

因为当前前端需要自己 merge。

Timeline 方案中：

- server 决定语义和身份
- 前端只 reducer，不猜测

### 问题 4：history / realtime 互相打架

Timeline 方案中：

- snapshot 用于初始化/恢复
- event 用于增量
- 角色明确，不混淆

---

## 实施步骤

### Phase 1：正式协议

新增 websocket 主协议：

- `timeline.snapshot`
- `timeline.event`

### Phase 2：Server Timeline Store

在 server 内新增：

- event append
- run state machine
- render item materialization
- snapshot generator

### Phase 3：Frontend Timeline Reducer

前端状态从 message list 升级为：

- timeline events
- render items

### Phase 4：兼容与迁移

过渡期保留：

- `chat.event`
- `message.batch`
- `message.upsert`

逐步降级为兼容路径。

### Phase 5：history 降级为恢复接口

`/api/sessions/:id/history`：

- 不再是主消息通路
- 只用于冷启动恢复、断线修复、手动补偿、调试

---

## 可观测性要求

为了让这套架构易诊断，server 侧必须持续提供以下可观测项：

- Gateway 原始 event 收到日志
- timeline event 生成日志
- render item 变更日志
- snapshot 大小与版本
- websocket client subscribe / unsubscribe / disconnect
- sessionKey / runId / eventId 全链路可追踪

推荐日志维度：

- `sessionKey`
- `sessionId`
- `runId`
- `eventId`
- `eventType`
- `renderItemId`
- `clientId`

---

## 验收标准

当实现完成后，应满足：

1. Web UI 与 TUI 在 tool / verbose / assistant 过程可见性上基本一致
2. tool call 在调用开始时可立即看到
3. tool result 可独立显示
4. assistant 正文支持增量更新
5. verbose 支持独立增量更新
6. 刷新页面后能通过 snapshot 快速恢复
7. 断线重连后能恢复 timeline
8. 前端不再依赖 history 作为主通路

---

## 当前建议

后续开发不应继续围绕“修某个 batch/display bug”零碎推进。

建议以后按本文件作为主设计推进：

- 先确定 timeline 协议
- 再做 server timeline store
- 再做前端 reducer 与渲染
- 最后移除旧的临时兼容逻辑

这会比继续 patch 现有 message list 更稳，也更接近生产级实现。
