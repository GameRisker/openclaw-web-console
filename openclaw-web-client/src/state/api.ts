import type { SessionHistoryResponse, SessionsResponse } from '../types/api'

export async function fetchSessions() {
  const response = await fetch('/api/sessions')
  if (!response.ok) throw new Error('failed_to_fetch_sessions')
  return (await response.json()) as SessionsResponse
}

export async function fetchSessionHistory(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/history`)
  if (!response.ok) throw new Error('failed_to_fetch_history')
  return (await response.json()) as SessionHistoryResponse
}

export async function fetchStatus() {
  const response = await fetch('/api/status')
  if (!response.ok) throw new Error('failed_to_fetch_status')
  return response.json()
}

export async function sendSessionMessage(sessionId: string, message: string) {
  const response = await fetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  })

  let result: { message?: string; error?: string } = {}
  try {
    result = (await response.json()) as typeof result
  } catch {
    if (!response.ok) throw new Error(`send_failed (${response.status})`)
    return {}
  }

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
