# Web 控制台 — 斜杠命令（与后端 / 网关契约）

本文与前端需求说明一致，约定 **桥接层（openclaw-web-api）**、**网关 / chat.send** 与 **Web 客户端** 的分工。

## 1. 发送路径（不变）

- **方法**：`POST /api/sessions/{sessionId}/message`
- **请求体**：JSON，字段 **`message`**（字符串），值为用户可见全文经 **trim** 后的结果。
- 可包含前导 `/`，例如 `{"message":"/help"}`、`{"message":"/model gpt-4"}`。
- **桥接**不做命令解析，原样 `gateway call chat.send`（参数含 `sessionKey`、上述字符串）。

## 2. 解析与执行（网关 / TUI 权威）

- **是否**将某条消息视为斜杠命令、匹配规则（整段 / 首行 / 首 token、多行、引号等）由 **Gateway 与会话实现**决定，须与 **CLI/TUI** 对齐。
- **未知或非法「命令」**：由网关决定是作为 **普通用户消息**交给模型，还是返回 **业务错误**；桥接当前将 `chat.send` 的 HTTP 结果原样返回（成功 200 / 失败 4xx/5xx 与网关错误信息），**不**在桥接层单独识别「非法斜杠」。
- 若需在前端 composer 展示明确错误，依赖网关经 **`chat.send` 响应**或 **WS 事件**携带可读 `message`（与现网实时需求文档一致）。

## 3. 可选：拉取命令列表（桥接已实现）

用于替换前端写死补全数据；**未调用时不影响发送**。

| 接口 | 说明 |
|------|------|
| `GET /api/commands` | 全局列表；响应中 `commands[]` 仅含 `showInWeb !== false` 的项（供下拉）。 |
| `GET /api/sessions/{sessionId}/commands` | 先 `resolveSession`（不存在则 404）；列表内容与全局一致，并带 `sessionId` / `sessionKey` 便于前端缓存键。当前 **无**按会话过滤命令；若产品需要权限过滤，在网关提供数据后由桥接二次封装。 |

响应形状（示例字段）：

```json
{
  "schemaVersion": 1,
  "source": "openclaw-web-api",
  "authorityNote": "…",
  "commands": [
    {
      "trigger": "/help",
      "description": "…",
      "showInWeb": true,
      "argStyle": "space_separated",
      "argHint": "…",
      "examples": ["…"]
    }
  ]
}
```

- **`trigger`**：展示用触发串，以 `/` 开头。
- **`description`**：简短说明。
- **`showInWeb`**：是否在 Web 下拉展示（服务端过滤）。
- **`argStyle`** / **`argHint`** / **`examples`**：可选，便于 UI 提示；**非**结构化执行参数。

数据来源：`openclaw-web-api/web-slash-commands.json`。可通过环境变量 **`OPENCLAW_WEB_SLASH_COMMANDS_JSON`** 指向自定义 JSON 文件（格式：`{ "commands": [ … ] }` 或顶层数组）；不可读时回退到内置最小列表。

## 4. 未来扩展（未实现）

若协议上与普通聊天分离，可在同一 `POST` 上增加 **`type` / `command` / `args`** 等字段，须：

- 文档化并与网关一致；
- 前端改造；
- **仅 `message` 的旧客户端** 仍只发字符串（向后兼容）。

当前 **不**改 `POST` 请求体，仅支持 `message`。

## 5. 关联文档

- [backend-requirements-web-console.md](./backend-requirements-web-console.md)
- [backend-gateway-realtime-requirements.md](./backend-gateway-realtime-requirements.md)
