import type { SessionHistoryResponse, SessionsResponse } from '../types/api'
import { HISTORY_PAGE_SIZE } from '../constants/history'
import { openclawWebLog } from './debugLog'

export async function fetchSessions() {
  const response = await fetch('/api/sessions')
  if (!response.ok) throw new Error('failed_to_fetch_sessions')
  return (await response.json()) as SessionsResponse
}

export async function fetchSessionHistory(
  sessionId: string,
  options?: { limit?: number; before?: string },
) {
  const params = new URLSearchParams()
  params.set('limit', String(options?.limit ?? HISTORY_PAGE_SIZE))
  if (options?.before) params.set('before', options.before)
  const qs = params.toString()
  openclawWebLog('http history request', { sessionId, limit: options?.limit ?? HISTORY_PAGE_SIZE, before: options?.before })
  const response = await fetch(`/api/sessions/${sessionId}/history?${qs}`)
  let data: SessionHistoryResponse
  try {
    data = (await response.json()) as SessionHistoryResponse
  } catch {
    openclawWebLog('http history response (parse error)', { ok: response.ok, status: response.status })
    throw new Error('failed_to_fetch_history')
  }
  openclawWebLog('http history response', {
    ok: response.ok,
    status: response.status,
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    sessionId: data.sessionId,
    hasMore: data.hasMore,
  })
  if (!response.ok) throw new Error('failed_to_fetch_history')
  return data
}

export async function fetchStatus() {
  const response = await fetch('/api/status')
  if (!response.ok) throw new Error('failed_to_fetch_status')
  return response.json()
}

export type ModelCatalogEntry = {
  id: string
  label: string
  name?: string
  model?: string
  modelProvider?: string
  available?: boolean
  tags?: string[]
}

export async function fetchModelsCatalog(): Promise<{
  models: ModelCatalogEntry[]
  source?: string
  schemaVersion?: number
  defaultModel?: string
  fallbacks?: unknown
  aliases?: unknown
  count?: number
  error?: string
}> {
  const response = await fetch('/api/models')
  const data = (await response.json()) as {
    models?: ModelCatalogEntry[]
    source?: string
    schemaVersion?: number
    defaultModel?: string
    fallbacks?: unknown
    aliases?: unknown
    count?: number
    error?: string
  }
  if (!response.ok) {
    throw new Error(data.error || 'failed_to_fetch_models')
  }
  return {
    models: Array.isArray(data.models) ? data.models : [],
    source: data.source,
    schemaVersion: data.schemaVersion,
    defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : undefined,
    fallbacks: data.fallbacks,
    aliases: data.aliases,
    count: typeof data.count === 'number' ? data.count : undefined,
    error: data.error,
  }
}

export async function sendSessionMessage(
  sessionId: string,
  message: string,
  options?: { signal?: AbortSignal },
) {
  openclawWebLog('http send request', {
    sessionId,
    messagePreview: message.slice(0, 120) + (message.length > 120 ? '…' : ''),
  })
  const response = await fetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
    signal: options?.signal,
  })

  let result: { message?: string; error?: string; ok?: boolean } = {}
  try {
    result = (await response.json()) as typeof result
  } catch {
    openclawWebLog('http send response (no json)', { ok: response.ok, status: response.status })
    if (!response.ok) throw new Error(`send_failed (${response.status})`)
    return {}
  }

  openclawWebLog('http send response', { ok: response.ok, status: response.status, result })

  if (!response.ok) {
    throw new Error(result.message || result.error || `send_failed (${response.status})`)
  }

  return result
}

export async function abortSessionRun(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/abort`, {
    method: 'POST',
  })

  const result = await response.json()

  if (!response.ok) {
    throw new Error(result.message || result.error || 'abort_failed')
  }

  return result
}

export async function createSession(message?: string) {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error || 'create_session_failed')
  return result
}

export async function deleteSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error || 'delete_session_failed')
  return result
}

export async function renameSession(sessionId: string, label: string) {
  const response = await fetch(`/api/sessions/${sessionId}/label`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label }),
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error || 'rename_session_failed')
  return result
}

export type SessionPatchPayload = {
  label?: string
  model?: string
  modelProvider?: string
  verbose?: boolean
  think?: string
}

export async function patchSessionSettings(sessionId: string, patch: SessionPatchPayload) {
  const response = await fetch(`/api/sessions/${sessionId}/patch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error || 'session_patch_failed')
  return result as { ok?: boolean; patch?: SessionPatchPayload }
}

export async function compactSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/compact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.message || result.error || 'compact_failed')
  return result
}
