import { useEffect, useMemo, useRef, useState } from 'react'
import {
  abortSessionRun,
  createSession,
  deleteSession,
  fetchSessionHistory,
  fetchSessions,
  fetchStatus,
  renameSession,
  sendSessionMessage,
} from './api'
import { mockSideCards, mockSessions } from './mockData'
import { connectRealtime } from './realtime'
import { openclawWebLog } from './debugLog'
import type { RealtimeEvent, ApiMessage, TimelineRenderItem, TimelineEventItem } from '../types/api'
import type { AppState, SessionItem } from '../types/app'
import { isUserFacingRole, timelineItemLooksLikeUserMessage } from '../utils/roles'
import { HISTORY_FETCH_MAX, HISTORY_OLDER_STEP, HISTORY_PAGE_SIZE } from '../constants/history'

const initialState: AppState = {
  authStatus: 'authenticated',
  connectionStatus: 'connecting',
  sessionListStatus: 'loading',
  activeSessionId: 'main',
  historyHasMore: false,
  historyLoadingOlder: false,
  historyStatus: 'loading-history',
  sendStatus: 'idle',
  toolActivityStatus: 'idle',
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: true,
  isSettingsOpen: false,
  sessionSearch: '',
  draftBySession: {
    main: '',
  },
  composerError: undefined,
  runtimeNote: 'booting',
  currentRunStartedAt: undefined,
  lastRunDurationMs: undefined,
}

function mapSessionState(raw: string): SessionItem['state'] {
  if (raw === 'active') return 'active'
  if (raw === 'busy') return 'busy'
  if (raw === 'error') return 'error'
  return 'idle'
}

function sortSessionsByRecent(a: SessionItem, b: SessionItem) {
  const updatedDiff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  if (updatedDiff !== 0) return updatedDiff
  const ageDiff = (a.ageMs ?? Number.MAX_SAFE_INTEGER) - (b.ageMs ?? Number.MAX_SAFE_INTEGER)
  if (ageDiff !== 0) return ageDiff
  return a.summary.localeCompare(b.summary)
}

function touchSessionState(
  sessions: SessionItem[],
  sessionId: string,
  state: SessionItem['state'],
): SessionItem[] {
  return sessions
    .map((session): SessionItem => {
      if (session.id === sessionId) return { ...session, state, updatedAt: Date.now() }
      if (state === 'active' && session.state === 'active') return { ...session, state: 'idle' as SessionItem['state'] }
      return session
    })
    .sort(sortSessionsByRecent)
}

function toTimestampMs(value?: string) {
  if (!value) return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric < 1e12) return Math.round(numeric * 1000)
    return numeric
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

/** Compare user-visible text loosely (trim, CRLF, per-line spaces) so gateway echoes still match optimistic sends. */
function normalizeUserContentForMatch(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .trim()
}

function userMessageContentMatches(a: string, b: string): boolean {
  return normalizeUserContentForMatch(a) === normalizeUserContentForMatch(b)
}

function inferKind(message: ApiMessage): TimelineRenderItem['kind'] {
  if (message.kind === 'toolCall' || message.role === 'tool' || /^\[toolCall\]\s*/i.test(message.content)) return 'toolCall'
  if (message.kind === 'toolResult' || message.role === 'toolResult' || /^\[toolResult\]\s*/i.test(message.content)) return 'toolResult'
  if (message.kind === 'verbose' || message.role === 'verbose' || /^\[(thinking|reasoning)\]\s*/i.test(message.content)) return 'verbose'
  if (isUserFacingRole(message.role, message.kind)) return 'user'
  if (message.role === 'system' || message.kind === 'system') return 'system'
  return 'assistant'
}

/** Gateway may use completed/done/etc. instead of `final`; align with bridge canonicalization. */
function classifyChatEventState(raw: string | undefined): 'final' | 'error' | 'delta' {
  if (raw == null || raw === '') return 'delta'
  const s = String(raw).toLowerCase().replace(/-/g, '_')
  if (['final', 'complete', 'completed', 'done', 'success', 'finished', 'end', 'ok'].includes(s)) return 'final'
  if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(s)) return 'error'
  return 'delta'
}

/**
 * After history refresh: if we're still queued/waiting but the last user turn already has a non-running
 * assistant reply, treat the run as settled (WS final/run.completed may never arrive for some gateways).
 */
function historyShowsTurnSettled(messages: ApiMessage[]): boolean {
  if (messages.length === 0) return false
  const sorted = [...messages].sort((a, b) => {
    const d = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp)
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
  })
  let lastUserIdx = -1
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isUserFacingRole(sorted[i].role, sorted[i].kind)) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return false
  const afterUser = sorted.slice(lastUserIdx + 1)
  if (afterUser.length === 0) return false
  if (afterUser.some((m) => m.runStatus === 'running')) return false
  return afterUser.some(
    (m) => inferKind(m) === 'assistant' && String(m.content ?? '').trim().length > 0,
  )
}

function reconcileSendStatusAfterHistory(prev: AppState, messages: ApiMessage[]): AppState {
  if (prev.sendStatus !== 'queued' && prev.sendStatus !== 'waiting-response') return prev
  if (messages.some((m) => m.runStatus === 'running')) return prev
  if (!historyShowsTurnSettled(messages)) return prev
  return {
    ...prev,
    sendStatus: 'completed',
    toolActivityStatus: 'completed',
    runtimeNote: 'completed',
    currentRunStartedAt: undefined,
    lastRunDurationMs: prev.currentRunStartedAt
      ? Math.max(0, Date.now() - prev.currentRunStartedAt)
      : prev.lastRunDurationMs,
  }
}

