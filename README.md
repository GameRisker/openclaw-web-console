# OpenClaw Web Console

Web 控制台，用浏览器管理 OpenClaw 的 sessions / agents / realtime chat。

当前仓库是一个 **双工程仓库**：

- `openclaw-web-client`：React + TypeScript + Vite 前端
- `openclaw-web-api`：Node + Express + WebSocket 桥接层

顶层 `package.json` 负责统一启动、构建和开发流程。

---

## 这是什么

这个项目不是直接实现一个独立 LLM 后端，而是作为 **OpenClaw 的 Web UI / bridge**：

- 前端负责控制台 UI、会话列表、Agent 列表、消息区、上下文面板等
- 后端负责调用本机 `openclaw` CLI、连接 Gateway、把 realtime 事件转成浏览器可消费的接口

可以把它理解成：

> 浏览器端控制台 + 本机 OpenClaw 运行时之间的一层适配器

---

## 仓库结构

```text
openclaw-web-console/
├─ package.json                  # 顶层脚本；统一启动前后端
├─ openclaw-web-api/             # Express + ws bridge
│  ├─ server.mjs                 # HTTP / WebSocket / OpenClaw bridge 主入口
│  ├─ web-slash-commands.json    # Web 侧 slash command 补全目录
│  └─ dist/                      # 前端构建产物由 API 静态托管
├─ openclaw-web-client/          # React + Vite 前端
│  ├─ src/
│  ├─ public/
│  ├─ vite.config.ts
│  └─ eslint.config.js
└─ docs/                         # 设计说明、需求、协议草案
```

---

## 依赖要求

运行这个项目前，默认你已经具备：

### 必需

- Node.js 22+
- npm
- 本机可执行 `openclaw`
- 本机已有可用的 OpenClaw 配置与状态目录

### 默认依赖的 OpenClaw 本地环境

后端默认会读取：

- 配置文件：`~/.openclaw/openclaw.json`
- 状态目录：`~/.openclaw`
- Gateway：从 OpenClaw 配置中读取认证信息和端口

也支持通过环境变量覆盖：

- `OPENCLAW_CONFIG_PATH`
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_WEB_GATEWAY_SCOPES`
- `OPENCLAW_WEB_SLASH_COMMANDS_JSON`
- `OPENCLAW_WEB_BRIDGE_LOG`
- `HISTORY_CACHE_ENABLED`
- `HISTORY_CACHE_MAX_ENTRIES`
- `HISTORY_CACHE_TTL_MS`
- `OPENCLAW_COMPACT_METHOD`
- `PORT`
- `HOST`

---

## 安装

在仓库根目录执行：

```bash
npm install
```

> 约定：依赖从仓库根目录安装，不要分别在 `openclaw-web-client` 和 `openclaw-web-api` 里各装一套。

---

## 开发启动

### 同时启动前后端

```bash
npm run dev
```

这会并行启动：

- API：`node ./openclaw-web-api/server.mjs`
- Web：Vite dev server（使用 `openclaw-web-client/vite.config.ts`）

### 只启动前端

```bash
npm run dev:web
```

### 只启动后端

```bash
npm run dev:api
```

---

## 生产/预览

### 构建前端

```bash
npm run build
```

默认会：

- 对 `openclaw-web-client` 做 TypeScript build
- 用 Vite 构建前端
- 将产物输出给 API 侧静态托管使用

### 启动 API（静态托管已构建前端）

```bash
npm start
```

默认监听：

- `HOST=0.0.0.0`
- `PORT=3001`

浏览器访问：

```text
http://localhost:3001
```

如果还没 build，API 会返回：

```text
Web UI not built yet. Run `npm run build` first.
```

### 预览前端构建产物

```bash
npm run preview
```

---

## 顶层脚本说明

```json
{
  "dev": "同时启动 api + web",
  "dev:web": "启动 Vite 前端",
  "dev:api": "启动 bridge API",
  "build": "构建 client",
  "deploy": "build 后 start",
  "start": "启动 API + 静态托管 dist",
  "typecheck": "前端类型检查",
  "lint": "前端 ESLint",
  "preview": "Vite preview"
}
```

---

## 当前已实现的能力

### Sessions

- 列出会话
- 新建会话
- 删除会话
- 重命名会话
- 获取历史消息
- 发送消息
- 中止当前运行
- patch 会话设置（label / model / modelProvider / verbose / think）
- compact 当前会话

### Agents

- 列出 agents
- 从 sessions 推导 agent 槽位（当网关列表不完整时）
- 新建 agent
- 删除 agent
- patch agent 设置

### Runtime / metadata

- 读取 OpenClaw status
- 拉取模型目录
- slash command 补全目录
- WebSocket realtime 订阅与事件转发
- history cache / fallback / before cursor 兼容

---

## API 概览

当前后端提供的 HTTP 接口包括：

### 基础状态

- `GET /api/health`
- `GET /api/status`
- `GET /api/models`
- `GET /api/commands`
- `GET /api/sessions/:sessionId/commands`

### Sessions

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId/history`
- `POST /api/sessions/:sessionId/message`
- `POST /api/sessions/:sessionId/abort`
- `POST /api/sessions/:sessionId/label`
- `POST /api/sessions/:sessionId/patch`
- `POST /api/sessions/:sessionId/compact`
- `DELETE /api/sessions/:sessionId`

