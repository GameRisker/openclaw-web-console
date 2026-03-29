import type { RealtimeEvent } from '../types/api'
import { openclawWebLog } from './debugLog'

interface RealtimeOptions {
  onEvent: (event: RealtimeEvent) => void
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error') => void
}

export function connectRealtime({ onEvent, onStatusChange }: RealtimeOptions) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}/api/realtime`
  openclawWebLog('realtime connecting', url)
  const ws = new WebSocket(url)

  onStatusChange?.('connecting')

  ws.onopen = () => {
    openclawWebLog('realtime open')
    onStatusChange?.('connected')
  }

  ws.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as RealtimeEvent
      openclawWebLog('realtime message', parsed)
      onEvent(parsed)
    } catch {
      openclawWebLog('realtime message (parse error)', String(message.data).slice(0, 500))
    }
  }

  ws.onerror = () => {
    openclawWebLog('realtime error')
    onStatusChange?.('error')
  }

  ws.onclose = () => {
    openclawWebLog('realtime close')
    onStatusChange?.('disconnected')
  }

  return {
    socket: ws,
    subscribe(sessionId: string) {
      const send = () => {
        const frame = JSON.stringify({ type: 'subscribe', sessionId })
        openclawWebLog('realtime subscribe send', { sessionId })
        ws.send(frame)
      }
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
