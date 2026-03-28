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