### Agents

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:slot`
- `DELETE /api/agents/:slot`

### Realtime

- `WS /api/realtime`

---

## Realtime 行为概览

前端通过 `/api/realtime` 建立 WebSocket 连接。

典型流程：

1. 前端连接 WebSocket
2. 前端发送 `subscribe`，附带 `sessionId`
3. bridge 将该 session 映射到 Gateway `chat.subscribe`
4. bridge 返回：
   - `session.update`
   - `message.batch`
   - `timeline.snapshot`
5. 运行过程中继续推送：
   - `chat.event`
   - `message.upsert`
   - `timeline.event`

说明：

- 前端当前同时维护 `messages` / `renderItems` / `timeline events` 三类表示
- bridge 会尽量兼容 Gateway 在字段名、状态名、分页行为上的差异

---

## 与 OpenClaw 的耦合点

这个项目默认直接依赖本机 OpenClaw 运行环境，主要方式包括：

### 1. 通过 CLI 获取信息

例如：

- `openclaw status --json`
- `openclaw models list --json`
- `openclaw gateway call ...`
- `openclaw agents add ...`
- `openclaw agents delete ...`

### 2. 通过 Gateway RPC 调用能力

例如：

- `sessions.list`
- `chat.history`
- `chat.send`
- `chat.abort`
- `sessions.patch`
- `sessions.delete`
- `agents.list`
- `agents.create`
- `agents.delete`

### 3. 必要时直接读写本地配置/状态文件

例如：

- 读取 `~/.openclaw/openclaw.json`
- 维护 `agents.list`
- 写入 `workspace-<slot>/AGENTS.md`

这意味着：

- 该项目默认是 **本机管理控制台**，不是纯前后端分离的远程 SaaS 应用
- OpenClaw CLI / config schema 变化时，bridge 层可能需要同步调整

---

## 已知限制 / 当前状态

### 1. README 之外的文档仍在整理中
`docs/` 下有不少设计草案，但入口文档和实现说明还在补齐。

### 2. 认证还是占位状态
前端 `App.tsx` 当前是固定 `isAuthenticated = true`，登录页存在但还不是完整认证体系。

### 3. API bridge 代码体量较大
当前 `openclaw-web-api/server.mjs` 同时承担了：

- HTTP 路由
- OpenClaw CLI wrapper
- Gateway adapter
- history fallback / cache
- agent/session 管理
- WebSocket bridge

后续应继续模块化拆分。

### 4. 前端状态管理复杂度较高
当前 `useAppState.ts` 已经承担：

- optimistic messages
- realtime merge
- history pagination
- send lifecycle
- session / agent CRUD

功能可用，但继续扩展前建议做更清晰的分层。

---

## 开发建议

如果你要继续开发，建议优先关注：

1. 补测试，尤其是：
   - history fallback
   - models catalog fallback
   - session / agent patch 行为
   - realtime merge 行为
2. 拆分 `openclaw-web-api/server.mjs`
3. 拆分 `openclaw-web-client/src/state/useAppState.ts`
4. 继续完善 `docs/` 中的协议说明

---

## 常见问题

### 页面打开后提示 `Web UI not built yet`
先执行：

```bash
npm run build
npm start
```

### 端口被占用
可改端口启动：

```bash
PORT=3002 npm start
```

如果你在 dev 模式下改 API 端口，记得同步调整前端代理配置。

### 看不到 sessions / agents
优先检查：

- `openclaw status`
- Gateway 是否正常
- 当前用户是否能访问 `~/.openclaw/openclaw.json`
- API 进程启动日志是否有 bridge / gateway 报错

### 模型列表为空
后端会尝试多个 CLI 探测路径；如果都失败，会返回空列表而不是直接崩掉。请先确认本机 `openclaw` CLI 的模型相关命令是否可用。

---

## 后续文档建议

建议接下来补齐：

- `docs/architecture.md`：总体架构图
- `docs/realtime-protocol.md`：WebSocket 事件协议
- `docs/dev-setup.md`：开发环境与排错
- `docs/roadmap.md`：已实现 / 未实现 / 待重构项

---

## License / Note

仓库里暂未看到明确的 license 声明；如需开源或团队协作，建议补充。