/** Timeline row may carry terminal `status` while upsert omits `runStatus` (bridge/gateway quirks). */
function reconcileSendStatusFromAssistantRenderItem(
  prev: AppState,
  ri: TimelineRenderItem | undefined,
): AppState {
  if (!ri) return prev
  if (ri.kind !== 'assistant') return prev
  if (ri.status !== 'completed' && ri.status !== 'failed' && ri.status !== 'stopped') return prev
  if (
    prev.sendStatus !== 'waiting-response' &&
    prev.sendStatus !== 'queued' &&
    prev.sendStatus !== 'sending'
  ) {
    return prev
  }
  const done = ri.status === 'completed'
  return {
    ...prev,
    sendStatus: ri.status === 'failed' ? 'error' : ri.status === 'stopped' ? 'stopped' : 'completed',
    toolActivityStatus: ri.status === 'failed' ? 'failed' : ri.status === 'stopped' ? 'stopped' : 'completed',
    runtimeNote:
      ri.status === 'failed' ? 'run failed' : ri.status === 'stopped' ? 'stopped' : 'completed',
    ...(done
      ? {}
      : {
          currentRunStartedAt: undefined,
          lastRunDurationMs: prev.currentRunStartedAt
            ? Math.max(0, Date.now() - prev.currentRunStartedAt)
            : prev.lastRunDurationMs,
        }),
  }
}

function toRenderItemsFromMessages(messages: ApiMessage[], sessionId: string): TimelineRenderItem[] {
  return messages.map((message) => {
    const kind = inferKind(message)
    return {
      id: message.id,
      sessionId,
      kind,
      status: message.runStatus,
      title:
        kind === 'toolCall'
          ? message.label ? `Tool Call · ${message.label}` : 'Tool Call'
          : kind === 'toolResult'
            ? message.label ? `Tool Result · ${message.label}` : 'Tool Result'
            : kind === 'verbose'
              ? message.label || 'Verbose'
              : kind === 'user'
                ? 'You'
                : kind === 'system'
                  ? 'System'
                  : 'Assistant',
      content:
        kind === 'toolCall'
          ? message.content.replace(/^\[toolCall\]\s*/i, '')
          : kind === 'toolResult'
            ? message.content.replace(/^\[toolResult\]\s*/i, '')
            : kind === 'verbose'
              ? message.content.replace(/^\[(thinking|reasoning)\]\s*/i, '')
              : message.content,
      label: message.label,
      toolName: message.toolName,
      timestamp: message.timestamp,
    }
  })
}

/**
 * Keep optimistic user bubbles that the server/API has not echoed yet.
 * Only considers pending rows for the same session (avoids leaking across session switch).
 */
function mergeSnapshotRenderItems(
  incoming: TimelineRenderItem[],
  previous: TimelineRenderItem[],
  sessionId: string,
): TimelineRenderItem[] {
  const sameSession = (inc: TimelineRenderItem) => !inc.sessionId || inc.sessionId === sessionId

  /** Only drop optimistic when the server echo is plausibly the same turn (avoid matching old user lines with same text). */
  const serverEchoedOptimistic = (item: TimelineRenderItem, inc: TimelineRenderItem) => {
    if (!sameSession(inc)) return false
    if (!timelineItemLooksLikeUserMessage(inc)) return false
    if (!userMessageContentMatches(inc.content, item.content)) return false
    const optMs = toTimestampMs(item.timestamp)
    const incMs = toTimestampMs(inc.timestamp)
    if (optMs > 0 && incMs > 0) {
      return incMs >= optMs - 120_000
    }
    // 任一侧时间戳缺失时仍视为已回显，否则乐观气泡会与服务端用户行并存（双份 You）
    return true
  }

  const pending = previous.filter((item) => {
    if (item.sessionId !== sessionId) return false
    if (!String(item.id).startsWith('local-user-')) return false
    if (!timelineItemLooksLikeUserMessage(item)) return false
    return !incoming.some((inc) => serverEchoedOptimistic(item, inc))
  })
  if (pending.length === 0) return incoming
  return [...incoming, ...pending].sort((a, b) => {
    const diff = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp)
    return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id))
  })
}

function normalizeMessages(messages: ApiMessage[]) {
  const deduped: ApiMessage[] = []
  const exactSeen = new Set<string>()

  for (const message of messages) {
    const exactKey = `${message.role}|${message.timestamp}|${message.content}|${message.runStatus ?? ''}`
    if (exactSeen.has(exactKey)) continue
    exactSeen.add(exactKey)
    deduped.push(message)
  }

  const withoutOptimisticDuplicates = deduped.filter((message, _index, all) => {
    if (!message.id.startsWith('local-user-')) return true
    return !all.some(
      (other) =>
        other.id !== message.id &&
        !other.id.startsWith('local-user-') &&
        isUserFacingRole(other.role, other.kind) &&
        userMessageContentMatches(other.content, message.content),
    )
  })

  const merged: ApiMessage[] = []
  for (const message of withoutOptimisticDuplicates) {
    const previous = merged[merged.length - 1]
    const sameRenderableMessage =
      previous &&
      previous.role === message.role &&
      previous.content === message.content &&
      previous.timestamp === message.timestamp

    if (sameRenderableMessage) {
      merged[merged.length - 1] = {
        ...previous,
        ...message,
        runStatus:
          message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'stopped'
            ? message.runStatus
            : previous.runStatus,
      }
      continue
    }

    merged.push(message)
  }

  return merged
}

/** merge 后补 normalize：去掉已与网关回显重合的 local-user（指纹合并认不出「同句不同时间戳」） */
function finalizeMergedMessages(merged: ApiMessage[]): ApiMessage[] {
  return sortMessagesChronological(normalizeMessages(merged))
}

function sortMessagesChronological(messages: ApiMessage[]): ApiMessage[] {
  return [...messages].sort(
    (a, b) =>
      toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp) || String(a.id).localeCompare(String(b.id)),
  )
}

/** 时间用毫秒；不含 runStatus，避免 API 与 WS 对同一条状态字段不一致导致无法合并 */
function messageFingerprint(m: ApiMessage): string {
  return `${m.role}|${toTimestampMs(m.timestamp)}|${m.content}`
}

function pickBetterHistoryDuplicate(
  a: ApiMessage,
  b: ApiMessage,
  incomingIds: Set<string>,
): ApiMessage {
  const inA = incomingIds.has(a.id)
  const inB = incomingIds.has(b.id)
  if (inA && !inB) return a
  if (inB && !inA) return b
  const rank = (x: ApiMessage) => (String(x.id).startsWith('local-user-') ? 0 : 1)
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b
  return String(a.id).localeCompare(String(b.id)) <= 0 ? a : b
}

