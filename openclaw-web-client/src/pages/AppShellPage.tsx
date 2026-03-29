import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useAppState } from '../state/useAppState'
import { isUserFacingRole } from '../utils/roles'

function getConnectionPillClass(status: string) {
  if (status === 'connected') return 'success'
  if (status === 'reconnecting' || status === 'connecting' || status === 'degraded') return 'info'
  return 'danger'
}

function getRuntimeBadge(status: string) {
  if (status === 'running') return 'Runtime Running'
  if (status === 'failed') return 'Runtime Failed'
  if (status === 'stopped') return 'Runtime Stopped'
  if (status === 'completed') return 'Runtime Completed'
  return 'Runtime Idle'
}

function getSendButtonMeta(sendStatus: string) {
  if (sendStatus === 'sending' || sendStatus === 'queued' || sendStatus === 'waiting-response') {
    return { label: 'Stop', className: 'danger-button' }
  }
  return { label: 'Send', className: 'primary-button' }
}

function formatDuration(ms?: number) {
  if (!ms || ms < 1000) return ms ? `${ms}ms` : 'n/a'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainSeconds}s`
}

function renderMarkdown(content: string) {
  const rawHtml = marked.parse(content, {
    breaks: true,
    gfm: true,
  }) as string

  return DOMPurify.sanitize(rawHtml)
}

function renderMessageHeaderLabel(message: { kind?: string; role?: string; label?: string; toolName?: string }) {
  if (message.kind === 'toolCall' || message.role === 'tool') return message.label || message.toolName || 'Tool Call'
  if (message.kind === 'toolResult' || message.role === 'toolResult') return message.label || message.toolName || 'Tool Result'
  if (message.kind === 'verbose' || message.role === 'verbose') return message.label || 'Verbose'
  return undefined
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remainSeconds}s`
}

function formatTokenCount(value?: number) {
  if (typeof value !== 'number') return undefined
  const kb = value / 1024
  if (kb >= 100) return `${Math.round(kb)}KB`
  if (kb >= 10) return `${kb.toFixed(1)}KB`
  return `${kb.toFixed(2)}KB`
}

