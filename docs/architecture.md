# OpenClaw Web Console Architecture

本文档描述 `openclaw-web-console` 当前的整体架构、模块职责、关键数据流，以及主要设计取舍。

> 当前实现仍在演进中。本文档以仓库现状为准，优先解释“现在是怎么工作的”。

---

## 1. 总览

`openclaw-web-console` 是一个运行在本机 OpenClaw 环境之上的 Web 控制台。

它由两部分组成：

- **openclaw-web-client**：浏览器前端，负责 UI、状态管理、交互
- **openclaw-web-api**：本地 bridge，负责适配 OpenClaw CLI / Gateway，并向前端暴露 HTTP + WebSocket 接口

核心目标不是实现新的模型运行时，而是把已有的 OpenClaw 本地能力以 Web 控制台形式暴露出来。

---

## 2. 逻辑架构图

```text
┌─────────────────────────────┐
│        Browser / UI         │
│  React + TS + Vite client   │
└──────────────┬──────────────┘
               │
               │ HTTP + WebSocket
               ▼
┌─────────────────────────────┐
│     openclaw-web-api        │
│ Express + ws bridge layer   │
│                             │
│ - REST endpoints            │
│ - realtime websocket        │
│ - history / models / agents │
│ - session patch / compact   │
└───────┬─────────────┬───────┘
        │             │
        │             │
        ▼             ▼
┌───────────────┐   ┌───────────────────┐
│ openclaw CLI  │   │ OpenClaw Gateway  │
│ local command │   │ RPC / chat stream │
└──────┬────────┘   └─────────┬─────────┘
       │                      │
       ▼                      ▼
┌───────────────┐   ┌───────────────────┐
│ ~/.openclaw   │   │ OpenClaw runtime  │
│ config/state  │   │ sessions / agents │
└───────────────┘   └───────────────────┘
```

---

## 3. 组件职责

## 3.1 openclaw-web-client

前端负责：

- 展示 session 列表、agent 列表、消息线程、Context 面板
- 发起 HTTP 请求获取 sessions / agents / history / models / status
- 建立 websocket 订阅当前 session 的 realtime 事件
- 维护本地 UI 状态
- 处理 optimistic message、消息合并、滚动行为、slash 菜单等交互

前端不直接调用 `openclaw` CLI，也不直接连接 Gateway。

### 主要模块

```text
openclaw-web-client/src/
├─ pages/
│  └─ AppShellPage.tsx         # 主界面容器
├─ state/
│  ├─ api.ts                   # HTTP API 调用封装
│  ├─ realtime.ts              # WebSocket 连接封装
│  └─ useAppState.ts           # 应用级状态管理
├─ features/
│  ├─ session-list/
│  ├─ agent-list/
│  ├─ left-sidebar/
│  └─ context-panel/
├─ utils/
├─ types/
└─ lib/
```

---

## 3.2 openclaw-web-api

后端 bridge 负责：

- 提供前端可调用的 HTTP API
- 通过 `openclaw` CLI 获取状态、模型信息、配置等
- 通过 Gateway RPC 调用 session / agent / chat 能力
- 通过 websocket 接收 Gateway chat 事件，并转发给前端
- 对 Gateway / CLI 的差异、兼容性问题、分页问题做兜底

它本质上是一个 **本地 adapter / BFF**，不是传统业务后端。

### 当前主要职责集中在 `server.mjs`

当前 `openclaw-web-api/server.mjs` 同时承担：

- Express 路由注册
- CLI 执行器
- Gateway RPC 调用器
- session / history / model / agent 的 normalize
- history cache 与分页 fallback
- slash command catalog
- websocket realtime bridge
- bridge 内部状态缓存

这也是当前主要的技术债来源之一。

---

## 4. 前端数据流

## 4.1 启动阶段

浏览器加载后，前端会：

1. 调 `GET /api/sessions`
2. 调 `GET /api/status`
3. 调 `GET /api/agents`
4. 选中默认 session
5. 请求该 session 的历史记录
6. 建立 websocket，并订阅当前 session

简化流程：

```text
App boot
  ├─ fetchSessions()
  ├─ fetchStatus()
  ├─ fetchAgents()
  ├─ select active session
  ├─ fetchSessionHistory(activeSession)
  └─ connectRealtime() + subscribe(activeSession)
```

---

## 4.2 消息发送流程

用户发送消息时，前端会先做 optimistic 更新，再发 HTTP 请求。

```text
User submits message
  ├─ append optimistic user message in UI
  ├─ POST /api/sessions/:id/message
  ├─ mark sendStatus = sending / queued
  ├─ wait for realtime events and/or history refresh
  └─ merge server messages with optimistic message
```

前端要处理几个现实问题：