function mergeMessagesUniqueChronological(existing: ApiMessage[], incoming: ApiMessage[]): ApiMessage[] {
  const incomingIds = new Set(incoming.map((m) => m.id))
  const byId = new Map<string, ApiMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  const combined = Array.from(byId.values())
  const byFp = new Map<string, ApiMessage>()
  for (const m of combined) {
    const fp = messageFingerprint(m)
    const prev = byFp.get(fp)
    if (!prev) {
      byFp.set(fp, m)
      continue
    }
    byFp.set(fp, pickBetterHistoryDuplicate(prev, m, incomingIds))
  }
  return sortMessagesChronological(Array.from(byFp.values()))
}

/**
 * 历史分页/合并用：与列表展示一致优先用 `messages`（AppShell 只渲染 messages），避免与 renderItems 里
 * 另一条 id 体系拼在一起变双份；仅当尚未灌入 messages 时才用时间线快照。
 */
function getHistoryMergeBase(renderItems: TimelineRenderItem[], messages: ApiMessage[]): ApiMessage[] {
  if (messages.length > 0) return messages
  return renderItems.length > 0 ? timelineRenderItemsToApiMessages(renderItems) : []
}

/** 与页面 displayMessages 一致；WS timeline 只更新 renderItems 时 messages 可能空，分页/合并必须以本快照为基准 */
function timelineRenderItemsToApiMessages(items: TimelineRenderItem[]): ApiMessage[] {
  return [...items]
    .sort(
      (a, b) =>
        toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp) || String(a.id).localeCompare(String(b.id)),
    )
    .map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      role:
        item.kind === 'toolCall'
          ? 'tool'
          : item.kind === 'toolResult'
            ? 'toolResult'
            : item.kind === 'verbose'
              ? 'verbose'
              : timelineItemLooksLikeUserMessage(item)
                ? 'user'
                : (item.kind as string) === 'text'
                  ? 'assistant'
                  : item.kind,
      content:
        item.kind === 'toolCall'
          ? item.content.replace(/^\[toolCall\]\s*/i, '')
          : item.kind === 'toolResult'
            ? item.content.replace(/^\[toolResult\]\s*/i, '')
            : item.content,
      kind: timelineItemLooksLikeUserMessage(item) ? 'user' : item.kind,
      label: item.label,
      toolName: item.toolName,
      runStatus: item.status,
    }))
}

function getDisplayMessagesSnapshot(renderItems: TimelineRenderItem[], messages: ApiMessage[]): ApiMessage[] {
  return renderItems.length > 0 ? timelineRenderItemsToApiMessages(renderItems) : messages
}