function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return 'recently'
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function AppShellPage() {
  const {
    state,
    filteredSessions,
    activeSession,
    currentDraft,
    messages,
    sideCards,
    selectSession,
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleSettings,
    setDraft,
    sendCurrentMessage,
    refreshHistory,
    createNewSession,
    renameSessionTitle,
    modelSideStreaming,
  } = useAppState()

  const messageListRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const previousSessionIdRef = useRef(activeSession.id)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const runtimeBadge = getRuntimeBadge(state.toolActivityStatus)
  const sendButton = getSendButtonMeta(state.sendStatus)
  const [waitElapsedMs, setWaitElapsedMs] = useState(0)
  const contextTokenLabel = formatTokenCount(activeSession.contextTokens)
  const totalTokenLabel = formatTokenCount(activeSession.totalTokens)
  const ctxN = activeSession.contextTokens
  const totN = activeSession.totalTokens
  /** 网关的 contextTokens/totalTokens 未必是「已用/上限」；仅当分母 ≥ 分子时百分比才有意义 */
  const tokenLine =
    contextTokenLabel && totalTokenLabel
      ? typeof ctxN === 'number' &&
          typeof totN === 'number' &&
          totN > 0 &&
          ctxN <= totN
        ? `tokens ${contextTokenLabel}/${totalTokenLabel} (${Math.round((ctxN / totN) * 100)}%)`
        : `tokens ctx ${contextTokenLabel} · ${totalTokenLabel}`
      : totalTokenLabel
        ? `tokens ${totalTokenLabel}`
        : undefined

  const statusToneClass =
    state.toolActivityStatus === 'failed'
      ? 'error'
      : state.toolActivityStatus === 'completed'
        ? 'active'
        : state.toolActivityStatus === 'running'
          ? 'busy'
          : 'idle'

  const sessionMeta = [
    activeSession.model ? `${activeSession.modelProvider ? `${activeSession.modelProvider}/` : ''}${activeSession.model}` : undefined,
    'agent main',
    'think low',
    'verbose on',
    tokenLine,
    state.lastRunDurationMs ? `last ${formatDuration(state.lastRunDurationMs)}` : undefined,
  ]
    .filter(Boolean)
    .join(' | ')

  const visibleMessages = messages

  const awaitingAssistantReply =
    state.sendStatus === 'sending' ||
    state.sendStatus === 'queued' ||
    state.sendStatus === 'waiting-response' ||
    (state.sendStatus === 'completed' && modelSideStreaming)

  let lastUserMessageIndex = -1
  visibleMessages.forEach((m, i) => {
    if (isUserFacingRole(m.role, m.kind)) lastUserMessageIndex = i
  })
  const lastRunningIndex = visibleMessages.map((m) => m.runStatus).lastIndexOf('running')
  const anyRunningInThread = lastRunningIndex >= 0

  /** 与 waitElapsedMs 的 effect 一致：有进行中的轮次时在输入框状态栏显示计时 */
  const runTimerVisible =
    Boolean(state.currentRunStartedAt) &&
    state.sendStatus !== 'idle' &&
    state.sendStatus !== 'error' &&
    state.sendStatus !== 'stopped' &&
    !(state.sendStatus === 'completed' && !modelSideStreaming)

  useEffect(() => {
    const runFinished =
      !state.currentRunStartedAt ||
      state.sendStatus === 'idle' ||
      state.sendStatus === 'error' ||
      state.sendStatus === 'stopped' ||
      (state.sendStatus === 'completed' && !modelSideStreaming)

    if (runFinished) {
      setWaitElapsedMs(0)
      return
    }

    const tick = () => {
      setWaitElapsedMs(Math.max(0, Date.now() - state.currentRunStartedAt!))
    }

    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [state.currentRunStartedAt, state.sendStatus, modelSideStreaming])
  useEffect(() => {
    const node = messageListRef.current
    if (!node) return

    const forceScrollToBottom = () => {
      requestAnimationFrame(() => {
        const nextNode = messageListRef.current
        if (!nextNode) return
        nextNode.scrollTop = nextNode.scrollHeight
        requestAnimationFrame(() => {
          const finalNode = messageListRef.current
          if (!finalNode) return
          finalNode.scrollTop = finalNode.scrollHeight
        })
      })
    }

    if (previousSessionIdRef.current !== activeSession.id) {
      previousSessionIdRef.current = activeSession.id
      shouldStickToBottomRef.current = true
      setShowJumpToBottom(false)
      forceScrollToBottom()
      return
    }

    if (state.historyStatus === 'ready' && shouldStickToBottomRef.current) {
      forceScrollToBottom()
      return
    }

    if (!shouldStickToBottomRef.current) return

    forceScrollToBottom()
  }, [activeSession.id, messages, state.historyStatus])

  /** 同帧内先出 Assistant 再插入 Verbose 时，仅靠 useEffect 可能早于子节点高度提交；layout 后再滚到底 */
  useLayoutEffect(() => {
    const node = messageListRef.current
    if (!node || !shouldStickToBottomRef.current) return
    if (previousSessionIdRef.current !== activeSession.id) return
    node.scrollTop = node.scrollHeight
  }, [messages, activeSession.id])

  useEffect(() => {
    const el = messageListRef.current
    if (!el) return
    let raf = 0
    const scrollIfSticking = () => {
      if (!shouldStickToBottomRef.current) return
      const node = messageListRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
    }
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        scrollIfSticking()
      })
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
    }
  }, [activeSession.id])

  function handleMessageListScroll() {
    const node = messageListRef.current
    if (!node) return

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    const nearBottom = distanceFromBottom < 96
    shouldStickToBottomRef.current = nearBottom
    setShowJumpToBottom(!nearBottom)
  }

  function jumpToBottom() {
    const node = messageListRef.current
    if (!node) return

    shouldStickToBottomRef.current = true
    setShowJumpToBottom(false)
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void sendCurrentMessage(false)
    }
  }

  return (
    <main className="console-page">
      <header className="topbar">
        <div>
          <div className="eyebrow">OpenClaw Console</div>
          <h1>Web UI MVP</h1>
        </div>

        <div className="topbar-statuses">
          <span className={`status-pill ${getConnectionPillClass(state.connectionStatus)}`}>
            {state.connectionStatus}
          </span>
          <span className="status-pill dark">Dan-MacBook</span>
          {state.toolActivityStatus !== 'idle' && (
            <span
              className={`status-pill ${state.toolActivityStatus === 'failed' ? 'danger' : state.toolActivityStatus === 'completed' ? 'success' : state.toolActivityStatus === 'stopped' ? 'dark' : 'info'}`}
            >
              {runtimeBadge}
            </span>
          )}
          <button className="secondary-button" onClick={toggleSettings}>
            Settings
          </button>
        </div>
      </header>

      <section
        className={`console-grid ${state.isLeftSidebarCollapsed ? 'left-collapsed' : ''} ${state.isRightSidebarCollapsed ? 'right-collapsed' : ''}`}
      >
        {!state.isLeftSidebarCollapsed && (
          <aside className="panel sidebar-panel">
            <div className="panel-header compact-sidebar-header">
              <div className="sidebar-panel-title">
                <h2>Sessions</h2>
              </div>
              <div className="panel-header-actions sidebar-panel-toolbar">
                <button type="button" className="icon-button sidebar-icon-btn" onClick={toggleLeftSidebar} title="收起列表">
                  ◀
                </button>
                <button type="button" className="icon-button sidebar-icon-btn" onClick={refreshHistory} title="刷新历史">
                  ↻
                </button>
                <button
                  type="button"
                  className="icon-button sidebar-icon-btn"
                  title="新建会话"
                  onClick={async () => {
                    const nextName = window.prompt('Session name')?.trim()
                    if (!nextName) return
                    await createNewSession(nextName)
                  }}
                >
                  ＋
                </button>
              </div>
            </div>

            <div className="session-list compact-session-list">
              {filteredSessions.map((session) => (
                <article
                  key={session.id}
                  className={`session-card ${session.id === activeSession.id ? 'active' : ''}`}
                  onClick={() => selectSession(session.id)}
                >
                  <div className="session-card-body">
                    <h3
                      className="session-title"
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        void renameSessionTitle(session.id)
                      }}
                      title="Double click to rename"
                    >
                      {session.summary}
                    </h3>
                    <p className="session-subtitle">{`${session.subtitle || 'session'} · ${formatRelativeTime(session.updatedAt)}`}</p>
                  </div>
                  <div className="session-card-actions">
                    <span className={`mini-state ${session.state}`}>{session.state}</span>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        )}

        <section
          className={`panel chat-panel${state.isLeftSidebarCollapsed ? ' chat-panel--sessions-collapsed' : ''}`}
        >
          {state.isLeftSidebarCollapsed && (
            <button
              type="button"
              className="left-sidebar-edge-tab"
              onClick={toggleLeftSidebar}
              aria-label="展开会话列表"
              title="Sessions"
            >
              <span className="left-sidebar-edge-tab-icon" aria-hidden>
                ▶
              </span>
            </button>
          )}

          <div className="panel-header chat-header">
            <div className="chat-title-wrap">
              <h2>{activeSession.summary}</h2>
              <span className={`mini-state ${activeSession.state === 'error' ? 'error' : activeSession.state === 'busy' ? 'busy' : activeSession.state === 'active' ? 'active' : 'idle'}`}>
                {activeSession.state}
              </span>
            </div>
            <div className="chat-header-actions">
              {state.toolActivityStatus !== 'idle' && (
                <span
                  className={`mini-state ${state.toolActivityStatus === 'failed' ? 'error' : state.toolActivityStatus === 'completed' ? 'active' : state.toolActivityStatus === 'stopped' ? 'idle' : 'busy'}`}
                >
                  {state.toolActivityStatus}
                </span>
              )}
              {state.isRightSidebarCollapsed && (
                <button className="icon-button" onClick={toggleRightSidebar}>
                  Context ▶
                </button>
              )}
            </div>
          </div>

          <div ref={messageListRef} className="message-list" onScroll={handleMessageListScroll}>
            {state.historyStatus === 'loading-history' && visibleMessages.length === 0 && (
              <article className="message-card muted">
                <strong>Loading</strong>
                <p>正在加载当前 session 历史…</p>
              </article>
            )}

            {state.historyStatus === 'loading-history' && visibleMessages.length > 0 && (
              <article className="message-card muted">
                <p>历史同步中…</p>
              </article>
            )}

            {state.historyStatus === 'error' && messages.length === 0 && (
              <article className="message-card muted">
                <strong>Error</strong>
                <p>当前 session 历史加载失败。</p>
              </article>
            )}

            {(state.historyStatus === 'ready' ||
              (state.historyStatus === 'loading-history' && visibleMessages.length > 0)) &&
              visibleMessages.map((message, index) => {
                const isUser = isUserFacingRole(message.role, message.kind)
                const isVerbose = message.kind === 'verbose' || message.role === 'verbose' || message.content.includes('[thinking]') || message.content.includes('[reasoning]')
                const isTool = message.kind === 'toolCall' || message.kind === 'toolResult' || message.role === 'tool' || message.role === 'toolResult' || message.content.includes('[toolCall]') || message.content.includes('[toolResult]')
                const isAssistant = (message.kind === 'assistant' || message.role === 'assistant') && !isVerbose && !isTool
                const isSystem = message.role === 'system' || message.kind === 'system'
                const headerLabel = renderMessageHeaderLabel(message)
                const messageClass = isUser
                  ? 'user'
                  : isVerbose
                    ? 'verbose'
                    : isAssistant
                      ? 'assistant'
                      : isTool
                        ? 'tool'
                        : isSystem
                          ? 'system'
                          : 'muted'

                const isLatestRunningMessage =
                  message.runStatus === 'running' && index === lastRunningIndex
                /** queued 时尚无 running 气泡，用户消息已被标为 completed，计时挂最后一条用户消息上 */
                const showWaitTimerOnUserTail =
                  awaitingAssistantReply &&
                  !anyRunningInThread &&
                  isUser &&
                  index === lastUserMessageIndex &&
                  Boolean(state.currentRunStartedAt)
                const showStreamingTimer = isLatestRunningMessage || showWaitTimerOnUserTail

                return (
                  <article key={message.id} className={`message-row ${messageClass}`}>
                    <div className={`message-card ${messageClass} ${showStreamingTimer ? 'streaming' : ''}`}>
                      <div className="message-card-header">
                        <div className="message-card-header-main">
                          <strong>
                            {isUser
                              ? 'You'
                              : isVerbose
                                ? 'Verbose'
                                : isAssistant
                                  ? 'Assistant'
                                  : message.kind === 'toolResult' || message.role === 'toolResult'
                                    ? 'Tool Result'
                                    : isTool
                                      ? 'Tool Call'
                                      : isSystem
                                        ? 'System'
                                        : message.role}
                          </strong>
                          {headerLabel && <span className="message-header-label">{headerLabel}</span>}
                        </div>
                      </div>
                      <div
                        className="message-content markdown-content"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(message.content || '（空内容）'),
                        }}
                      />
                    </div>
                  </article>
                )
              })}
          </div>

          {showJumpToBottom && (
            <div className="jump-to-bottom-wrap">
              <button className="secondary-button jump-to-bottom-button" onClick={jumpToBottom}>
                回到底部
              </button>
            </div>
          )}

          <div className="composer">
            <div className="composer-header">
              <div className="composer-meta compact single-line">
                {state.composerError ? (
                  <>
                    <span className={`mini-state composer-state ${statusToneClass}`}>{state.sendStatus}</span>
                    {runTimerVisible && (
                      <span className="composer-elapsed" aria-live="polite">
                        {formatElapsed(waitElapsedMs)}
                      </span>
                    )}
                    <span className="composer-error">
                      {sessionMeta}
                      {` | error ${state.composerError}`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`mini-state composer-state ${statusToneClass}`}>{state.sendStatus}</span>
                    {runTimerVisible && (
                      <span className="composer-elapsed" aria-live="polite">
                        {formatElapsed(waitElapsedMs)}
                      </span>
                    )}
                    <span className="composer-hint">{sessionMeta}</span>
                  </>
                )}
              </div>
            </div>

            <div className="composer-row">
              <textarea
                className="composer-input"
                placeholder="在这里输入消息…"
                rows={3}
                value={currentDraft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
              />
              <button
                type="button"
                className={`${sendButton.className} composer-send-button`}
                onClick={() => void sendCurrentMessage(true)}
              >
                {sendButton.label}
              </button>
            </div>
          </div>
        </section>

        {!state.isRightSidebarCollapsed && (
          <aside className="panel context-panel">
            <div className="panel-header">
              <div>
                <h2>Context / Control</h2>
                <p>默认折叠，展开后承载轻控制能力</p>
              </div>
              <button className="icon-button" onClick={toggleRightSidebar}>
                ▶
              </button>
            </div>

            <div className="context-cards">
              {sideCards.map((card) => (
                <section key={card.title} className="context-card">
                  <h3>{card.title}</h3>
                  <ul>
                    {card.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </aside>
        )}
      </section>

      {state.isSettingsOpen && (
        <aside className="settings-drawer">
          <div className="settings-drawer-header">
            <div>
              <div className="eyebrow">Settings Drawer</div>
              <h2>Runtime / Config</h2>
            </div>
            <button className="icon-button" onClick={toggleSettings}>
              ×
            </button>
          </div>

          <section className="context-card">
            <h3>Runtime Overview</h3>
            <ul>
              <li>Host: Dan-MacBook</li>
              <li>Gateway: {state.connectionStatus}</li>
              <li>Realtime: {state.runtimeNote || 'n/a'}</li>
            </ul>
          </section>

          <section className="context-card">
            <h3>Config Placeholder</h3>
            <ul>
              <li>未来接 control adapter</li>
              <li>当前只保留入口与结构</li>
            </ul>
          </section>
        </aside>
      )}
    </main>
  )
}
