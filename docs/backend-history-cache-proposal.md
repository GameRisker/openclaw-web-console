# 聊天历史读取加速 — 后端实现方案（可转发）

本文供**网关 / 会话存储 / API 服务**同学实现，目标：在**保证与真实会话一致**的前提下，减少「每次打开历史都全量扫库/全量 RPC」的成本。Web 控制台当前通过 `chat.history`（`limit` / `before`）拉取；下列方案可组合使用。

---

## 1. 背景与问题

- 现网路径：Web UI → `openclaw-web-api` → 多次 `openclaw gateway call`（含 `sessions.list`、`chat.history`）。
- `limit=1` 仍慢的主要原因通常是：**进程/RPC 固定成本** + **网关侧仍按会话全量组装再截断**（若存在）。
- 期望：历史**读路径**在常见场景下主要命中**内存或近线缓存**，写路径仍以网关为权威。

---

## 2. 目标（非功能需求罗列）

| 指标 | 说明 |
|------|------|
| 延迟 | 热路径 `chat.history`（带 `limit`）P95 明显低于「冷读全量 transcript」 |
| 一致 | 用户发消息、流式增量、他端写入后，**可接受短暂最终一致**（建议 ≤1～3s 内可读回），或提供版本号避免脏读 |
| 兼容 | 现有参数 **`sessionKey`（或等价）**、**`limit`**、**`before`（游标）** 语义保持不变；老客户端不传 `before` 时行为与现网一致 |

---

## 3. 推荐方案概览（网关 / 存储侧，优先）

**在网关或会话存储服务内**维护「按会话维度的历史视图缓存」，而不是让每次 `chat.history` 都从冷存储全量拼消息。

### 3.1 缓存什么

- **Key**：`sessionKey`（或内部 `sessionId`，与 `chat.history` 入参一致）。
- **Value（逻辑结构）**（实现可用 Redis / 进程内 LRU / 分段日志，不限定技术）：
  - **热尾（tail）**：最近 `N` 条**已展开**或**未展开**的消息记录（与现 `chat.history` 返回结构一致即可）。
  - 可选：**单调递增 `revision`** 或 **`updatedAt` 毫秒时间戳**，每次该会话有新写入（用户消息、助手增量、工具消息等）时递增/更新。

### 3.2 何时写入 / 失效（必须定义清楚）

在以下事件路径上**同步或异步**更新缓存（至少最终一致）：

1. **`chat.send` / 等价写入口** 成功落库或进入会话队列后，追加或合并对应消息到该会话缓存，并 bump `revision`。
2. **流式输出**（delta / chunk）：按现有协议在 **run 完成或段落落盘** 时合并为一条或多条历史记录并写入缓存（与现网「历史里长什么样」一致即可）。
3. **他端写入**（CLI、其他 UI）：凡会改变会话历史的入口，走同一套「写后更新缓存」逻辑。
4. **会话删除 / 重置**：删除该 key 或清空列表。

**不要求** Web 桥接参与失效；以网关单一真相源为准。

### 3.3 `chat.history` 读路径（建议算法）

入参：`sessionKey`, `limit`, 可选 `before`（当前最早一条消息 **id**）。

1. **优先读缓存**  
   - 若存在该会话缓存且满足：能覆盖「最近 `limit` 条」或能根据 `before` 定位到更早窗口 → **直接从缓存切片返回**。  
   - 返回体建议带 **`hasMore`**（布尔）或 **`nextCursor`**，避免客户端靠「条数是否等于 limit」猜。

2. **缓存未命中 / 不完整 / revision 不一致**  
   - **回源**底层存储（DB / 文件 / 原全量路径）组装结果，**回填缓存**（可只填最近 `M` 条，`M ≥ max(limit 配置, 200)` 由你们定）。

3. **`before` 语义（与现 Web 约定对齐）**  
   - 仅返回 **严格早于** `before` 所指 id 的消息（时间序与现网一致）。  
   - 若 `before` 不在本会话：可返回空列表 + `hasMore: false`，或定义错误码（需文档化）。