export function useAppState() {
  const [state, setState] = useState<AppState>(initialState)
  const [sessions, setSessions] = useState<SessionItem[]>(mockSessions)
  const [messages, setMessages] = useState<ApiMessage[]>([])
  const [_timelineEvents, setTimelineEvents] = useState<TimelineEventItem[]>([])
  const [renderItems, setRenderItems] = useState<TimelineRenderItem[]>([])
  const [statusSummary, setStatusSummary] = useState<string[]>(mockSideCards[1].items)
  const realtimeRef = useRef<ReturnType<typeof connectRealtime> | null>(null)
  const activeSessionIdRef = useRef(state.activeSessionId)
  const messagesRef = useRef<ApiMessage[]>([])
  const renderItemsRef = useRef<TimelineRenderItem[]>([])
  const refreshHistoryTimerRef = useRef<number | null>(null)
  /** 用于区分「换会话」与 effect 因 sessionList 等重复触发，避免误清空列表 */
  const prevHistorySessionIdRef = useRef<string | null>(null)
  const historyHasMoreRef = useRef(false)
  const historyLoadingOlderRef = useRef(false)
  const queuedFallbackTimerRef = useRef<number | null>(null)
  const sendAbortControllerRef = useRef<AbortController | null>(null)
  const autoTitledSessionIdsRef = useRef<Set<string>>(new Set())
  const manuallyTitledSessionIdsRef = useRef<Set<string>>(new Set())
  const sessionsRef = useRef<SessionItem[]>(sessions)

  /**
   * 与 state 同步 ref 必须在 render 内完成（勿仅靠 useEffect），否则 paint 后、effect 前用户点击
   * 「加载更早」会读到空 ref → oldestId 为空 → 直接 return 并误关 hasMore。
   */
  sessionsRef.current = sessions
  activeSessionIdRef.current = state.activeSessionId
  messagesRef.current = messages
  renderItemsRef.current = renderItems
  historyHasMoreRef.current = state.historyHasMore

  useEffect(() => {
    if (state.sendStatus === 'queued') return
    if (queuedFallbackTimerRef.current != null) {
      window.clearTimeout(queuedFallbackTimerRef.current)
      queuedFallbackTimerRef.current = null
    }
  }, [state.sendStatus])

  useEffect(() => {
    return () => {
      if (queuedFallbackTimerRef.current != null) {
        window.clearTimeout(queuedFallbackTimerRef.current)
        queuedFallbackTimerRef.current = null
      }
    }
  }, [])

  async function refreshSessions(preferredSessionId?: string) {
    const sessionsResult = await fetchSessions()
    const mappedSessions = sessionsResult.sessions
      .map((session) => ({
        id: session.sessionId,
        key: session.key,
        summary:
          session.label?.trim() ||
          session.displayName?.trim() ||
          `${session.modelProvider ?? 'provider'} / ${session.model ?? 'model'}`,
        subtitle:
          [session.modelProvider, session.model].filter(Boolean).join('/') || session.displayName?.trim() || session.key,
        state: mapSessionState('idle'),
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : toTimestampMs(String(session.updatedAt ?? '')),
        ageMs: session.ageMs,
        model: session.model,
        modelProvider: session.modelProvider,
        totalTokens: session.totalTokens,
        contextTokens: session.contextTokens,
        kind: session.kind,
      }))
      .sort(sortSessionsByRecent)

    const nextActiveId =
      preferredSessionId && mappedSessions.some((session) => session.id === preferredSessionId)
        ? preferredSessionId
        : mappedSessions[0]?.id ?? state.activeSessionId

    const normalizedSessions = mappedSessions.map((session) => ({
      ...session,
      state: session.id === nextActiveId ? mapSessionState('active') : session.state,
    }))

    setSessions(normalizedSessions.length ? normalizedSessions : mockSessions)
    setState((prev) => ({
      ...prev,
      sessionListStatus: normalizedSessions.length ? 'loaded' : 'empty',
      activeSessionId: nextActiveId,
    }))

    return normalizedSessions
  }

  async function refreshHistory(sessionId: string, mode: 'replace' | 'merge-tail' = 'replace') {
    if (mode === 'replace') {
      setState((prev) => ({
        ...prev,
        historyStatus: 'loading-history',
        historyLoadingOlder: false,
      }))
    }

    try {
      const history = await fetchSessionHistory(sessionId, { limit: HISTORY_PAGE_SIZE })
      if (activeSessionIdRef.current !== sessionId) return

      const normalized = normalizeMessages(history.messages)
      const tailHasMore = history.hasMore ?? normalized.length >= HISTORY_PAGE_SIZE

      const snapshot = getHistoryMergeBase(renderItemsRef.current, messagesRef.current)
      if (mode === 'merge-tail' && snapshot.length > 0) {
        const merged = mergeMessagesUniqueChronological(snapshot, normalized)
        const final = finalizeMergedMessages(merged)
        const renderMerged = toRenderItemsFromMessages(final, sessionId)
        setMessages(final)
        setRenderItems((prev) => mergeSnapshotRenderItems(renderMerged, prev, sessionId))
        setState((prev) => {
          const next = reconcileSendStatusAfterHistory({ ...prev, historyStatus: 'ready' }, final)
          return {
            ...next,
            composerError: undefined,
            historyHasMore: prev.historyHasMore || tailHasMore,
          }
        })
        return
      }

      setMessages(normalized)
      setRenderItems((prev) =>
        mergeSnapshotRenderItems(toRenderItemsFromMessages(normalized, sessionId), prev, sessionId),
      )
      setState((prev) => {
        const next = reconcileSendStatusAfterHistory({ ...prev, historyStatus: 'ready' }, normalized)
        return {
          ...next,
          composerError: undefined,
          historyHasMore: tailHasMore,
        }
      })
    } catch {
      if (activeSessionIdRef.current !== sessionId) return
      if (mode === 'replace') {
        setMessages([])
        setRenderItems([])
        setState((prev) => ({
          ...prev,
          historyStatus: 'error',
          historyHasMore: false,
        }))
      } else {
        setState((prev) => ({ ...prev, historyStatus: 'ready' }))
      }
    }
  }

  function scheduleHistoryRefresh(sessionId: string, delay = 80, mode: 'replace' | 'merge-tail' = 'replace') {
    if (refreshHistoryTimerRef.current) {
      window.clearTimeout(refreshHistoryTimerRef.current)
    }
    refreshHistoryTimerRef.current = window.setTimeout(() => {
      refreshHistoryTimerRef.current = null
      void refreshHistory(sessionId, mode)
    }, delay)
  }

  function getOldestIdForHistoryPagination(): string | undefined {
    const base = getHistoryMergeBase(renderItemsRef.current, messagesRef.current)
    const sorted = sortMessagesChronological(base)
    return sorted[0]?.id
  }

  async function loadOlderHistory() {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) {
      openclawWebLog('loadOlder skip', { reason: 'no activeSessionId' })
      return
    }
    if (historyLoadingOlderRef.current) {
      openclawWebLog('loadOlder skip', { reason: 'already loading older' })
      return
    }
    if (!historyHasMoreRef.current) {
      openclawWebLog('loadOlder skip', { reason: 'historyHasMoreRef false' })
      return
    }

    const oldestId = getOldestIdForHistoryPagination()
    if (!oldestId) {
      openclawWebLog('loadOlder skip', {
        reason: 'no oldestId',
        renderItemsLen: renderItemsRef.current.length,
        messagesLen: messagesRef.current.length,
      })
      historyHasMoreRef.current = false
      setState((prev) => ({ ...prev, historyHasMore: false }))
      return
    }

    historyLoadingOlderRef.current = true
    setState((prev) => ({ ...prev, historyLoadingOlder: true }))

    try {
      const hadBase = getHistoryMergeBase(renderItemsRef.current, messagesRef.current)
      const hadFp = new Set(hadBase.map(messageFingerprint))

      openclawWebLog('loadOlder start', {
        sessionId,
        oldestId,
        snapshotRows: hadBase.length,
        hadFingerprints: hadFp.size,
      })

      let data = await fetchSessionHistory(sessionId, { limit: HISTORY_OLDER_STEP, before: oldestId })
      if (activeSessionIdRef.current !== sessionId) {
        openclawWebLog('loadOlder aborted', { reason: 'sessionId changed after fetch #1' })
        return
      }

      let normalized = normalizeMessages(data.messages)
      let newCount = normalized.filter((m) => !hadFp.has(messageFingerprint(m))).length
      let reqLimit = HISTORY_OLDER_STEP
      /** 上一次 expand 实际返回条数；limit 加大仍不增多说明已到网关/会话可返回上限 */
      let lastExpandReturnedLen = normalized.length

      openclawWebLog('loadOlder response #1', {
        limit: HISTORY_OLDER_STEP,
        before: oldestId,
        returned: normalized.length,
        newCount,
        hasMoreFromApi: data.hasMore,
        firstIds: normalized.slice(0, 5).map((m) => m.id),
      })

      // 网关常忽略 before，仍返回同一批「最近 N 条」→ 无新 id。按步长增大 limit 拉最近 N 条再合并（不依赖游标）。
      while (newCount === 0 && reqLimit < HISTORY_FETCH_MAX) {
        const prevLimit = reqLimit
        reqLimit = Math.min(HISTORY_FETCH_MAX, reqLimit + HISTORY_OLDER_STEP)
        if (reqLimit <= prevLimit) break
        openclawWebLog('loadOlder expand retry', { reqLimit })
        data = await fetchSessionHistory(sessionId, { limit: reqLimit })
        if (activeSessionIdRef.current !== sessionId) {
          openclawWebLog('loadOlder aborted', { reason: 'sessionId changed during expand', reqLimit })
          return
        }
        normalized = normalizeMessages(data.messages)
        if (lastExpandReturnedLen > 0 && normalized.length === lastExpandReturnedLen) {
          openclawWebLog('loadOlder expand plateau', {
            reqLimit,
            returned: normalized.length,
            note: 'limit↑但条数不变，已到服务端可返回上限或会话仅这么多条',
          })
          break
        }
        lastExpandReturnedLen = normalized.length
        newCount = normalized.filter((m) => !hadFp.has(messageFingerprint(m))).length
        openclawWebLog('loadOlder expand result', { reqLimit, returned: normalized.length, newCount })
      }

      const merged = mergeMessagesUniqueChronological(
        getHistoryMergeBase(renderItemsRef.current, messagesRef.current),
        normalized,
      )
      const final = finalizeMergedMessages(merged)
      const serverHasMore = data.hasMore ?? normalized.length >= reqLimit
      const nextHasMore = newCount === 0 ? false : serverHasMore

      openclawWebLog('loadOlder done', {
        mergedLen: final.length,
        newCount,
        reqLimit,
        nextHasMore,
        serverHasMore,
      })

      setMessages(final)
      setRenderItems((prev) =>
        mergeSnapshotRenderItems(toRenderItemsFromMessages(final, sessionId), prev, sessionId),
      )
      setState((prev) => ({
        ...prev,
        historyHasMore: nextHasMore,
      }))
    } catch (err) {
      openclawWebLog('loadOlderHistory failed', err instanceof Error ? err.message : String(err))
    } finally {
      historyLoadingOlderRef.current = false
      if (activeSessionIdRef.current === sessionId) {
        setState((prev) => ({ ...prev, historyLoadingOlder: false }))
      }
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [_, statusResult] = await Promise.all([refreshSessions(), fetchStatus()])

        setStatusSummary([
          'Host: Dan-MacBook',
          `Gateway: ${statusResult.ok ? 'online' : 'unknown'}`,
          `Sessions: ${statusResult.sessions?.count ?? 0}`,
        ])

        setState((prev) => ({
          ...prev,
          connectionStatus: 'connected',
          runtimeNote: 'gateway ready',
        }))
      } catch {
        setState((prev) => ({
          ...prev,
          connectionStatus: 'error',
          sessionListStatus: 'error',
          runtimeNote: 'bootstrap failed',
        }))
      }
    })()
  }, [])

  useEffect(() => {
    const realtime = connectRealtime({
      onEvent: (event: RealtimeEvent) => {
        const currentSessionId = activeSessionIdRef.current

        if (event.type === 'session.update' && event.sessionId === currentSessionId) {
          setState((prev) => ({
            ...prev,
            historyStatus: prev.historyStatus === 'ready' ? prev.historyStatus : 'loading-history',
          }))

          if (!event.messages?.length && renderItemsRef.current.length === 0) {
            scheduleHistoryRefresh(currentSessionId, 40, 'merge-tail')
          }
        }

        if (event.type === 'chat.event' && event.sessionId === currentSessionId) {
          const st = classifyChatEventState(event.state)
          setState((prev) => {
            if (st === 'final') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'active'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'completed',
                toolActivityStatus: 'completed',
                runtimeNote: 'completed',
              }
            }
            if (st === 'error') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'error'))
              return {
                ...prev,
                historyStatus: 'ready',
                composerError: event.errorMessage || 'chat_event_error',
                sendStatus: 'error',
                toolActivityStatus: 'failed',
                runtimeNote: 'run failed',
                currentRunStartedAt: undefined,
                lastRunDurationMs: prev.currentRunStartedAt
                  ? Math.max(0, Date.now() - prev.currentRunStartedAt)
                  : prev.lastRunDurationMs,
              }
            }
            return {
              ...prev,
              historyStatus: 'ready',
              composerError: prev.composerError,
              sendStatus: prev.sendStatus === 'queued' && st === 'delta' ? 'waiting-response' : prev.sendStatus,
              runtimeNote: prev.sendStatus === 'queued' && st === 'delta' ? 'streaming' : prev.runtimeNote,
            }
          })

          if (st === 'final' || st === 'error') {
            scheduleHistoryRefresh(currentSessionId, 120, 'merge-tail')
          }
        }

        if (event.type === 'timeline.snapshot' && event.sessionId === currentSessionId) {
          setTimelineEvents(event.events)
          setRenderItems((prev) => mergeSnapshotRenderItems(event.renderItems, prev, event.sessionId))
          setMessages([])
          setState((prev) => ({
            ...prev,
            historyStatus: 'ready',
          }))
        }

        if (event.type === 'timeline.event' && event.sessionId === currentSessionId) {
          setTimelineEvents((prev) => {
            const next = [...prev]
            const existingIndex = next.findIndex((item) => item.eventId === event.event.eventId)
            if (existingIndex >= 0) next[existingIndex] = event.event
            else next.push(event.event)
            return next
          })
          if (event.renderItem) {
            setRenderItems((prev) => {
              const next = [...prev]
              const existingIndex = next.findIndex((item) => item.id === event.renderItem!.id)
              if (existingIndex >= 0) next[existingIndex] = event.renderItem!
              else next.push(event.renderItem!)
              return next
            })
          }
          setState((prev) => {
            if (event.event.type === 'run.failed') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'error'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'error',
                toolActivityStatus: 'failed',
                runtimeNote: 'run failed',
                currentRunStartedAt: undefined,
                lastRunDurationMs: prev.currentRunStartedAt
                  ? Math.max(0, Date.now() - prev.currentRunStartedAt)
                  : prev.lastRunDurationMs,
              }
            }
            if (
              event.event.type === 'run.completed' ||
              event.event.type === 'message.assistant.completed'
            ) {
              setSessions((current) => touchSessionState(current, currentSessionId, 'active'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'completed',
                toolActivityStatus: 'completed',
                runtimeNote: 'completed',
              }
            }
            if (event.event.type === 'run.stopped') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'active'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'stopped',
                toolActivityStatus: 'stopped',
                runtimeNote: 'stopped',
                currentRunStartedAt: undefined,
                lastRunDurationMs: prev.currentRunStartedAt
                  ? Math.max(0, Date.now() - prev.currentRunStartedAt)
                  : prev.lastRunDurationMs,
              }
            }
            if (event.event.type === 'run.started') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'busy'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'waiting-response',
                toolActivityStatus: 'running',
                runtimeNote: 'running',
              }
            }
            const next = reconcileSendStatusFromAssistantRenderItem(
              { ...prev, historyStatus: 'ready' },
              event.renderItem,
            )
            if (next.sendStatus === 'completed' && prev.sendStatus !== 'completed') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'active'))
            }
            return next
          })
        }

        if (event.type === 'message.upsert' && event.sessionId === currentSessionId) {
          const msg = event.message
          const modelSide =
            msg &&
            !isUserFacingRole(msg.role, msg.kind) &&
            msg.kind !== 'user' &&
            msg.role !== 'user'
          setState((prev) => {
            const terminal =
              msg &&
              (msg.runStatus === 'completed' || msg.runStatus === 'failed' || msg.runStatus === 'stopped')
            const isModel = msg && !isUserFacingRole(msg.role, msg.kind)
            if (
              terminal &&
              isModel &&
              (prev.sendStatus === 'waiting-response' || prev.sendStatus === 'queued' || prev.sendStatus === 'sending')
            ) {
              const isCompleted = msg.runStatus === 'completed'
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus:
                  msg.runStatus === 'failed' ? 'error' : msg.runStatus === 'stopped' ? 'stopped' : 'completed',
                toolActivityStatus:
                  msg.runStatus === 'failed' ? 'failed' : msg.runStatus === 'stopped' ? 'stopped' : 'completed',
                runtimeNote:
                  msg.runStatus === 'failed' ? 'run failed' : msg.runStatus === 'stopped' ? 'stopped' : 'completed',
                ...(isCompleted
                  ? {}
                  : {
                      currentRunStartedAt: undefined,
                      lastRunDurationMs: prev.currentRunStartedAt
                        ? Math.max(0, Date.now() - prev.currentRunStartedAt)
                        : prev.lastRunDurationMs,
                    }),
              }
            }
            return {
              ...prev,
              historyStatus: 'ready',
              sendStatus: prev.sendStatus === 'queued' && modelSide ? 'waiting-response' : prev.sendStatus,
              runtimeNote: prev.sendStatus === 'queued' && modelSide ? 'streaming' : prev.runtimeNote,
            }
          })
        }

        if (event.type === 'message.batch' && event.sessionId === currentSessionId) {
          const normalizedReplace = event.replace ? normalizeMessages(event.messages) : []
          if (event.replace) {
            setMessages(normalizedReplace)
            setRenderItems((prev) =>
              mergeSnapshotRenderItems(
                toRenderItemsFromMessages(normalizedReplace, event.sessionId),
                prev,
                event.sessionId,
              ),
            )
          }
          setState((prev) => ({
            ...prev,
            historyStatus: 'ready',
            ...(event.replace
              ? {
                  composerError: undefined,
                  historyHasMore:
                    event.hasMore ?? normalizedReplace.length >= HISTORY_PAGE_SIZE,
                }
              : {}),
          }))
        }

        if (event.type === 'session.error' && (!event.sessionId || event.sessionId === currentSessionId)) {
          setState((prev) => ({
            ...prev,
            composerError: event.message,
            runtimeNote: 'realtime error',
            connectionStatus: prev.connectionStatus === 'connected' ? 'degraded' : prev.connectionStatus,
          }))
        }
      },
      onStatusChange: (status) => {
        setState((prev) => ({
          ...prev,
          connectionStatus:
            status === 'connected'
              ? 'connected'
              : status === 'reconnecting'
                ? 'reconnecting'
                : status === 'error'
                  ? 'degraded'
                  : status === 'disconnected'
                    ? 'disconnected'
                    : 'connecting',
          runtimeNote:
            status === 'connected'
              ? prev.runtimeNote === 'booting'
                ? 'gateway ready'
                : prev.runtimeNote
              : status === 'reconnecting'
                ? 'reconnecting realtime'
                : status === 'error'
                  ? 'realtime degraded'
                  : status === 'disconnected'
                    ? 'realtime offline'
                    : 'connecting realtime',
        }))
      },
    })

    realtimeRef.current = realtime
    return () => realtime.close()
  }, [])

  useEffect(() => {
    if (!state.activeSessionId) return
    if (state.sessionListStatus !== 'loaded' && state.sessionListStatus !== 'empty') return
    const hasActiveSession = sessionsRef.current.some((session) => session.id === state.activeSessionId)
    if (!hasActiveSession) return

    realtimeRef.current?.subscribe(state.activeSessionId)

    const idChanged = prevHistorySessionIdRef.current !== state.activeSessionId
    prevHistorySessionIdRef.current = state.activeSessionId

    if (idChanged) {
      setMessages([])
      setRenderItems([])
      setState((prev) => ({
        ...prev,
        historyStatus: 'loading-history',
        historyHasMore: false,
        historyLoadingOlder: false,
      }))
    }

    scheduleHistoryRefresh(state.activeSessionId, 250, idChanged ? 'replace' : 'merge-tail')

    return () => {
      if (refreshHistoryTimerRef.current != null) {
        window.clearTimeout(refreshHistoryTimerRef.current)
        refreshHistoryTimerRef.current = null
      }
    }
  }, [state.activeSessionId, state.sessionListStatus])

  const filteredSessions = useMemo(() => {
    const q = state.sessionSearch.trim().toLowerCase()
    if (!q) return sessions

    return sessions.filter(
      (session) =>
        session.id.toLowerCase().includes(q) || session.summary.toLowerCase().includes(q),
    )
  }, [sessions, state.sessionSearch])

  const activeSession = useMemo<SessionItem>(() => {
    return (
      filteredSessions.find((session) => session.id === state.activeSessionId) ??
      sessions.find((session) => session.id === state.activeSessionId) ??
      sessions[0] ??
      mockSessions[0]
    )
  }, [filteredSessions, sessions, state.activeSessionId])

  const currentDraft = state.draftBySession[state.activeSessionId] ?? ''

  const displayMessages = useMemo(
    () => getDisplayMessagesSnapshot(renderItems, messages),
    [renderItems, messages],
  )

  const modelSideStreaming = useMemo(
    () =>
      displayMessages.some(
        (m) =>
          !isUserFacingRole(m.role, m.kind) &&
          m.kind !== 'user' &&
          m.role !== 'user' &&
          m.runStatus === 'running',
      ),
    [displayMessages],
  )

  /** 网关先报 completed 时气泡可能仍为 running；等无 running 后再清计时起点并写入 lastRunDurationMs */
  useEffect(() => {
    if (state.sendStatus !== 'completed') return
    if (modelSideStreaming) return
    setState((prev) => {
      if (prev.sendStatus !== 'completed') return prev
      if (prev.currentRunStartedAt == null) return prev
      return {
        ...prev,
        currentRunStartedAt: undefined,
        lastRunDurationMs: Math.max(0, Date.now() - prev.currentRunStartedAt),
      }
    })
  }, [modelSideStreaming, state.sendStatus])

  async function sendCurrentMessage(allowAbortWhileSending = false) {
    if (state.sendStatus === 'sending') {
      if (allowAbortWhileSending) sendAbortControllerRef.current?.abort()
      return
    }

    const draft = currentDraft.trim()

    if (state.sendStatus === 'waiting-response' || state.sendStatus === 'queued') {
      await stopCurrentRun()
      if (!draft) return
    } else if (!draft) {
      return
    }

    const sessionId = state.activeSessionId
    const optimisticMessageId = `local-user-${Date.now()}`
    const optimisticTimestamp = new Date().toISOString()
    const optimisticMessage: ApiMessage = {
      id: optimisticMessageId,
      role: 'user',
      content: draft,
      timestamp: optimisticTimestamp,
      kind: 'user',
      runStatus: 'running',
    }

    setRenderItems((prev) => [
      ...prev,
      {
        id: optimisticMessageId,
        sessionId,
        kind: 'user',
        status: 'running',
        title: 'You',
        content: draft,
        timestamp: optimisticTimestamp,
      },
    ])
    setMessages((prev) => [...prev, optimisticMessage])
    setSessions((current) => touchSessionState(current, sessionId, 'busy'))
    setState((prev) => ({
      ...prev,
      sendStatus: 'sending',
      toolActivityStatus: 'running',
      composerError: undefined,
      runtimeNote: 'dispatching',
      currentRunStartedAt: Date.now(),
      lastRunDurationMs: undefined,
      draftBySession: {
        ...prev.draftBySession,
        [sessionId]: '',
      },
    }))

    const ac = new AbortController()
    sendAbortControllerRef.current = ac
    try {
      await sendSessionMessage(sessionId, draft, { signal: ac.signal })
      setRenderItems((prev) =>
        prev.map((item) =>
          item.id === optimisticMessageId ? { ...item, status: 'completed' } : item,
        ),
      )
      setMessages((prev) =>
        prev.map((message) =>
          message.id === optimisticMessageId ? { ...message, runStatus: 'completed' } : message,
        ),
      )
      setState((prev) => ({
        ...prev,
        sendStatus: 'queued',
        runtimeNote: 'queued',
      }))
      if (queuedFallbackTimerRef.current != null) {
        window.clearTimeout(queuedFallbackTimerRef.current)
      }
      queuedFallbackTimerRef.current = window.setTimeout(() => {
        queuedFallbackTimerRef.current = null
        setState((prev) => {
          if (prev.sendStatus !== 'queued') return prev
          if (activeSessionIdRef.current !== sessionId) return prev
          return {
            ...prev,
            sendStatus: 'waiting-response',
            runtimeNote: 'awaiting gateway stream (history will refresh)',
          }
        })
      }, 2500)
      scheduleHistoryRefresh(sessionId, 600, 'merge-tail')
      window.setTimeout(() => {
        if (activeSessionIdRef.current !== sessionId) return
        void refreshHistory(sessionId, 'merge-tail')
      }, 3500)
    } catch (error) {
      const aborted =
        (error instanceof Error && error.name === 'AbortError') ||
        (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
      if (aborted) {
        setRenderItems((prev) =>
          prev.map((item) =>
            item.id === optimisticMessageId ? { ...item, status: 'failed' as const } : item,
          ),
        )
        setMessages((prev) =>
          prev.map((message) =>
            message.id === optimisticMessageId ? { ...message, runStatus: 'failed' as const } : message,
          ),
        )
        setState((prev) => ({
          ...prev,
          sendStatus: 'idle',
          toolActivityStatus: 'idle',
          composerError: undefined,
          runtimeNote: 'send cancelled',
          currentRunStartedAt: undefined,
          lastRunDurationMs: prev.currentRunStartedAt
            ? Math.max(0, Date.now() - prev.currentRunStartedAt)
            : prev.lastRunDurationMs,
          draftBySession: {
            ...prev.draftBySession,
            [sessionId]: draft,
          },
        }))
        setSessions((current) => touchSessionState(current, sessionId, 'active'))
        return
      }
      setRenderItems((prev) =>
        prev.map((item) =>
          item.id === optimisticMessageId ? { ...item, status: 'failed' } : item,
        ),
      )
      setMessages((prev) =>
        prev.map((message) =>
          message.id === optimisticMessageId ? { ...message, runStatus: 'failed' } : message,
        ),
      )
      setState((prev) => ({
        ...prev,
        sendStatus: 'error',
        toolActivityStatus: 'failed',
        composerError: error instanceof Error ? error.message : 'send_failed',
        runtimeNote: 'send failed',
        lastRunDurationMs: prev.currentRunStartedAt ? Math.max(0, Date.now() - prev.currentRunStartedAt) : prev.lastRunDurationMs,
        currentRunStartedAt: undefined,
        draftBySession: {
          ...prev.draftBySession,
          [sessionId]: draft,
        },
      }))
    } finally {
      sendAbortControllerRef.current = null
    }
  }

  async function stopCurrentRun() {
    try {
      setState((prev) => ({ ...prev, composerError: undefined, runtimeNote: 'stopping' }))
      await abortSessionRun(state.activeSessionId)
      setState((prev) => ({
        ...prev,
        sendStatus: 'stopped',
        toolActivityStatus: 'stopped',
        runtimeNote: 'stop requested',
        lastRunDurationMs: prev.currentRunStartedAt ? Math.max(0, Date.now() - prev.currentRunStartedAt) : prev.lastRunDurationMs,
        currentRunStartedAt: undefined,
      }))
    } catch (error) {
      setState((prev) => ({
        ...prev,
        sendStatus: 'error',
        toolActivityStatus: 'failed',
        composerError: error instanceof Error ? error.message : 'abort_failed',
        runtimeNote: 'stop failed',
        lastRunDurationMs: prev.currentRunStartedAt ? Math.max(0, Date.now() - prev.currentRunStartedAt) : prev.lastRunDurationMs,
        currentRunStartedAt: undefined,
      }))
    }
  }

  async function createNewSession(label?: string) {
    try {
      setState((prev) => ({ ...prev, runtimeNote: 'creating session', composerError: undefined }))
      await createSession('Start a new session.')
      const nextSessions = await refreshSessions()
      const newest = nextSessions[0]
      if (newest) {
        if (label) {
          try {
            await renameSession(newest.id, label)
            setSessions((prev) => prev.map((item) => (item.id === newest.id ? { ...item, summary: label } : item)))
            manuallyTitledSessionIdsRef.current.add(newest.id)
            autoTitledSessionIdsRef.current.add(newest.id)
          } catch {
            // keep created session even if rename fails
          }
        }
        setState((prev) => ({ ...prev, activeSessionId: newest.id, runtimeNote: 'session created' }))
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        composerError: error instanceof Error ? error.message : 'create_session_failed',
        runtimeNote: 'create session failed',
      }))
    }
  }

  async function renameSessionTitle(sessionId: string) {
    const current = sessions.find((item) => item.id === sessionId)
    const nextLabel = window.prompt('Rename session', current?.summary || '')?.trim()
    if (!nextLabel) return

    try {
      manuallyTitledSessionIdsRef.current.add(sessionId)
      autoTitledSessionIdsRef.current.add(sessionId)
      await renameSession(sessionId, nextLabel)
      setSessions((prev) => prev.map((item) => (item.id === sessionId ? { ...item, summary: nextLabel } : item)))
      setState((prev) => ({
        ...prev,
        runtimeNote: 'session renamed',
        composerError: undefined,
      }))
    } catch (error) {
      manuallyTitledSessionIdsRef.current.delete(sessionId)
      setState((prev) => ({
        ...prev,
        composerError: error instanceof Error ? error.message : 'rename_session_failed',
        runtimeNote: 'rename session failed',
      }))
    }
  }

  async function removeSession(sessionId: string) {
    const confirmed = window.confirm(`Delete session ${sessionId}?`)
    if (!confirmed) return

    try {
      const currentIndex = sessions.findIndex((session) => session.id === sessionId)
      const fallbackId =
        state.activeSessionId === sessionId
          ? sessions[currentIndex + 1]?.id ?? sessions[currentIndex - 1]?.id
          : state.activeSessionId

      await deleteSession(sessionId)
      await refreshSessions(fallbackId)
      setState((prev) => ({
        ...prev,
        runtimeNote: 'session deleted',
        composerError: undefined,
      }))
    } catch (error) {
      setState((prev) => ({
        ...prev,
        composerError: error instanceof Error ? error.message : 'delete_session_failed',
        runtimeNote: 'delete session failed',
      }))
    }
  }

  return {
    state,
    filteredSessions,
    activeSession,
    currentDraft,
    messages: displayMessages,
    modelSideStreaming,
    sideCards: [
      mockSideCards[0],
      { ...mockSideCards[1], items: statusSummary },
      mockSideCards[2],
      mockSideCards[3],
    ],
    setSessionSearch: (value: string) => setState((prev) => ({ ...prev, sessionSearch: value })),
    selectSession: (id: string) => {
      setSessions((current) => touchSessionState(current, id, 'active'))
      setState((prev) => ({
        ...prev,
        activeSessionId: id,
        composerError: undefined,
        sendStatus: 'idle',
        toolActivityStatus: 'idle',
        runtimeNote: 'session switched',
        currentRunStartedAt: undefined,
      }))
    },
    toggleLeftSidebar: () =>
      setState((prev) => ({ ...prev, isLeftSidebarCollapsed: !prev.isLeftSidebarCollapsed })),
    toggleRightSidebar: () =>
      setState((prev) => ({ ...prev, isRightSidebarCollapsed: !prev.isRightSidebarCollapsed })),
    toggleSettings: () =>
      setState((prev) => ({ ...prev, isSettingsOpen: !prev.isSettingsOpen })),
    setDraft: (value: string) =>
      setState((prev) => ({
        ...prev,
        sendStatus: prev.sendStatus === 'error' || prev.sendStatus === 'completed' || prev.sendStatus === 'stopped' ? 'idle' : prev.sendStatus,
        toolActivityStatus:
          prev.sendStatus === 'error' || prev.sendStatus === 'completed' || prev.sendStatus === 'stopped'
            ? 'idle'
            : prev.toolActivityStatus,
        composerError: undefined,
        runtimeNote:
          prev.sendStatus === 'error' || prev.sendStatus === 'completed' || prev.sendStatus === 'stopped'
            ? 'editing'
            : prev.runtimeNote,
        currentRunStartedAt:
          prev.sendStatus === 'error' || prev.sendStatus === 'completed' || prev.sendStatus === 'stopped'
            ? undefined
            : prev.currentRunStartedAt,
        draftBySession: {
          ...prev.draftBySession,
          [prev.activeSessionId]: value,
        },
      })),
    sendCurrentMessage,
    stopCurrentRun,
    refreshHistory: () => void refreshHistory(state.activeSessionId, 'replace'),
    loadOlderHistory,
    createNewSession,
    renameSessionTitle,
    removeSession,
  }
}
