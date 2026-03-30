# OpenClaw Web Console Roadmap

这份 roadmap 用来回答三个问题：

1. 这个项目现在已经做到哪了
2. 还有哪些明显缺口 / 技术债
3. 下一阶段应该优先做什么

> 标记说明：
>
> - `[x]` 已完成
> - `[~]` 已有雏形 / 部分完成 / 需要继续打磨
> - `[ ]` 尚未开始或尚未真正完成

---

## 1. 项目目标

OpenClaw Web Console 的目标不是另起一套运行时，而是：

- 为本机 OpenClaw 提供一个可用的 Web 控制台
- 能查看和管理 sessions / agents
- 能进行 realtime chat
- 能在 Web 中展示运行过程、上下文和控制项
- 能在桥接层兼容 OpenClaw CLI / Gateway 的现实差异

一句话说：

> 让 OpenClaw 在浏览器里拥有一个真正可用的本地控制台。

---

## 2. 当前状态总览

## 2.1 基础仓库与工程结构

- [x] 建立双工程仓库结构（client + api）
- [x] 顶层 `package.json` 统一管理 dev/build/start
- [x] 前端与后端可在本地同时启动
- [x] API 可托管构建后的前端静态资源
- [~] 顶层仓库结构已稳定，但模块拆分仍偏粗

---

## 2.2 Web Client（前端）

### 基础 UI

- [x] 主应用壳子 `AppShellPage`
- [x] 左侧 session / agent 面板
- [x] 中间消息线程区
- [x] 右侧 Context / Control 面板
- [x] Settings drawer 占位入口
- [x] 登录页占位
- [~] 页面结构已成型，但主页面组件体量过大

### Sessions 相关

- [x] 展示 sessions 列表
- [x] 选中 active session
- [x] 新建 session
- [x] 删除 session
- [x] 重命名 session
- [x] 加载 session 历史
- [x] 加载更早历史
- [x] patch 当前 session 设置
- [x] compact 当前 session

### Agents 相关

- [x] 展示 agents 列表
- [x] 新建 agent
- [x] 删除 agent
- [x] patch agent 设置
- [x] 从 active session 关联到 agent
- [~] agent 相关交互可用，但模型/身份/槽位的产品语义还需进一步明确

### 消息与交互

- [x] 消息发送
- [x] optimistic user message
- [x] abort 当前运行
- [x] jump to bottom
- [x] markdown 渲染
- [x] tool / verbose / assistant / user 分类显示
- [x] 双击标题重命名
- [x] slash command 菜单基础交互
- [~] slash 命令体验已有，但还不是完整命令树体验

### 状态管理与实时性

- [x] websocket 连接 bridge
- [x] 订阅当前 session realtime
- [x] merge realtime / history / optimistic updates
- [x] 维护 sendStatus / toolActivityStatus
- [x] renderItems / timeline / messages 三套视图兜底
- [~] 功能可用，但状态复杂度已经比较高

---

## 2.3 Web API（bridge）

### 基础服务

- [x] Express HTTP 服务
- [x] WebSocket 服务 `/api/realtime`
- [x] 静态托管前端构建产物
- [x] 启动时读取 OpenClaw 配置
- [x] 统一 Gateway 调用封装

### Runtime / metadata API

- [x] `GET /api/health`
- [x] `GET /api/status`
- [x] `GET /api/models`
- [x] `GET /api/commands`
- [x] `GET /api/sessions/:sessionId/commands`

### Sessions API

- [x] `GET /api/sessions`
- [x] `POST /api/sessions`
- [x] `GET /api/sessions/:sessionId/history`
- [x] `POST /api/sessions/:sessionId/message`
- [x] `POST /api/sessions/:sessionId/abort`
- [x] `POST /api/sessions/:sessionId/label`
- [x] `POST /api/sessions/:sessionId/patch`
- [x] `POST /api/sessions/:sessionId/compact`
- [x] `DELETE /api/sessions/:sessionId`

### Agents API

- [x] `GET /api/agents`
- [x] `POST /api/agents`
- [x] `PATCH /api/agents/:slot`
- [x] `DELETE /api/agents/:slot`

### Gateway / CLI 兼容层