4. **`limit` 语义**  
   - 与现网一致：限制**返回条数**（注意与「一条网关消息拆多 part」的计数口径一致，已在 `docs/session-history-pagination.md` 说明）。

### 3.4 性能预期（给实现同学自测）

- 热数据：`chat.history` 在**仅读缓存**时应主要为**内存/Redis 访问**，避免每次全表扫描或大 JSON 反序列化整段会话。
- 冷会话：允许首次较慢，但应**单次回源 + 填充缓存**，后续请求变快。

---

## 4. 可选补充：Web 桥接层（Node，`openclaw-web-api`）

若网关短期无法改，可在 **Node 桥接** 做**二级缓存**（减轻重复 `openclaw gateway call`），注意：

- 仅适合**单实例部署**或配合 **Redis**；多实例无共享缓存会不一致。
- 失效条件：同一进程内收到 **WS `chat` 事件**、或 **HTTP `chat.send` 代理成功** 后，对该 `sessionKey` 标记脏并删除或异步刷新。
- **不能**替代网关正确实现 `limit`/`before`；网关若仍全量返回，Node 缓存也救不了 payload 体积。

实现优先级：**低于网关侧缓存**。

**本仓库已做（`openclaw-web-api/server.mjs`）**：进程内 LRU（默认最多 256 条缓存项，每项对应 `sessionKey + limit + before`）；可选 TTL。环境变量：`HISTORY_CACHE_ENABLED`（默认 `1`，`0`/`false`/`no` 关闭）、`HISTORY_CACHE_MAX_ENTRIES`、`HISTORY_CACHE_TTL_MS`（默认 `0` 表示仅 LRU、不按时间过期）。失效：网关下行 **`chat` WS 事件**（在解析出 `sessionKey` 后，与是否已有浏览器订阅无关）、HTTP **`POST .../message` 成功**、**`POST .../abort` 成功**、**`DELETE` 会话**。

---

## 5. 与现 Web 客户端的契约（保持不变）

- HTTP：`GET /api/sessions/:sessionId/history?limit=&before=`（桥接透传网关）。  
- 响应 JSON：`messages[]`, `hasMore`（桥接可透传网关字段）。  
- Web 客户端行为：首屏小 `limit`、上滑用 `before` 或增大 `limit` 回退（见 `session-history-pagination.md`）。

**网关增强后**，建议响应增加（可选，向后兼容）：

- `hasMore: boolean`
- `revision?: number`（客户端可不解析，仅供调试）

---

## 6. 风险与边界

| 风险 | 缓解 |
|------|------|
| 缓存脏读 | `revision` + 写路径统一更新；读路径可选「revision 落后则回源」 |
| 内存暴涨 | LRU 按会话数或总条数上限；冷会话淘汰只保留元数据 |
| 多端并发写 | 以存储层顺序为准；缓存采用「写后更新」或短 TTL |
| 分页与 part 展开 | 缓存层与 API 层计数口径一致，并在接口文档写明 |

---

## 7. 验收清单（联调）

1. 同一 `sessionKey` 连续两次 `chat.history?limit=1`：第二次应明显快于冷启动（在实现缓存的前提下）。  
2. 发一条新消息后 ≤3s 内再拉历史：必须出现新消息（或返回的 `revision` 变化）。  
3. `before` + `limit`：无重复 id、无「新于 before」的条目。  
4. 会话删除后：再读历史返回空或 404，与现网一致。

---

## 8. 文档索引

- 分页与 `before` 语义：`docs/session-history-pagination.md`  
- Web 桥接默认 `limit`：与 `openclaw-web-client/src/constants/history.ts` 中 `HISTORY_PAGE_SIZE` 对齐（可随产品调整）

---

**结论给后端一句话**：请在 **网关或会话存储** 为 `chat.history` 增加**按会话的热数据缓存 + 写路径失效/更新**，保证 `limit`/`before` 语义不变并优先返回 **`hasMore`**；Web 桥接只做可选二级缓存，不能替代网关优化。
