export interface ApiSession {
  key: string
  sessionId: string
  updatedAt: number
  ageMs: number
  /** 网关若提供则优先用于列表按创建时间排序 */
  createdAt?: number
  model?: string
  modelProvider?: string
  totalTokens?: number
  contextTokens?: number
  kind?: string
  label?: string
  displayName?: string
}

export interface ApiMessage {
  id: string
  timestamp: string
  role: string
  content: string
  kind?: string
  label?: string
  toolName?: string
  runStatus?: 'running' | 'completed' | 'stopped' | 'failed'
}

export interface SessionsResponse {
  count: number
  sessions: ApiSession[]
}

export interface SessionHistoryResponse {
  sessionId: string
  sessionKey?: string
  messages: ApiMessage[]
  /** 是否可能还有更早消息（桥接启发式：条数 >= limit；网关若返回精确值可后续透传） */
  hasMore?: boolean
}

export interface RealtimeSessionUpdate {
  type: 'session.update'
  sessionId: string
  sessionKey?: string
  sendStatus: 'idle' | 'waiting-response'
  toolActivityStatus: 'idle' | 'running'
  messages: ApiMessage[]
}

export interface RealtimeChatEvent {
  type: 'chat.event'
  sessionId: string
  sessionKey?: string
  state?: 'delta' | 'final' | 'error' | string
  runId?: string
  message?: {
    role?: string
    content?: string
    timestamp?: string
    kind?: string
    parts?: Array<{
      kind?: string
      role?: string
      content?: string
      order?: number
    }>
  } | null
  errorMessage?: string
  stopReason?: string
}

export interface RealtimeSessionError {
  type: 'session.error'
  sessionId?: string
  message: string
}

export interface RealtimeMessageBatch {
  type: 'message.batch'
  sessionId: string
  sessionKey?: string
  replace?: boolean
  messages: ApiMessage[]
  hasMore?: boolean
}

export interface RealtimeMessageUpsert {
  type: 'message.upsert'
  sessionId: string
  sessionKey?: string
  message: ApiMessage
}

export interface TimelineRenderItem {
  id: string
  sessionId: string
  sessionKey?: string
  runId?: string
  kind: 'user' | 'assistant' | 'verbose' | 'toolCall' | 'toolResult' | 'system'
  status?: 'running' | 'completed' | 'stopped' | 'failed'
  title?: string
  label?: string
  toolName?: string
  content: string
  timestamp: string
}

export interface TimelineEventItem {
  eventId: string
  sessionId: string
  sessionKey?: string
  runId?: string
  ts: number
  type:
    | 'timeline.message'
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.stopped'
    | 'message.assistant.started'
    | 'message.assistant.delta'
    | 'message.assistant.completed'
    | 'message.verbose.started'
    | 'message.verbose.delta'
    | 'message.verbose.completed'
    | 'tool.call.started'
    | 'tool.call.completed'
    | 'tool.result.created'
  payload: Record<string, unknown>
}

export interface RealtimeTimelineSnapshot {
  type: 'timeline.snapshot'
  sessionId: string
  sessionKey?: string
  events: TimelineEventItem[]
  renderItems: TimelineRenderItem[]
}

export interface RealtimeTimelineEvent {
  type: 'timeline.event'
  sessionId: string
  sessionKey?: string
  event: TimelineEventItem
  renderItem?: TimelineRenderItem
}

export interface RealtimeHello {
  type: 'hello'
  clientId: string
}

export type RealtimeEvent =
  | RealtimeHello
  | RealtimeSessionUpdate
  | RealtimeChatEvent
  | RealtimeSessionError
  | RealtimeMessageBatch
  | RealtimeMessageUpsert
  | RealtimeTimelineSnapshot
  | RealtimeTimelineEvent
