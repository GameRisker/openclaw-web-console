# Web 控制台 — 后台 / 网关需求整理（可转发）

本文汇总 **openclaw-web-client** 联调与现网问题中，需要 **网关、会话存储、鉴权、桥接（openclaw-web-api）** 侧配合的能力。细节设计见文末「关联文档」。

---

## 1. 会话历史 `chat.history`（HTTP / WS 首包）

### 1.1 分页参数（P0）

| 能力 | 说明 |
|------|------|
| **`limit`** | 单次返回的**展开后消息行数**上限；Web 端首屏约 **20**、翻页每步 **10**，最大会尝试到 **200**（见客户端 `src/constants/history.ts`）。 |
| **`before`（游标）** | 客户端传当前列表里**时间最早**一条的 `messages[].id`。服务端应只返回**严格早于**该 id 的消息，不得再返回同 id 或更新片段，否则前端会去重后误判「没有更多」。 |
| **不支持时的表现** | 若网关忽略 `before` 仍只回「最近 N 条」，则：① 无法真正按页向前翻；② 当「最近 N」存在**硬顶**（例如固定最多 60 条）时，前端拉满后只能停止，**无法看到更早记录**。 |

### 1.2 返回体（P0）

| 字段 | 说明 |
|------|------|
| **`hasMore`** | 建议由网关给出**精确布尔值**；不要长期依赖「`length >= limit`」启发式（limit 大于实际存量时会误判）。 |
| **条数与 `limit`** | `limit` 增大时，若已达会话可返回上限，返回条数应稳定不再增长；避免「limit=200 仍只给 60」却 `hasMore: true` 长期为真（除非确实还有更早数据且应用 `before` 可取）。 |

### 1.3 消息模型（P1，影响排序与去重）

| 字段 | 说明 |
|------|------|
| **`id`** | HTTP 历史与 WebSocket / timeline 推送应对**同一条气泡**使用**稳定且一致**的 id；若各通道 id 体系不一致，前端只能靠内容指纹去重，成本高且易错。 |
| **`timestamp`** | 建议每条具备**可解析、单调合理**的时间（ISO 或毫秒）；大量为 `0`/空会导致客户端按 id 字符串排序，**游标 `before` 对应的「最早一条」可能一直不变**，进一步加剧分页失效。 |

### 1.4 WebSocket 订阅首包

- 与 HTTP **同一套** `chat.history` 语义：`limit` / `before` / `hasMore` 对齐。
- 默认 `limit` 建议与 Web 首屏一致（当前 **20**），避免首包过大。

**详细契约**： [session-history-pagination.md](./session-history-pagination.md)  
**性能与缓存方向**： [backend-history-cache-proposal.md](./backend-history-cache-proposal.md)

---

## 2. 实时通道 WebSocket（鉴权与事件）

### 2.1 鉴权 / Scope（P0，已观测问题）

- 联调中出现：`session.error`，`message: 'missing scope: operator.admin'`。  
- **需求**：明确 Web 控制台连接 **`/api/realtime`（或等价路径）** 所需的 **token / scope**；要么控制台使用具备该 scope 的凭证，要么网关为「只读会话 + 发消息」类控制台角色下放行兼容 scope（产品与安全由你们定）。

### 2.2 流式与终态（P0）

- 每轮用户发送 → 助手回复结束，必须有可识别的**终态**（`chat.event` 的 `final` / `error`，或 timeline 的 `run.completed` / `message.assistant.completed` 等），否则前端运行中/Stop 等状态无法可靠收回。

**详细契约**： [backend-gateway-realtime-requirements.md](./backend-gateway-realtime-requirements.md)

---

## 3. 联调自检清单（后台可做）

**历史**

1. `GET history?limit=20`：最近 20 条（展开后行数口径与文档一致）。  
2. `GET history?limit=10&before=<当前列表最早 id>`：仅更早一页，且与上一页 **id 不重复**。  
3. 会话仅 60 条时：任意 `limit≥60` 返回条数 ≤60，且 **`hasMore` 为 false**（若实现精确 `hasMore`）。  
4. 同一条消息：HTTP 与 WS 最终 **id、timestamp、runStatus** 一致（允许短暂延迟）。

**实时**

5. 连接 WS 使用控制台真实凭证：无 `missing scope: operator.admin`（或文档写明如何申请）。  
6. 一轮对话结束：抓包可见 **终态事件**（见 realtime 需求文档）。

---

## 4. 关联文档（仓库内）

| 文档 | 内容 |
|------|------|
| [session-history-pagination.md](./session-history-pagination.md) | `before` / `limit` / `hasMore`、WS 首包约定 |
| [backend-gateway-realtime-requirements.md](./backend-gateway-realtime-requirements.md) | `chat.event`、timeline、`runStatus`、与历史一致 |
| [backend-history-cache-proposal.md](./backend-history-cache-proposal.md) | 历史读路径缓存与性能（非阻塞功能） |
| [webui-timeline-architecture.md](./webui-timeline-architecture.md) | 前端时间线消费背景 |
| [web-console-slash-commands-contract.md](./web-console-slash-commands-contract.md) | 斜杠命令：`POST message` 契约、`GET /api/commands` 与网关分工 |

