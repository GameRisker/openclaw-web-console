# OpenClaw Web Console 开发环境与排错

这份文档面向本地开发者，说明如何把 `openclaw-web-console` 跑起来，以及遇到常见问题时该先检查什么。

> 该项目依赖本机 OpenClaw 运行环境，不是“只 npm install 就能完全独立跑起来”的纯前端项目。

---

## 1. 你需要什么

开始前，请先确认本机具备以下条件。

### 必需软件

- Node.js 22+
- npm
- 可执行的 `openclaw` CLI
- 本机已有 OpenClaw 配置与状态目录

### 建议环境

- macOS / Linux 开发环境
- 可以访问本机用户目录下的 `~/.openclaw`
- 已启动或可启动的 OpenClaw Gateway

---

## 2. 最低检查清单

在进入仓库前，先跑下面几个命令确认基础环境：

```bash
node -v
npm -v
openclaw --version
openclaw status
```

如果 `openclaw status` 本身就报错，那优先修 OpenClaw 本体，不要先怀疑 web console。

---

## 3. 仓库安装

在仓库根目录执行：

```bash
npm install
```

说明：

- 依赖统一从根目录安装
- 不建议分别进入 `openclaw-web-client` 和 `openclaw-web-api` 重复安装
- 顶层 `package.json` 已经负责管理整体开发脚本

---

## 4. 最常用的启动方式

## 4.1 开发模式：同时启动前后端

```bash
npm run dev
```

这会同时启动：

- API bridge：`openclaw-web-api/server.mjs`
- Web client：Vite dev server

如果一切正常，你会得到：

- 一个前端开发服务器
- 一个本地 API / websocket bridge

---

## 4.2 只起后端

```bash
npm run dev:api
```

适合：

- 单独调 API
- 看 bridge 日志
- 排查 Gateway / OpenClaw 接入问题

---

## 4.3 只起前端

```bash
npm run dev:web
```

适合：

- 只调 UI
- 前端样式/交互开发

但注意：

- 如果后端没起，前端大多数功能不可用
- websocket / sessions / agents / history 都依赖 bridge

---

## 5. 生产式本地运行

如果你想像部署态一样本地跑：

### 构建前端

```bash
npm run build
```

### 启动 API + 静态托管

```bash
npm start
```

默认地址：

```text
http://localhost:3001
```

---

## 6. 启动前最好确认什么

建议每次排问题前都先确认这几个点：

### 6.1 OpenClaw CLI 正常

```bash
openclaw status
```

### 6.2 Gateway 正常

如果你怀疑是 Gateway 问题，先看：

```bash
openclaw gateway status
```

如未启动，可尝试：

```bash
openclaw gateway start
```

如果已启动但行为异常，可尝试：

```bash
openclaw gateway restart
```

### 6.3 配置文件存在

默认配置文件位置：

```text
~/.openclaw/openclaw.json
```

默认状态目录：

```text
~/.openclaw
```

如果 bridge 启动时报配置相关错误，优先检查：

- 文件是否存在
- JSON 是否有效
- 当前用户是否有权限读取

---

## 7. 环境变量

当前项目支持若干环境变量覆盖默认行为。

## 7.1 OpenClaw 相关

### `OPENCLAW_CONFIG_PATH`
覆盖默认配置文件路径。

默认：

```text
~/.openclaw/openclaw.json
```

示例：

```bash
OPENCLAW_CONFIG_PATH=/custom/path/openclaw.json npm run dev:api
```

### `OPENCLAW_STATE_DIR`
覆盖默认状态目录。

默认：

```text
~/.openclaw
```

示例：

```bash
OPENCLAW_STATE_DIR=/custom/state npm run dev:api
```

### `OPENCLAW_WEB_GATEWAY_SCOPES`
覆盖 bridge 连接 Gateway 时使用的 scopes。

默认行为：

- `operator.read`
- `operator.write`
- `operator.admin`

示例：

