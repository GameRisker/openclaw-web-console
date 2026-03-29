# 会话聊天历史分页 — 网关 / 后台接口需求

Web 控制台为缩短首屏等待时间，**首屏默认拉取最近 20 条**、每次「加载更早」**10 条**（见 `openclaw-web-client/src/constants/history.ts`）；用户点击再按需请求更早记录。Node 桥接层已将参数透传给 `chat.history`，请网关（或 `openclaw gateway call chat.history` 的实现）尽量对齐以下约定。

> **需求总览（可转发）**：[backend-requirements-web-console.md](./backend-requirements-web-console.md)

## 1. `chat.history` 请求参数（建议）

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionKey` | string | 会话标识（已有） |
| `limit` | number | 本次最多返回多少条**展开后的消息行**（桥接默认建议与 Web 首屏对齐 **20**，上限 **200**） |
| `before` | string（可选） | **游标**：仅返回比该 id **更旧**的消息（见下文语义） |

### `before` 语义（推荐）

- 客户端当前列表里**时间最早**一条消息的 `id`（与历史接口返回的 `messages[].id` 一致）。
- 服务端应返回**严格早于**该消息的若干条（按时间正序或倒序均可，桥接会按时间排序）；**不得**再返回与 `before` 同 id 或更新的消息，否则前端会去重后误判「没有更多」。

若暂不支持 `before`，请明确文档或返回错误；前端会在「无新增 id」时停止继续加载。

## 2. 响应与 `hasMore`（建议）

- 桥接 HTTP 响应中会带 `hasMore: boolean`（启发式：`messages.length >= limit`，若网关能返回精确 `hasMore` 可再增强为透传字段）。
- 理想情况：网关返回 `hasMore` / `nextCursor`，桥接原样转发，避免边界误判。

## 3. `limit` 与「一条网关消息拆多行」

当前桥接会把单条网关消息拆成多条 `messages`（多 part）。`limit` 应对齐为：

- **要么**：限制**顶层记录条数**（网关内部再展开 part）；
- **要么**：限制**展开后的行数**（与现 Web 列表一致）。

请与现 `limit: 200` 行为保持一致，仅缩小默认 `limit` 即可。

## 4. WebSocket 首包

订阅会话时桥接不再下发 200 条全量快照，而与 HTTP 一致使用**默认 `limit` 与首屏一致（当前 Web 为 20）**，减少首包体积；后续增量仍走 `message.upsert` / `message.batch(replace:false)` 等。

## 5. 联调自检

1. `chat.history` 仅 `limit=20`：应得到最近 20 条（展开后）。  
2. 带上 `before=<最早一条 id>`：应得到更早的下一页，且 id 与第一页不重复。  
3. 已到会话开头时：`hasMore` 应为 `false` 或返回条数 `< limit`。

---

如有字段命名差异（如 `cursor`、`offset`、`beforeMessageId`），可在桥接层做别名映射，并在本文档补充最终实现说明。

---

## 9. Node 桥接（`openclaw-web-api`）已实现行为

- **HTTP** `GET /api/sessions/:sessionId/history`  
  - 查询参数：`limit`（默认建议 **20** 与 Web 对齐，上限 `200`）、`before`；**别名**：`beforeMessageId`、`cursor`、`before_id` 均映射为传给网关的 `before`。  
  - 调用 `openclaw gateway call chat.history`，参数：`sessionKey`、`limit`、`before`（有则带）。  
  - 对展开后的 `messages` **按时间戳 + id 升序**排序；若带 `before`，会去掉与游标同 id 的行，若误含 before 行则裁到该 id 之前。  
  - **`hasMore`**：若网关 JSON 含 `hasMore` / `has_more` / `more`（布尔）或 `nextCursor` / `next_cursor`（非空），优先采用；`hasMore === false` 时不再用条数启发式；否则 `hasMore = (messages.length >= limit)`。  
- **WebSocket** 订阅首包：`chat.history` 使用与 HTTP 相同的默认 `limit`（与 Web 首屏对齐），`message.batch(replace:true)` 带 `hasMore`，与上文规则一致。