---

## 5. 前端实现索引（供对照）

- 历史分页常量：`openclaw-web-client/src/constants/history.ts`（首屏 **20**、每步 **10**、expand 上限 **200**）。  
- 合并与 `before` 兜底：`openclaw-web-client/src/state/useAppState.ts`（`loadOlderHistory`；网关忽略 `before` 时会加大 `limit`，遇返回条数**平台**会提前结束 expand）。  
- 类型定义：`openclaw-web-client/src/types/api.ts`。

---

## 6. 桥接层（`openclaw-web-api`）可对齐项（已实现 / 可调）

- **WS 首包 `limit`**：与 `HISTORY_PAGE_DEFAULT` 一致，当前 **20**（与 `history.ts` 的 `HISTORY_PAGE_SIZE` 对齐）。  
- **`connect` scopes**：默认请求 `operator.read`、`operator.write`、**`operator.admin`**（缓解联调中 `missing scope: operator.admin`）；可通过环境变量 **`OPENCLAW_WEB_GATEWAY_SCOPES`**（逗号分隔）覆盖，例如仅 `operator.read,operator.write`。  
- 历史分页透传、`hasMore` 合并规则、进程内 LRU 等见 [session-history-pagination.md](./session-history-pagination.md) §9、[backend-history-cache-proposal.md](./backend-history-cache-proposal.md)。  
- **斜杠命令**：`GET /api/commands`、`GET /api/sessions/:id/commands` 与静态配置 `openclaw-web-api/web-slash-commands.json`；详见 [web-console-slash-commands-contract.md](./web-console-slash-commands-contract.md)。

---

## 7. `GET /api/models`（可配置模型列表，桥接已实现）

桥接按顺序调用本机 `openclaw`，**首次成功返回非空列表即停止**：

1. `openclaw status --json` — 若 JSON 中含 `models` / `configuredModels` / `allowedModels` 等数组（供未来 OpenClaw 在 status 内嵌列表）。
2. `openclaw models list --json` — 解析 `models[]`（元素常见字段 `key`、`name`）。
3. `openclaw model list --json` — 同上结构（若 CLI 提供该子命令）。
4. `openclaw models status --json` — 解析 `allowed[]` 字符串列表，并附带 `defaultModel`、`fallbacks`、`aliases` 等元数据。
5. `openclaw models --status-json` — 与上等价。

响应 JSON：`schemaVersion`、`source`（实际命中命令说明）、`models[]`。每个元素至少含 **`id`**、**`model`**、**`name`**、**`label`**（与 `name` 相同，兼容旧前端）、可选 **`modelProvider`**；来自 `models list` 时还可含 **`available`**、**`tags`**。另可含 **`defaultModel`**、**`fallbacks`** 等。

> 当前 CLI 中 `openclaw models --json` 无效；请使用 **`models list --json`** / **`models status --json`**。若需在 `status --json` 中直接提供模型数组，由 OpenClaw 发版后桥接第 1 步即可生效。

---

## 8. 会话 verbose / think / patch / compact（桥接已实现）

- **`GET /api/sessions`（网关 `sessions.list`）**  
  每条 session 经桥接 `normalizeSession` 后包含 **`verbose`**（布尔，网关未给时默认为 `false`）、**`think`**（`low` \| `high` \| `off`，未识别则为省略）。  
  读取顺序：`think` / `thinkLevel` / `thinking` / `thinkingLevel`；常见别名会映射到三档（如 `minimal`→`low`，`xhigh`→`high`）。

- **`POST /api/sessions/:sessionId/patch`**  
  白名单：**`label`、`model`、`modelProvider`、`verbose`、`think`**。  
  多余字段 → **400** `unknown_fields`；`think` 非 low/high/off → **400** `invalid_think`；`verbose` 非布尔 → **400** `invalid_verbose`。  
  调用网关时除 `think` 外会附带 **`thinkLevel`**（同值）以兼容旧字段名。

- **`POST /api/sessions/:sessionId/compact`**  
  默认 **`OPENCLAW_COMPACT_METHOD=auto`**：依次尝试 **`sessions.compact`**、**`chat.compact`**（参数 `{ sessionKey }`）；若判定为「方法不存在」类错误则回退 **`chat.send` `/compact`**。  
  可设为 **`slash`** 强制仅斜杠；**`sessions.compact`** / **`chat.compact`** 仅调单一 RPC（失败则直接报错）。  
  响应体含 **`via`** 字段标明实际路径。

---

*文档版本：与当前 Web 客户端行为对齐；网关变更时请同步更新本文与 `session-history-pagination.md`。*
