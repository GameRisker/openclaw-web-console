export type AuthStatus =
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'session-expired'
  | 'auth-error'

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'error'

export type SessionListStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'error'

export type HistoryStatus = 'idle' | 'loading-history' | 'ready' | 'error'

export type SendStatus =
  | 'idle'
  | 'sending'
  | 'queued'
  | 'waiting-response'
  | 'completed'
  | 'stopped'
  | 'error'

export type ToolActivityStatus = 'idle' | 'running' | 'failed' | 'stopped' | 'completed'

export type SessionState = 'active' | 'idle' | 'busy' | 'error'

export interface SessionItem {
  id: string
  key?: string
  summary: string
  subtitle?: string
  state: SessionState
  /** 列表排序用：优先网关 createdAt，否则由客户端推断并在刷新时保留 */
  createdAt?: number
  updatedAt?: number
  ageMs?: number
  model?: string
  modelProvider?: string
  totalTokens?: number
  contextTokens?: number
  kind?: string
}

export interface SideCard {
  title: string
  items: string[]
}

export interface AppState {
  authStatus: AuthStatus
  connectionStatus: ConnectionStatus
  sessionListStatus: SessionListStatus
  activeSessionId: string
  /** 是否还可能存在更早历史（用于向上滚动分页） */
  historyHasMore: boolean
  /** 正在请求更早一页 */
  historyLoadingOlder: boolean
  historyStatus: HistoryStatus
  sendStatus: SendStatus
  toolActivityStatus: ToolActivityStatus
  isLeftSidebarCollapsed: boolean
  isRightSidebarCollapsed: boolean
  isSettingsOpen: boolean
  sessionSearch: string
  draftBySession: Record<string, string>
  composerError?: string
  runtimeNote?: string
  currentRunStartedAt?: number
  lastRunDurationMs?: number
}