- [x] `openclaw status --json` 获取状态
- [x] 多路径 fallback 获取模型列表
- [x] Gateway chat 事件状态规范化
- [x] sessions.list 缓存
- [x] history cache
- [x] history before fallback
- [x] compact fallback（RPC / slash）
- [x] 从 sessions 派生 agent 槽位
- [~] 兼容逻辑很实用，但代码组织需要重构

### Realtime bridge

- [x] 连接 Gateway websocket
- [x] 处理 `connect.challenge` / `hello-ok`
- [x] 前端 session 订阅到 Gateway `chat.subscribe`
- [x] 聚合和转发 chat 事件
- [x] 输出 `message.batch`
- [x] 输出 `message.upsert`
- [x] 输出 `chat.event`
- [x] 输出 `timeline.snapshot`
- [x] 输出 `timeline.event`
- [~] 事件协议已可用，但仍偏实现导向

---

## 2.4 文档

- [x] 重写 `README.md`
- [x] 新增 `docs/architecture.md`
- [x] 新增 `docs/dev-setup.md`
- [x] 新增 `docs/realtime-protocol.md`
- [x] 新增 `docs/roadmap.md`
- [ ] HTTP API reference（逐接口请求/响应示例）
- [ ] 前端状态流 / lifecycle 文档
- [ ] 测试策略文档

---

## 2.5 工程质量与保障

- [x] TypeScript 用于前端主代码
- [x] ESLint 已接入前端
- [x] 基础 typecheck / lint 脚本已存在
- [ ] 单元测试体系
- [ ] bridge 核心 fallback 的 fixture 测试
- [ ] CI 自动校验
- [ ] 更清晰的模块边界
- [ ] 统一 API contract 文档/模式

---

## 3. 当前主要问题

下面这些并不是“项目不可用”的问题，而是当前阶段最可能拖慢后续开发速度的点。

## 3.1 后端 `server.mjs` 过大

当前它同时承担：

- 路由
- CLI 调用
- Gateway 调用
- history 兼容
- session / agent 逻辑
- realtime bridge
- normalize / mapping

这使它成为当前最大的架构债。

状态：

- [~] 已识别问题，尚未拆分

---

## 3.2 前端 `useAppState.ts` 复杂度高

当前它同时处理：

- session / agent CRUD
- websocket 状态
- optimistic message
- history merge
- send lifecycle
- runtime 状态同步

状态：

- [~] 已识别问题，尚未拆分

---

## 3.3 `AppShellPage.tsx` 过重

目前主页面组件承担了太多：

- 页面布局
- 消息渲染
- slash 菜单交互
- drawer / modal / toast
- 各种局部 UI 状态

状态：

- [~] 已识别问题，尚未拆分

---

## 3.4 协议还不够显式

虽然已有：

- `types/api.ts`
- `docs/realtime-protocol.md`

但仍缺少：

- HTTP API reference
- 更正式的 schema / contract 约束
- 前后端共享的稳定协议边界

状态：

- [~] 已开始补文档，但还没完全成体系

---

## 3.5 测试缺位

当前最大的工程风险不是“功能不存在”，而是：

- fallback 很多
- 兼容逻辑很多
- 状态流很多
- 但测试还很少或基本没有

状态：

- [ ] 尚未建立可靠测试护栏

---

## 4. 下一阶段建议目标（阶段 1）

这一阶段的目标不是再加很多新功能，而是：

> 把当前已经能跑的系统整理成“可持续开发”的形态。

建议聚焦四条主线。

---

## 4.1 主线 A：补工程护栏

### 目标
让后续重构不再完全靠手感。

### 建议任务

- [ ] 建立最小测试框架（优先从 API/bridge 侧开始）
- [ ] 给以下逻辑补测试：
  - [ ] models catalog fallback
  - [ ] history before fallback
  - [ ] session patch payload 校验
  - [ ] agent config merge / fallback
  - [ ] realtime state normalization
- [ ] 把 `lint` 和 `typecheck` 作为最小质量门槛固定下来

### 优先级
**高**

---

## 4.2 主线 B：拆后端 bridge

### 目标
把 `server.mjs` 从“单体大文件”拆成有边界的模块。

### 建议拆分方向