```bash
OPENCLAW_WEB_GATEWAY_SCOPES="operator.read,operator.write" npm run dev:api
```

---

## 7.2 Web bridge 相关

### `PORT`
覆盖 API 端口。

默认：

```text
3001
```

示例：

```bash
PORT=3002 npm start
```

### `HOST`
覆盖监听地址。

默认：

```text
0.0.0.0
```

### `OPENCLAW_WEB_BRIDGE_LOG`
控制 bridge 终端调试日志。

默认开启；可关闭：

```bash
OPENCLAW_WEB_BRIDGE_LOG=0 npm run dev:api
```

### `OPENCLAW_WEB_SLASH_COMMANDS_JSON`
指定自定义 slash command catalog JSON 文件。

示例：

```bash
OPENCLAW_WEB_SLASH_COMMANDS_JSON=./custom-commands.json npm run dev:api
```

---

## 7.3 history / compact 相关

### `HISTORY_CACHE_ENABLED`
开启/关闭 history 缓存。

默认：

```text
1
```

关闭：

```bash
HISTORY_CACHE_ENABLED=0 npm run dev:api
```

### `HISTORY_CACHE_MAX_ENTRIES`
设置缓存条目上限。

### `HISTORY_CACHE_TTL_MS`
设置缓存 TTL（毫秒）。

### `OPENCLAW_COMPACT_METHOD`
控制 compact 使用哪条路径。

可选值：

- `auto`
- `sessions.compact`
- `chat.compact`
- `slash`

示例：

```bash
OPENCLAW_COMPACT_METHOD=slash npm run dev:api
```

---

## 8. 推荐的日常开发流程

一个比较稳的本地流程是：

### 步骤 1：先确认 OpenClaw 本体

```bash
openclaw status
openclaw gateway status
```

### 步骤 2：安装依赖

```bash
npm install
```

### 步骤 3：起后端看日志

```bash
npm run dev:api
```

确认终端里没有明显错误，例如：

- 配置文件读取失败
- Gateway 认证失败
- `openclaw` 子进程执行失败

### 步骤 4：再起前端

```bash
npm run dev:web
```

### 步骤 5：浏览器打开页面联调

建议重点先验证：

- session 列表能否加载
- 选中 session 后 history 能否加载
- 发送消息后是否能看到 optimistic + realtime 回流
- agents 列表是否能正常显示

---

## 9. 常见问题与排错

## 9.1 `openclaw: command not found`

说明 bridge 所在环境找不到 `openclaw`。

优先检查：

```bash
which openclaw
openclaw --version
```

如果你在 IDE / GUI 环境里启动进程，可能 PATH 与终端不同，需要显式修正 shell 环境。

---

## 9.2 `Web UI not built yet. Run npm run build first.`

说明你启动的是 `npm start`，但前端还没有构建。

执行：

```bash
npm run build
npm start
```

如果你在开发模式，就用：

```bash
npm run dev
```

---

## 9.3 端口被占用 (`EADDRINUSE`)

后端默认监听 `3001`。如果端口被占用：

```bash
PORT=3002 npm run dev:api
```

或：

```bash
PORT=3002 npm start
```

注意：

- 如果改了 API 端口，前端代理配置也要一致
- 同时起了多个 dev 实例时最容易撞端口

---

## 9.4 页面能打开，但 sessions 加载失败

先按顺序检查：

1. `openclaw status`
2. `openclaw gateway status`
3. `~/.openclaw/openclaw.json` 是否存在
4. API 终端日志里是否有：
   - gateway call 失败
   - 认证失败
   - JSON parse 失败
   - CLI 执行失败

如果要更聚焦一点，可以直接测：

```bash
openclaw status --json
```

和：

```bash
openclaw gateway call sessions.list --json
```

如果这些命令本身失败，那问题不在前端。

---

## 9.5 models 为空

bridge 会尝试多条路径加载模型目录；如果都失败，会返回空列表。

