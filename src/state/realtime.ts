import type { RealtimeEvent } from '../types/api'

interface RealtimeOptions {
  onEvent: (event: RealtimeEvent) => void
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error') => void
}

export function connectRealtime({ onEvent, onStatusChange }: RealtimeOptions) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/realtime`)

  onStatusChange?.('connecting')

  ws.onopen = () => {
    onStatusChange?.('connected')
  }

  ws.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RealtimeEvent)
    } catch {
      // ignore malformed events
    }
  }

  ws.onerror = () => {
    onStatusChange?.('error')
  }

  ws.onclose = () => {
    onStatusChange?.('disconnected')
  }

  return {
    socket: ws,
    subscribe(sessionId: string) {
      const send = () => ws.send(JSON.stringify({ type: 'subscribe', sessionId }))
      if (ws.readyState === WebSocket.OPEN) {
        send()
      } else {
        onStatusChange?.('reconnecting')
        ws.addEventListener('open', send, { once: true })
      }
    },
    close() {
      ws.close()
    },
  }
}
