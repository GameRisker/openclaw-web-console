import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useAppState } from '../state/useAppState'
import { openclawWebLog } from '../state/debugLog'
import { isUserFacingRole } from '../utils/roles'
import type { ApiMessage } from '../types/api'

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

type MessageKindVariant = 'user' | 'assistant' | 'verbose' | 'toolCall' | 'toolResult' | 'system' | 'muted'

function messageKindVariantFromFlags(flags: {
  isUser: boolean
  isVerbose: boolean
  isToolResult: boolean
  isToolCall: boolean
  isAssistant: boolean
  isSystem: boolean
}): MessageKindVariant {
  if (flags.isUser) return 'user'
  if (flags.isVerbose) return 'verbose'
  if (flags.isToolResult) return 'toolResult'
  if (flags.isToolCall) return 'toolCall'
  if (flags.isAssistant) return 'assistant'
  if (flags.isSystem) return 'system'
  return 'muted'
}

function getMessageKindFlags(message: ApiMessage) {
  const isUser = isUserFacingRole(message.role, message.kind)
  const isVerbose =
    message.kind === 'verbose' ||
    message.role === 'verbose' ||
    message.content.includes('[thinking]') ||
    message.content.includes('[reasoning]')
  const isToolResult =
    message.kind === 'toolResult' || message.role === 'toolResult' || message.content.includes('[toolResult]')
  const isToolCall =
    !isToolResult &&
    (message.kind === 'toolCall' || message.role === 'tool' || message.content.includes('[toolCall]'))
  const isTool = isToolCall || isToolResult
  const isAssistant =
    (message.kind === 'assistant' || message.role === 'assistant') && !isVerbose && !isTool
  const isSystem = message.role === 'system' || message.kind === 'system'
  return { isUser, isVerbose, isToolResult, isToolCall, isTool, isAssistant, isSystem }
}

/** Verbose / Tool / System 等非正文行：挂在下一条 Assistant 气泡上展示图标 */
function variantForSidecarMessage(m: ApiMessage): MessageKindVariant {
  const f = getMessageKindFlags(m)
  return messageKindVariantFromFlags({
    isUser: false,
    isVerbose: f.isVerbose,
    isToolResult: f.isToolResult,
    isToolCall: f.isToolCall,
    isAssistant: false,
    isSystem: f.isSystem,
  })
}

type ThreadDisplayRow =
  | { kind: 'user'; message: ApiMessage }
  | { kind: 'assistant'; message: ApiMessage; sidecars: ApiMessage[] }
  | { kind: 'orphan-sidecars'; sidecars: ApiMessage[] }

/**
 * 按「用户消息」切段：每一段里，Verbose / Tool 等侧车**全部归到该段最后一条主 Assistant**，
 * 这样无论网关顺序是「思考→工具→正文」还是「正文→工具回写」，图标都在**本轮最终那条主回复气泡**里。
 */
function buildThreadDisplayList(messages: ApiMessage[]): ThreadDisplayRow[] {
  const rows: ThreadDisplayRow[] = []
  let i = 0

  while (i < messages.length) {
    const f = getMessageKindFlags(messages[i])
    if (f.isUser) {
      rows.push({ kind: 'user', message: messages[i] })
      i++
      continue
    }

    const segment: ApiMessage[] = []
    while (i < messages.length && !getMessageKindFlags(messages[i]).isUser) {
      segment.push(messages[i])
      i++
    }

    const assistantsInOrder = segment.filter((msg) => getMessageKindFlags(msg).isAssistant)
    const sidecars = segment.filter((msg) => !getMessageKindFlags(msg).isAssistant)

    if (assistantsInOrder.length === 0) {
      if (sidecars.length > 0) {
        rows.push({ kind: 'orphan-sidecars', sidecars })
      }
      continue
    }

    const lastAi = assistantsInOrder.length - 1
    for (let j = 0; j < assistantsInOrder.length; j++) {
      rows.push({
        kind: 'assistant',
        message: assistantsInOrder[j],
        sidecars: j === lastAi ? sidecars : [],
      })
    }
  }

  return rows
}

function messageKindPanelTitle(variant: MessageKindVariant, headerLabel: string | undefined): string {
  const h = headerLabel?.trim()
  switch (variant) {
    case 'user':
      return '用户消息'
    case 'assistant':
      return 'Assistant'
    case 'verbose':
      return h ? `Verbose · ${h}` : 'Verbose（思考/推理）'
    case 'toolCall':
      return h ? `Tool Call · ${h}` : 'Tool Call'
    case 'toolResult':
      return h ? `Tool Result · ${h}` : 'Tool Result'
    case 'system':
      return 'System'
    default:
      return '消息'
  }
}