- [ ] `routes/`
- [ ] `services/gateway/`
- [ ] `services/openclaw-cli/`
- [ ] `services/history/`
- [ ] `services/sessions/`
- [ ] `services/agents/`
- [ ] `services/models/`
- [ ] `realtime/`
- [ ] `mappers/`

### 第一批建议拆出的内容

- [ ] `runOpenClawJson` / `runGatewayCall`
- [ ] models catalog 相关函数
- [ ] history cache + fallback 逻辑
- [ ] session / agent normalize 函数
- [ ] websocket bridge 类

### 优先级
**高**

---

## 4.3 主线 C：拆前端状态与页面

### 目标
降低认知负担，让前端更容易继续迭代。

### 建议任务

- [ ] 拆 `AppShellPage.tsx`：
  - [ ] `ChatHeader`
  - [ ] `MessageThread`
  - [ ] `Composer`
  - [ ] `ContextDrawer`
  - [ ] `TopBar`
- [ ] 拆 `useAppState.ts`：
  - [ ] sessions / agents 数据加载
  - [ ] realtime 状态
  - [ ] history merge/pagination
  - [ ] composer/send lifecycle
- [ ] 进一步梳理 `messages` / `renderItems` / `timeline` 的职责边界

### 优先级
**高**

---

## 4.4 主线 D：补契约与开发文档

### 目标
让后续协作和联调更顺畅。

### 建议任务

- [ ] 新增 `docs/api-reference.md`
- [ ] 明确每个 HTTP API 的请求/响应示例
- [ ] 补一份状态流说明（send lifecycle / realtime lifecycle）
- [ ] 明确 agent/session/model 的概念边界

### 优先级
**中高**

---

## 5. 下一阶段可考虑的产品功能（阶段 2）

这些不是当前最急，但在第一阶段稳定后可以考虑。

## 5.1 认证与权限

- [ ] 真实登录态，而不是固定 `isAuthenticated = true`
- [ ] 区分只读/可操作权限
- [ ] 保护敏感控制操作

## 5.2 更完整的 slash command 体验

- [ ] 从后端获取更完整命令树
- [ ] 子命令/参数提示更自然
- [ ] 命令帮助面板

## 5.3 更好的运行可视化

- [ ] 更明确的 timeline 面板
- [ ] tool call / tool result 的专用展示
- [ ] reasoning / verbose 的折叠视图

## 5.4 更完善的 Agent 工作流

- [ ] agent 身份/配置的更明确编辑界面
- [ ] workspace / slot 关系更可视化
- [ ] agent 模板 / 预设

## 5.5 更强的调试能力

- [ ] debug 面板
- [ ] recent gateway events 查看
- [ ] raw payload 检视
- [ ] 导出当前 session 调试信息

---

## 6. 不建议当前阶段优先做的事

为了避免节奏跑偏，当前阶段不建议优先把时间花在这些方向：

- [ ] 大规模视觉重设计
- [ ] 复杂动画/皮肤系统
- [ ] 先做很多“远期高级功能”而不先整理底层结构
- [ ] 在没有测试护栏前就大改 fallback 逻辑
- [ ] 在协议还没稳定前就过早抽象成通用 SDK

原因很简单：

> 当前瓶颈主要是结构化和可维护性，不是“按钮还不够多”。

---

## 7. 建议的下一阶段里程碑

## Milestone A：可维护化基础

完成标准建议如下：

- [ ] README / architecture / dev-setup / realtime-protocol / roadmap 已齐
- [ ] 增加 `api-reference.md`
- [ ] 有最小测试框架
- [ ] 至少 5 个核心 fallback / normalize 测试
- [ ] `server.mjs` 拆出第一批模块
- [ ] `useAppState.ts` 拆出第一批 hooks / store

## Milestone B：状态与协议稳定

- [ ] send lifecycle 文档化
- [ ] realtime contract 更稳定
- [ ] history merge 行为更易理解
- [ ] renderItems / messages / timeline 职责更清晰

## Milestone C：再谈新增产品能力

- [ ] 认证
- [ ] 更完整命令树
- [ ] 更强 agent 能力
- [ ] 更好的调试面板

---

## 8. 一句话结论

当前项目的判断不是“缺功能”，而是：

> 主要功能已经有了，下一阶段最重要的是补护栏、拆结构、稳协议，然后再继续加能力。
