import type { SessionHistoryResponse, SessionsResponse } from '../types/api'
import { openclawWebLog } from './debugLog'

export async function fetchSessions() {
  const response = await fetch('/api/sessions')
  if (!response.ok) throw new Error('failed_to_fetch_sessions')
  return (await response.json()) as SessionsResponse
}

export async function fetchSessionHistory(sessionId: string) {
  openclawWebLog('http history request', { sessionId })
  const response = await fetch(`/api/sessions/${sessionId}/history`)
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
  })
  if (!response.ok) throw new Error('failed_to_fetch_history')
  return data
}

export async function fetchStatus() {
  const response = await fetch('/api/status')
  if (!response.ok) throw new Error('failed_to_fetch_status')
  return response.json()
}

export async function sendSessionMessage(sessionId: string, message: string) {
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