排查顺序：

```bash
openclaw status --json
openclaw models list --json
openclaw model list --json
openclaw models status --json
```

看你的本机 OpenClaw 版本到底支持哪条命令。

---

## 9.6 agents 列表不完整或为空

这是当前实现里比较容易出现“看起来怪”的地方之一。

原因：

- bridge 会优先尝试 `agents.list`
- 如果 Gateway 不完整，它还会从 sessions 的 `agent:<slot>:` key 推导 agents

如果 agents 看起来不对，请同时检查：

- `GET /api/agents` 返回
- `GET /api/sessions` 返回
- session key 是否符合 `agent:<slot>:...` 约定
- 本地 `openclaw.json` 中的 `agents.list`

---

## 9.7 history 分页怪异 / before 不生效

这类问题未必是前端 bug，也可能是 Gateway 历史行为不稳定。

当前 bridge 已经做了 fallback：

- `before` 失败则走宽窗口抓取
- 本地切片 older page
- 自行推导 `hasMore`

如果还不对，建议临时关闭缓存再观察：

```bash
HISTORY_CACHE_ENABLED=0 npm run dev:api
```

并重点看 bridge 日志里是否出现：

- `chat.history+before failed`
- `history before id missing in wide window`

---

## 9.8 发送消息后 UI 卡在 queued / waiting-response

这通常是以下几种情况：

- Gateway realtime 没推回来
- history refresh 没拉到对应 assistant reply
- websocket 订阅未建立成功
- 状态流 completed / running 丢了一环

优先检查：

1. 浏览器控制台日志
2. API bridge 日志
3. `/api/realtime` websocket 是否连接成功
4. 发送消息后 `/api/sessions/:id/history` 是否能看到新消息

当前前端已经做了 queued → waiting-response → history refresh 的兜底逻辑，但如果上游完全没回流，UI 仍可能停在中间态。

---

## 9.9 websocket 不工作

检查：

- API 是否正常启动
- 浏览器是否成功连接 `/api/realtime`
- API 日志里是否有 websocket connect / subscribe 记录
- Gateway websocket 连接是否成功完成 `connect.challenge` / `hello-ok`

如果 HTTP 正常但 websocket 不正常，重点看 `server.mjs` 终端日志。

---

## 10. 调试建议

## 10.1 先看 API 终端，不要先看前端样式

这个项目里很多“页面空白/列表不出来/状态不动”问题，其实根因在：

- OpenClaw CLI
- Gateway
- 本地 config
- websocket bridge

所以优先调后端日志，效率更高。

---

## 10.2 分层排查

建议按下面顺序定位：

### 第 1 层：OpenClaw 本体

```bash
openclaw status
openclaw gateway status
```

### 第 2 层：bridge API

检查：

- `npm run dev:api` 是否启动正常
- `/api/status`、`/api/sessions`、`/api/agents` 是否可访问

### 第 3 层：前端

检查：

- 浏览器是否拿到了接口返回
- websocket 是否连通
- UI 是否正确消费事件

---

## 10.3 改后端逻辑时优先保留 fallback

这个项目当前的一个核心价值，就是它在帮前端吸收 OpenClaw / Gateway 的兼容复杂度。

所以在重构时，不要轻易删除这些逻辑，尤其是：

- models fallback
- history before fallback
- sessions / agents merge derive
- compact method fallback

如果想重构，最好先写测试再拆。

---

## 11. 推荐后续补充的开发工具

如果继续长期开发，建议后续加上：

- API 层单元测试
- history / normalize 逻辑的 fixture 测试
- 一份本地 mock / fake gateway 调试方案
- lint / typecheck 进 CI
- README 中增加“快速排障命令速查表”

---

## 12. 一句话版排错原则

如果 web console 出问题，优先按这个顺序排：

> OpenClaw 本体 → Gateway → bridge API → websocket → 前端 UI

而不是一上来就在 React 组件里找问题。
