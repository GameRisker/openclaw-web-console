# Gateway / Bridge 实时能力需求（给服务端联调）

面向：**Web 控制台**（`openclaw-web-client`）在「发送后一直等待 / Stop 不消失 / 顶部运行态不对」等问题上的**服务端契约**。若问题出在网关只回 HTTP 成功、但 WebSocket 缺少**本轮结束信号**，前端无法可靠收回「正在运行」状态。

更完整的架构背景见：[webui-timeline-architecture.md](./webui-timeline-architecture.md)。

---

## 1. 业务目标

用户发一条消息后，前端需要**确定性地**知道：

- 本轮模型运行**已开始**（可选，用于展示「等待/运行中」）
- 本轮运行**已结束**（成功 / 失败 / 用户停止）

**至少满足其一**：在「本轮结束」时，网关或 bridge **必须**通过 WebSocket 下发可识别的终态信号（见下文 2、3），且与 `GET chat.history`（或等价历史接口）中的消息状态**一致**。

---

## 2. `chat.event`（推荐：与模型流式输出对齐）

前端类型：`RealtimeChatEvent`（`openclaw-web-client/src/types/api.ts`）。

| `state` | 含义 | 服务端建议行为 |
|--------|------|------------------|
| `delta` | 流式增量中 | 可多次发送；前端可将 `queued` 转为「等待响应」 |
| `final` | 本轮正常结束 | **必须**在助手回复完整落库或完整输出后发送至少 **1 次** |
| `error` | 本轮异常结束 | **必须**发送；可带 `errorMessage` |

**硬性要求：**

- 每个「用户发送 → 助手一轮回复」周期，在成功路径上 **不能只有** `delta` 而没有 **`final`**（否则前端只能猜结束时间）。
- `error` 路径同样视为终态，需与历史里该轮状态一致。

---

## 3. `timeline.event`（与 TUI 对齐时优先）

前端类型：`RealtimeTimelineEvent`，其中 `event.type` 含 `run.*` 与 `message.assistant.*` 等。

前端对**结束本轮 UI 状态**会识别：

- `run.completed`
- `run.failed`
- `run.stopped`
- **`message.assistant.completed`**（与 `run.completed` 等价用于「本轮助手侧结束」）

**硬性要求（二选一或同时满足）：**

1. 在每轮助手输出正常结束时，发送 **`run.completed`**；**或**
2. 发送 **`message.assistant.completed`**（当前部分网关只发后者，不发 `run.completed`，会导致旧版前端永远停在 Stop）。

失败 / 停止路径需发送 **`run.failed`** / **`run.stopped`**（或与之一致的语义）。

可选：`run.started` 与 `message.assistant.started` 用于开始态；若不发，前端仍可依赖 `chat.event` 或 `message.upsert` 进入等待态，但**结束态不可缺失**。

---

## 4. `message.upsert` 与 `runStatus`

单条消息更新：`message`，类型为 `ApiMessage`，含可选字段 `runStatus?: 'running' | 'completed' | 'stopped' | 'failed'`。

**建议：**

- 助手侧（及需要展示进度的条目）在流式过程中可标 `running`。
- **结束时**必须有一条（或多条，但最后一条助手气泡）带 **`completed`** / **`failed`** / **`stopped`**，且与 `chat.event` / `timeline` 终态**不矛盾**。

前端会用该字段在仍处 `waiting-response` / `queued` / `sending` 时强制收回运行态（兜底）。

---

## 5. 历史接口与 WebSocket 一致性

`SessionHistoryResponse.messages`（或 bridge 映射后的等价结构）应满足：

- 用户可见角色、内容与 WebSocket 推送**最终一致**（允许短暂延迟，但应在数百 ms～数秒内通过 `message.batch` / `message.upsert` / 刷新历史对齐）。
- 若 WS 长期无 `final` / `run.completed` / `message.assistant.completed`，仅靠轮询历史时，历史里的 `runStatus` 仍应能反映「已结束」，以便前端做兜底（前端已实现部分逻辑，但**首选仍是 WS 明确终态**，避免依赖轮询间隔）。

---

## 6. `session.update`（可选增强）

若推送 `session.update` 且带 `messages` 数组：

- 建议 `sendStatus` / `toolActivityStatus` 与网关真实状态一致（前端类型里目前较窄，以实际 bridge 扩展为准）。
- 空消息 + 无其他终态事件时，前端可能仍会拉历史；**不能**用「从不发终态」依赖前端猜。

---

## 7. 联调自检清单（服务端自测）

1. 用户发一句简单话 → 助手回复一段文字 → 抓 WS：是否出现 **`chat.event` + `state: final`** 或 **`timeline.event` + `run.completed` / `message.assistant.completed`**？
2. 故意触发模型/网关错误 → 是否出现 **`chat.event` + `state: error`** 或 **`run.failed`**？
3. 用户点停止 → 是否出现 **`run.stopped`**（或等价的 upsert `stopped` + 终态 chat/timeline）？
4. 回复结束后立即 `GET` 历史：助手消息 `runStatus` 是否为 **`completed`**（而非长期 `running`）？

---

## 8. 前端参考

- 事件类型定义：`openclaw-web-client/src/types/api.ts`（`RealtimeEvent` 联合类型）。
- 状态机消费：`openclaw-web-client/src/state/useAppState.ts`（`connectRealtime` 的 `onEvent`）。

---

文档版本：与 Web 客户端当前实现对齐；若网关扩展新事件类型，请同步更新类型定义与本文档。