- optimistic message 可能与服务端回显重复
- WebSocket 事件可能先到，也可能 history refresh 先到
- Gateway 的 completed / running 状态可能不完全一致
- 同一轮消息可能同时出现在 timeline 和 history 中

因此当前前端内部维护了多层表示：

- `messages`
- `renderItems`
- `timelineEvents`

并在 `useAppState.ts` 中进行归并。

---

## 4.3 历史记录分页

历史记录主要通过：

- `GET /api/sessions/:sessionId/history?limit=...&before=...`

前端支持“点击加载更早记录”。

客户端策略：

1. 记录当前最老消息 id
2. 调 history 接口带 `before`
3. 把返回结果与当前快照合并
4. 去重、按时间排序
5. 更新 `historyHasMore`

因为 Gateway 历史分页行为不一定稳定，前端还做了多层兼容，例如：

- 检查新页是否真的引入了新消息
- 如果没有，就尝试扩大抓取窗口
- 如果继续没有新内容，则判定没有更多历史

---

## 5. 后端数据流

## 5.1 CLI 调用

bridge 通过子进程执行 `openclaw` 命令获得部分信息：

- `/api/health` → `openclaw health --json`
- `/api/status` → `openclaw status --json`
- `/api/models` → 依次尝试多个 models/status 命令
- agent 注册 / 删除 / config 写入时也可能调用 CLI

这一层主要用于：

- 获取静态/半静态信息
- 调用 Gateway 的 CLI 包装接口
- 在部分场景下回退到本地 config 操作

---

## 5.2 Gateway RPC 调用

bridge 对多数 runtime 行为通过 Gateway 完成，例如：

- `sessions.list`
- `chat.history`
- `chat.send`
- `chat.abort`
- `sessions.patch`
- `sessions.delete`
- `agents.list`
- `agents.create`
- `agents.delete`

bridge 会先读取本地 OpenClaw 配置，拿到：

- gateway token / password
- gateway port
- websocket 地址

然后再统一发起 Gateway 调用。

---

## 5.3 Realtime websocket bridge

后端自身维护一个到 Gateway 的 websocket 连接。

职责：

1. 建立到 Gateway 的 operator 连接
2. 为前端订阅的 session 做 `chat.subscribe`
3. 接收 Gateway `chat` 事件
4. 规范化 payload
5. 生成前端可消费的事件：
   - `chat.event`
   - `message.upsert`
   - `message.batch`
   - `timeline.event`
   - `timeline.snapshot`

也就是说，后端 websocket 并不是透明转发，而是做了一层 **事件重组与协议适配**。

---

## 6. HTTP API 分层理解

从职责上看，当前 API 可以分成几类：

### 6.1 Runtime / metadata

- `/api/health`
- `/api/status`
- `/api/models`
- `/api/commands`

### 6.2 Session 管理

- `/api/sessions`
- `/api/sessions/:id/history`
- `/api/sessions/:id/message`
- `/api/sessions/:id/abort`
- `/api/sessions/:id/label`
- `/api/sessions/:id/patch`
- `/api/sessions/:id/compact`
- `/api/sessions/:id` (DELETE)

### 6.3 Agent 管理

- `/api/agents`
- `/api/agents/:slot` (PATCH / DELETE)

### 6.4 Realtime

- `/api/realtime` (WebSocket)

---

## 7. Agent 模型

当前项目里 “Agent” 的概念并不只是前端 UI 分类，而是与 OpenClaw 的 session key 命名和本地 workspace 约定有关。

### 当前约定

session key 使用类似形式：

```text
agent:<slot>:tui-<uuid>
```

例如：

```text
agent:main:tui-xxxx
agent:research:tui-yyyy
```

### 由此推导出的行为

- bridge 可以从 session key 中解析 agent slot
- `/api/agents` 即使网关没有完整 agent 列表，也可以从 sessions 派生槽位
- 新建 agent 时会创建对应 session key
- 还可能写入：
  - `~/.openclaw/workspace-<slot>/AGENTS.md`
  - `~/.openclaw/openclaw.json` 中的 `agents.list`

这说明当前 Agent 同时具备：

- UI 分类意义
- runtime 槽位意义
- 本地 workspace / config 意义

---

## 8. 模型目录加载策略

模型目录不是写死的，而是后端动态探测。

当前优先级大致为：

1. `openclaw status --json` 中可能嵌入的 models
2. `openclaw models list --json`
3. `openclaw model list --json`
4. `openclaw models status --json`
5. `openclaw models --status-json`

这样做的原因是：

- 不同 OpenClaw 版本或命令别名可能不同
- bridge 需要兼容 CLI 演进
- 如果某种命令不存在，不应直接导致前端崩溃

最终前端拿到的是一个统一 normalize 后的模型列表。

---

## 9. History cache 与 fallback 设计

