# OpenClaw Web UI 开发文档

> 更新日期：2026-03-25
> 项目路径：`Codev/openclaw-web-ui`

## 1. 项目目标

当前项目目标是做一个 **替代 `openclaw tui` 的 Web 控制台**，重点先完成：

- session 列表与切换
- history 查看
- 发送消息 / 停止运行
- 基础 realtime 体验
- session 基础管理（创建 / 删除 / 命名）

约束：

- 只做 UI / control bridge，不重写 OpenClaw backend
- 第一版以个人自用为主
- 数据交互优先走 Gateway 正式接口
- 不直接把 session JSONL 文件当正式写入面

---

## 2. 当前技术方案

### 前端

- React
- Vite
- TypeScript
- react-router-dom

### 本地 bridge / API

- `server.mjs`
- Express
- ws

### 已确认的后端接入原则

### 2.1 读取面

统一优先走 Gateway：

- `sessions.list`
- `chat.history`
- `status`

### 2.2 写入面

已确认 **不再使用** `openclaw agent --session-id ...` 作为正式写入方案，因为它会撞到活跃 session transcript 文件锁。

当前正式写入面：

- `chat.send`
- `chat.abort`
- `sessions.delete`
- `sessions.patch`
- `agent`（用于创建新 session）

### 2.3 Realtime

当前 realtime 层已经切到 **Gateway 原生 WS 驱动**：

- 连接地址：`ws://127.0.0.1:8080`
- 协议：Gateway 先发 `connect.challenge`
- 客户端使用 protocol `3` 发 `connect`
- 通过 `chat.subscribe / chat.unsubscribe` 订阅会话事件
- 消费 `chat` 事件并转发给前端 `/api/realtime`

---

## 3. 当前已完成能力

## 3.1 工程骨架

已完成：

- React + Vite + TS 初始化
- 路由结构
- `/login` 占位页
- `/app` 控制台页
- 三栏基础布局
- 左右栏折叠
- Settings drawer 占位

## 3.2 应用状态层

已完成：

- `useAppState` 状态骨架
- session 搜索
- active session 切换
- draft 按 session 维度保存
- auth / connection / history / send / toolActivity 等状态模型

## 3.3 真数据接入

已完成：

- session 列表：真实数据
- session history：真实数据
- status：真实数据
- send：真实调用
- stop：真实调用

对应接口：

- `GET /api/sessions`
- `GET /api/sessions/:sessionId/history`
- `POST /api/sessions/:sessionId/message`
- `POST /api/sessions/:sessionId/abort`
- `GET /api/status`
- `GET /api/health`

## 3.4 Realtime

已完成：

- 本地 `/api/realtime` WebSocket
- 后端 bridge 主动连接 Gateway 原生 WS
- `chat.subscribe / chat.unsubscribe` 订阅管理
- 前端单 WS 连接
- reconnect 后自动恢复订阅
- `delta / final / error` 按 `runId -> messageId` 稳定拼接

## 3.5 运行态 / 控制台反馈

已完成：

- 连接状态：
  - `connecting`
  - `connected`
  - `reconnecting`
  - `degraded`
  - `disconnected`
  - `error`
- run lifecycle：
  - `sending`
  - `queued`
  - `waiting-response`
  - `completed`
  - `stopped`
  - `error`
- `runtimeNote` 提示
- runtime banner
- run status banner
- 消息级 `runStatus`
- running 消息的 streaming cursor（`▍`）

## 3.6 Session 管理

已完成：

- 新建 session
- 删除 session
- 手动 rename session
- 自动命名 session（只触发一次）

当前实现：

### 新建 session

- `POST /api/sessions`
- 底层通过新 `sessionKey` + `agent` 创建
- 默认先命名为 `Untitled`

### 删除 session

- `DELETE /api/sessions/:sessionId`
- 底层走 `sessions.delete({ key })`

### 手动 rename

- 双击左栏 session 标题
- 底层走 `sessions.patch({ key, label })`

### 自动命名

规则：

- 仅当标题仍为 `Untitled`
- 在首次较完整 `final` 消息后触发
- 基于最近消息生成简短摘要标题
- 只触发一次
- 若用户手动改名，后续不再被自动覆盖

---

## 4. 当前关键文件

### 前端

- `src/pages/AppShellPage.tsx`
- `src/state/useAppState.ts`
- `src/state/api.ts`
- `src/state/realtime.ts`
- `src/types/app.ts`
- `src/types/api.ts`
- `src/App.css`

### 后端 bridge

- `server.mjs`

---

## 5. 当前交互状态总结

目前这个 Web UI 已经不再是静态壳子，而是一个可以实际操作的 MVP：

- 可以查看 session 列表
- 可以切换 session
- 可以看历史消息
- 可以发送消息
- 可以停止运行
- 可以实时看到消息与状态变化
- 可以创建 / 删除 / 重命名 session
- session 名可以自动总结一次

---

## 6. 已知限制 / 现状说明

### 6.1 新建 session 仍然属于“创建并启动”

当前新建 session 的实现，是通过 `agent` 带一个新的 `sessionKey` 启动。

这意味着它不是“纯空白壳会话”，而是：

- 创建一个新 session
- 并带着一条初始消息启动

对 MVP 够用，但后续可以继续细化。

### 6.2 手动 rename 当前还是 prompt 方案

现在手动 rename 已经可用，但交互还是：

- 双击标题
- 弹浏览器 prompt

这条链路已经通，但体验还不是最终态。

### 6.3 自动命名是轻量摘要，不是 LLM 真总结

当前自动标题是根据最近消息文本做轻量摘要裁剪，不是专门调用模型做语义总结。

这样做的好处是：

- 快
- 成本低
- 实现简单

但标题质量后续仍有提升空间。

---

## 7. 当前待办（TODO）

### 高优先级

1. **手动 rename 改为内联编辑**
   - 双击后直接变 input
   - Enter 保存
   - Esc 取消
   - 替代当前 `prompt`

2. **新建 session 的交互更合理**
   - 支持输入初始标题或首条消息
   - 不再固定 `Start a new session.`

3. **session 排序与选中策略再打磨**
   - 删除当前 session 后切换策略更自然
   - 新建后定位更稳定
   - 按更新时间排序明确化

### 中优先级

4. **realtime 状态可视化继续打磨**
   - reconnect / degraded 的提示更自然
   - completed / stopped / failed 的收尾反馈更细

5. **消息流式体验继续优化**
   - 减少整段替换感
   - 优化 delta 增量显示观感

6. **右栏 control 能力开始接真功能**
   - 从占位变成真实控制项

### 低优先级

7. **自动标题质量提升**
   - 从简单裁剪升级为更好的摘要逻辑
   - 但仍保持“只自动一次”原则

8. **session 更多元数据展示**
   - 最近更新时间
   - 运行状态
   - 模型信息的展示层次优化

---

## 8. 建议的下一步

如果按当前进度继续推进，我建议下一步优先做：

1. 手动 rename 内联编辑
2. 新建 session 交互优化
3. session 排序 / 删除后切换策略打磨

这三项做完，session 管理体验会明显更完整。 
