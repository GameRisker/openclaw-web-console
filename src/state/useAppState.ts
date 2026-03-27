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
import type { RealtimeEvent, ApiMessage, TimelineRenderItem, TimelineEventItem } from '../types/api'
import type { AppState, SessionItem } from '../types/app'

const initialState: AppState = {
  authStatus: 'authenticated',
  connectionStatus: 'connecting',
  sessionListStatus: 'loading',
  activeSessionId: 'main',
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
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function inferKind(message: ApiMessage): TimelineRenderItem['kind'] {
  if (message.kind === 'toolCall' || message.role === 'tool' || /^\[toolCall\]\s*/i.test(message.content)) return 'toolCall'
  if (message.kind === 'toolResult' || message.role === 'toolResult' || /^\[toolResult\]\s*/i.test(message.content)) return 'toolResult'
  if (message.kind === 'verbose' || message.role === 'verbose' || /^\[(thinking|reasoning)\]\s*/i.test(message.content)) return 'verbose'
  if (message.role === 'user' || message.kind === 'user') return 'user'
  if (message.role === 'system' || message.kind === 'system') return 'system'
  return 'assistant'
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
        other.role === 'user' &&
        other.content === message.content,
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
  const autoTitledSessionIdsRef = useRef<Set<string>>(new Set())
  const manuallyTitledSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    activeSessionIdRef.current = state.activeSessionId
  }, [state.activeSessionId])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    renderItemsRef.current = renderItems
  }, [renderItems])

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

  async function refreshHistory(sessionId: string) {
    setState((prev) => ({ ...prev, historyStatus: 'loading-history' }))

    try {
      const history = await fetchSessionHistory(sessionId)
      const normalized = normalizeMessages(history.messages)
      setMessages(normalized)
      setRenderItems(toRenderItemsFromMessages(normalized, sessionId))
      setState((prev) => ({ ...prev, historyStatus: 'ready' }))
    } catch {
      setMessages([])
      setRenderItems([])
      setState((prev) => ({ ...prev, historyStatus: 'error' }))
    }
  }

  function scheduleHistoryRefresh(sessionId: string, delay = 80) {
    if (refreshHistoryTimerRef.current) {
      window.clearTimeout(refreshHistoryTimerRef.current)
    }
    refreshHistoryTimerRef.current = window.setTimeout(() => {
      refreshHistoryTimerRef.current = null
      void refreshHistory(sessionId)
    }, delay)
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
            scheduleHistoryRefresh(currentSessionId, 40)
          }
        }

        if (event.type === 'chat.event' && event.sessionId === currentSessionId) {
          setState((prev) => ({
            ...prev,
            historyStatus: 'ready',
            composerError: event.state === 'error' ? event.errorMessage || 'chat_event_error' : prev.composerError,
          }))

          if ((event.state === 'final' || event.state === 'error') && messagesRef.current.length === 0) {
            scheduleHistoryRefresh(currentSessionId, 120)
          }
        }

        if (event.type === 'timeline.snapshot' && event.sessionId === currentSessionId) {
          setTimelineEvents(event.events)
          setRenderItems(event.renderItems)
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
              }
            }
            if (event.event.type === 'run.completed') {
              setSessions((current) => touchSessionState(current, currentSessionId, 'active'))
              return {
                ...prev,
                historyStatus: 'ready',
                sendStatus: 'completed',
                toolActivityStatus: 'completed',
                runtimeNote: 'completed',
                currentRunStartedAt: undefined,
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
            return {
              ...prev,
              historyStatus: 'ready',
            }
          })
        }

        if (event.type === 'message.upsert' && event.sessionId === currentSessionId) {
          setState((prev) => ({
            ...prev,
            historyStatus: 'ready',
          }))
        }

        if (event.type === 'message.batch' && event.sessionId === currentSessionId) {
          if (renderItemsRef.current.length === 0 && event.replace) {
            setMessages(normalizeMessages(event.messages))
          }
          setState((prev) => ({
            ...prev,
            historyStatus: 'ready',
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
  }, [sessions])

  useEffect(() => {
    if (!state.activeSessionId) return
    if (state.sessionListStatus !== 'loaded' && state.sessionListStatus !== 'empty') return
    const hasActiveSession = sessions.some((session) => session.id === state.activeSessionId)
    if (!hasActiveSession) return

    setState((prev) => ({
      ...prev,
      historyStatus: prev.historyStatus === 'ready' ? prev.historyStatus : 'loading-history',
    }))
    realtimeRef.current?.subscribe(state.activeSessionId)
    scheduleHistoryRefresh(state.activeSessionId, 250)
  }, [state.activeSessionId, state.sessionListStatus, sessions])

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
    () =>
      renderItems.length
        ? [...renderItems]
            .sort((a, b) => {
              const diff = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp)
              return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id))
            })
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
                      : item.kind,
              content:
                item.kind === 'toolCall'
                  ? item.content.replace(/^\[toolCall\]\s*/i, '')
                  : item.kind === 'toolResult'
                    ? item.content.replace(/^\[toolResult\]\s*/i, '')
                    : item.content,
              kind: item.kind,
              label: item.label,
              toolName: item.toolName,
              runStatus: item.status,
            }))
        : messages,
    [renderItems, messages],
  )

  async function sendCurrentMessage() {
    const draft = currentDraft.trim()
    if (!draft || state.sendStatus === 'sending') return

    if (state.sendStatus === 'waiting-response') {
      await stopCurrentRun()
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

    try {
      await sendSessionMessage(sessionId, draft)
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
    } catch (error) {
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
        draftBySession: {
          ...prev.draftBySession,
          [prev.activeSessionId]: value,
        },
      })),
    sendCurrentMessage,
    stopCurrentRun,
    refreshHistory: () => refreshHistory(state.activeSessionId),
    createNewSession,
    renameSessionTitle,
    removeSession,
  }
}