历史消息是当前 bridge 最复杂的部分之一。

### 为什么需要 cache

原因很现实：

- 每次 history / sessions.list 都是单独的 `openclaw` 调用或 Gateway 请求
- 频繁拉取会慢
- 前端会反复请求历史、滚动分页、发送后 refresh

因此 bridge 内部维护了一个进程内 LRU cache，用于缓存 history 返回结果。

### 为什么需要 fallback

因为 Gateway / chat.history 在某些情况下：

- 不支持 `before`
- `before` 传了直接报错
- 返回的 `hasMore` 字段不稳定
- 会把游标本身又带回本页

当前 bridge 的策略是：

1. 优先直接请求 `chat.history(sessionKey, limit, before)`
2. 如果失败，回退成更宽窗口抓取
3. 在本地按 `beforeId` 切片
4. 再计算 `hasMore`

这是一个典型的“兼容脏上游”的设计。

---

## 10. Realtime 事件模型

bridge 并不把 Gateway 事件原样透传，而是转成前端当前使用的几类事件：

### 10.1 `session.update`
表示 session 订阅已建立，通常会附带当前快照

### 10.2 `message.batch`
一次性下发消息数组，常用于：

- 首次订阅时的历史快照
- 某轮消息聚合后下发

### 10.3 `message.upsert`
增量更新/插入单条消息

### 10.4 `chat.event`
更偏运行状态层面的事件，例如：

- delta
- final
- error

### 10.5 `timeline.snapshot`
用于提供当前整段时间线快照

### 10.6 `timeline.event`
用于增量追加/更新 timeline 事件

当前前端会综合这些事件来决定：

- 是否把 sendStatus 从 queued → waiting-response → completed
- 是否把 toolActivityStatus 设成 running / completed / failed
- 是否要刷新 history 兜底

---

## 11. 当前架构的优点

### 11.1 贴近 OpenClaw 现状
项目不是抽象过头，而是直面：

- CLI 存在多种版本/别名
- Gateway 字段不完全稳定
- history 分页有兼容性问题
- agent 信息可能缺失

因此它在“真实 OpenClaw 环境中可用”的概率比较高。

### 11.2 bridge 吃掉了大量兼容复杂度
虽然前端仍然复杂，但 bridge 已经承担了不少兼容逻辑，例如：

- 模型目录 fallback
- slash commands fallback
- session / agent normalize
- history before fallback
- gateway chat 事件规范化

### 11.3 顶层启动方式简单
根目录脚本已经统一了 dev/build/start，使这个双工程仓库对本地开发比较友好。

---

## 12. 当前架构的主要问题

## 12.1 后端职责过载
`openclaw-web-api/server.mjs` 当前太大，主要问题包括：

- HTTP 路由和业务逻辑耦合
- gateway adapter 与 CLI adapter 耦合
- agent/config 文件写入逻辑混在一起
- history cache / websocket bridge / normalize 全放在一个文件里

建议后续拆分为：

```text
openclaw-web-api/
├─ routes/
├─ services/
│  ├─ gateway/
│  ├─ openclaw-cli/
│  ├─ sessions/
│  ├─ agents/
│  ├─ history/
│  └─ models/
├─ realtime/
├─ mappers/
└─ server.mjs
```

## 12.2 前端状态复杂度高
`useAppState.ts` 当前已具备状态机复杂度，但还没有形式化状态机表达。

尤其复杂在：

- optimistic message
- websocket + history 双来源合并
- renderItems / messages / timeline 三套表示
- sendStatus / toolActivityStatus 的联动

如果继续扩展，建议进一步分层，例如：

- `useSessionsStore`
- `useRealtimeSession`
- `useHistoryPagination`
- `useComposerState`

## 12.3 协议没有完全显式化
虽然有 `types/api.ts`，但从长期维护角度，仍建议补一份完整的协议文档，尤其是：

- realtime 事件 schema
- timeline item schema
- patch payload schema
- model catalog response schema

---

## 13. 推荐的后续演进方向

### 近一步

1. 拆 `server.mjs`
2. 拆 `useAppState.ts`
3. 明确 websocket 协议文档
4. 增加关键 normalize / fallback 的测试

### 中期

1. 增加真正的认证/授权层
2. 明确 API contract 与版本策略
3. 减少前端对底层 bridge 行为细节的依赖
4. 逐步把 Agent / Session / History 相关逻辑模块化

---

## 14. 一句话总结

当前架构可以概括为：

> 一个本地 Web 控制台，通过 bridge 把 OpenClaw CLI + Gateway 的能力包装成浏览器可用的会话管理与实时聊天系统。

它已经具备产品雏形，也已经为真实环境兼容性做了不少工作；当前最大的挑战不是“能不能做”，而是“如何把已做出来的复杂度整理清楚”。