function KindIcon({ variant }: { variant: MessageKindVariant }) {
  const svgProps = {
    className: 'message-kind-icon-svg',
    viewBox: '0 0 24 24' as const,
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  switch (variant) {
    case 'user':
      return (
        <svg {...svgProps}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )
    case 'assistant':
      return (
        <svg {...svgProps}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'verbose':
      return (
        <svg {...svgProps}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      )
    case 'toolCall':
      return (
        <svg {...svgProps}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
    case 'toolResult':
      return (
        <svg {...svgProps}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    case 'system':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      )
    default:
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="10" />
        </svg>
      )
  }
}

function MessageKindIconBadge({
  variant,
  panelTitle,
  bodyText,
}: {
  variant: MessageKindVariant
  panelTitle: string
  bodyText: string
}) {
  const text = bodyText.trim() || '（空内容）'
  return (
    <div className="message-kind-badge">
      <button type="button" className="message-kind-badge-trigger" aria-label={`类型与全文：${panelTitle}`}>
        <KindIcon variant={variant} />
      </button>
      <div className="message-kind-badge-panel" role="tooltip">
        <div className="message-kind-badge-panel-title">{panelTitle}</div>
        <pre className="message-kind-badge-panel-body">{text}</pre>
      </div>
    </div>
  )
}

function MessageKindIconStrip({ sidecars, embedded }: { sidecars: ApiMessage[]; embedded?: boolean }) {
  if (sidecars.length === 0) return null
  return (
    <div className={embedded ? 'message-kind-strip message-kind-strip--embedded' : 'message-kind-strip'}>
      {sidecars.map((sm) => {
        const v = variantForSidecarMessage(sm)
        const hl = renderMessageHeaderLabel(sm)
        return (
          <MessageKindIconBadge
            key={sm.id}
            variant={v}
            panelTitle={messageKindPanelTitle(v, hl)}
            bodyText={sm.content ?? ''}
          />
        )
      })}
    </div>
  )
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

function toMessageTimeMs(ts?: string): number {
  if (!ts) return 0
  const numeric = Number(ts)
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric < 1e12) return Math.round(numeric * 1000)
    return Math.round(numeric)
  }
  const parsed = Date.parse(String(ts))
  return Number.isFinite(parsed) ? parsed : 0
}

/** 气泡内轻量时间：今天仅 HH:mm；非今天带月日 + 时间，跨年再加年份 */
function formatMessageTimeMeta(timestamp?: string): { label: string; iso: string; title: string } | null {
  const ms = toMessageTimeMs(timestamp)
  if (ms <= 0) return null
  const d = new Date(ms)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const mon = d.getMonth() + 1
  const day = d.getDate()
  const y = d.getFullYear()
  let label: string
  if (sameDay) {
    label = hm
  } else if (y === now.getFullYear()) {
    label = `${mon}月${day}日 ${hm}`
  } else {
    label = `${y}年${mon}月${day}日 ${hm}`
  }
  const title = d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  return { label, iso: d.toISOString(), title }
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
    loadOlderHistory,
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

  const threadDisplayRows = useMemo(() => buildThreadDisplayList(visibleMessages), [visibleMessages])

  const { lastUserMessageId, lastRunningMessageId } = useMemo(() => {
    let u: string | undefined
    let r: string | undefined
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]
      if (u === undefined && isUserFacingRole(m.role, m.kind)) u = m.id
      if (r === undefined && m.runStatus === 'running') r = m.id
      if (u !== undefined && r !== undefined) break
    }
    return { lastUserMessageId: u, lastRunningMessageId: r }
  }, [visibleMessages])

  const anyRunningInThread = lastRunningMessageId != null

  const awaitingAssistantReply =
    state.sendStatus === 'sending' ||
    state.sendStatus === 'queued' ||
    state.sendStatus === 'waiting-response' ||
    (state.sendStatus === 'completed' && modelSideStreaming)

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

  /** 仅点击加载更早；prepend 后一次性修正 scrollTop，避免 smooth 导致滚动条晃动 */
  function handleLoadOlderClick() {
    if (!state.historyHasMore || state.historyStatus !== 'ready') {
      openclawWebLog('loadOlder click blocked', {
        historyHasMore: state.historyHasMore,
        historyStatus: state.historyStatus,
      })
      return
    }
    openclawWebLog('loadOlder click → fetch')
    const list = messageListRef.current
    const prevScrollHeight = list?.scrollHeight ?? 0
    const prevScrollTop = list?.scrollTop ?? 0
    void loadOlderHistory().then(() => {
      requestAnimationFrame(() => {
        const n = messageListRef.current
        if (!n) return
        const delta = n.scrollHeight - prevScrollHeight
        if (delta <= 0) return
        n.classList.add('message-list--instant-scroll')
        n.scrollTop = prevScrollTop + delta
        requestAnimationFrame(() => {
          n.classList.remove('message-list--instant-scroll')
        })
      })
    })
  }

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

          <div className="chat-messages-stack">
            <div ref={messageListRef} className="message-list" onScroll={handleMessageListScroll}>
            {(state.historyHasMore || state.historyLoadingOlder) && (
              <button
                type="button"
                className="message-list-history-hint"
                aria-live="polite"
                aria-busy={state.historyLoadingOlder}
                disabled={state.historyLoadingOlder || !state.historyHasMore}
                onClick={() => handleLoadOlderClick()}
              >
                {state.historyLoadingOlder ? (
                  <>
                    加载更早消息
                    <span className="message-list-history-hint-dots" aria-hidden="true">
                      <span className="message-list-history-hint-dot">.</span>
                      <span className="message-list-history-hint-dot">.</span>
                      <span className="message-list-history-hint-dot">.</span>
                    </span>
                  </>
                ) : (
                  '点击加载更早记录'
                )}
              </button>
            )}

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
              threadDisplayRows.map((row) => {
                if (row.kind === 'orphan-sidecars') {
                  return (
                    <article
                      key={`orphan-${row.sidecars.map((s) => s.id).join('·')}`}
                      className="message-row message-row--orphan-sidecars assistant"
                    >
                      <div className="message-card assistant message-card--orphan-icons-only">
                        <MessageKindIconStrip sidecars={row.sidecars} embedded />
                      </div>
                    </article>
                  )
                }

                const message = row.message
                const isUser = row.kind === 'user'
                const messageClass = isUser ? 'user' : 'assistant'
                const headerLabel = renderMessageHeaderLabel(message)
                const messageTimeMeta = formatMessageTimeMeta(message.timestamp)

                const isLatestRunningMessage =
                  message.runStatus === 'running' && message.id === lastRunningMessageId
                const showWaitTimerOnUserTail =
                  awaitingAssistantReply &&
                  !anyRunningInThread &&
                  isUser &&
                  message.id === lastUserMessageId &&
                  Boolean(state.currentRunStartedAt)
                const showStreamingTimer = isLatestRunningMessage || showWaitTimerOnUserTail

                return (
                  <article key={message.id} className={`message-row ${messageClass}`}>
                    <div className={`message-card ${messageClass} ${showStreamingTimer ? 'streaming' : ''}`}>
                      <div className="message-card-header">
                        <div className="message-card-header-main">
                          <strong>{isUser ? 'You' : 'Assistant'}</strong>
                          {headerLabel && <span className="message-header-label">{headerLabel}</span>}
                        </div>
                        {messageTimeMeta && (
                          <time
                            className="message-card-time"
                            dateTime={messageTimeMeta.iso}
                            title={messageTimeMeta.title}
                          >
                            {messageTimeMeta.label}
                          </time>
                        )}
                      </div>
                      <div
                        className="message-content markdown-content"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(message.content || '（空内容）'),
                        }}
                      />
                      {!isUser && row.kind === 'assistant' && (
                        <MessageKindIconStrip sidecars={row.sidecars} embedded />
                      )}
                    </div>
                  </article>
                )
              })}
            </div>

            {showJumpToBottom && (
              <button
                type="button"
                className="jump-to-bottom-fab"
                onClick={jumpToBottom}
                aria-label="回到底部"
                title="回到底部"
              >
                <svg className="jump-to-bottom-fab-icon" viewBox="0 0 24 24" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M12 15.5c-.2 0-.4-.1-.5-.2l-4.5-4.5c-.3-.3-.3-.8 0-1.1s.8-.3 1.1 0l3.9 3.9 3.9-3.9c.3-.3.8-.3 1.1 0s.3.8 0 1.1l-4.5 4.5c-.2.1-.4.2-.5.2z"
                  />
                </svg>
              </button>
            )}
          </div>

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
