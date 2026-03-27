import express from 'express'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DIST_DIR = path.join(__dirname, 'dist')
const INDEX_HTML = path.join(DIST_DIR, 'index.html')
const execFileAsync = promisify(execFile)
const app = express()
const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'
const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

app.use(express.json())

function normalizeSession(item) {
  return {
    key: item.key,
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    ageMs: item.ageMs,
    model: item.model,
    modelProvider: item.modelProvider,
    totalTokens: item.totalTokens,
    contextTokens: item.contextTokens,
    kind: item.kind,
    label: item.label,
    displayName: item.displayName,
  }
}

async function loadGatewayConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8')
  const config = JSON.parse(raw)
  const auth = config.gateway?.auth ?? {}
  const port = config.gateway?.port || 8080

  return {
    token: auth.token,
    password: auth.password,
    wsUrl: `ws://127.0.0.1:${port}`,
  }
}

async function runOpenClawJson(args) {
  const { stdout } = await execFileAsync('openclaw', args, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  })

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('[plugins]'))

  return JSON.parse(lines.join('\n'))
}

async function runGatewayCall(method, params = {}, timeout = 10000) {
  const auth = await loadGatewayConfig()
  const args = [
    'gateway',
    'call',
    method,
    '--json',
    '--timeout',
    String(timeout),
    '--params',
    JSON.stringify(params),
  ]

  if (auth.token) args.push('--token', auth.token)
  if (auth.password) args.push('--password', auth.password)

  return runOpenClawJson(args)
}

async function listSessions() {
  return runGatewayCall('sessions.list', {})
}

async function resolveSession(sessionId) {
  const result = await listSessions()
  const match = result.sessions.find((session) => session.sessionId === sessionId)
  if (!match) {
    const error = new Error(`session_not_found:${sessionId}`)
    error.code = 'session_not_found'
    throw error
  }
  return match
}

function formatJsonBlock(value) {
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function classifyTextPart(text = '', parentRole = 'assistant', meta = {}) {
  const normalized = String(text || '')
  if (/^\[toolCall\]\s*/i.test(normalized)) return { kind: 'toolCall', role: 'tool', content: normalized, ...meta }
  if (/^\[toolResult\]\s*/i.test(normalized)) return { kind: 'toolResult', role: 'toolResult', content: normalized, ...meta }
  if (/^\[thinking\]\s*/i.test(normalized) || /^\[reasoning\]\s*/i.test(normalized)) {
    return {
      kind: 'verbose',
      role: 'verbose',
      content: normalized.replace(/^\[(thinking|reasoning)\]\s*/i, '') || normalized,
      ...meta,
    }
  }
  if (parentRole === 'toolResult') return { kind: 'toolResult', role: 'toolResult', content: normalized, ...meta }
  return { kind: parentRole === 'user' ? 'user' : 'text', role: parentRole, content: normalized, ...meta }
}

function contentParts(content, parentRole = 'assistant', parentMessage = null) {
  if (typeof content === 'string') {
    return [classifyTextPart(content, parentRole, { toolName: parentMessage?.toolName })]
  }
  if (!Array.isArray(content)) return []

  return content.map((part, index) => {
    if (part.type === 'text') {
      return {
        ...classifyTextPart(part.text ?? '', parentRole, {
          toolName: parentMessage?.toolName,
          label: parentMessage?.toolName ? `${parentMessage.toolName}` : undefined,
        }),
        order: index,
      }
    }
    if (part.type === 'thinking') {
      return {
        kind: 'verbose',
        role: 'verbose',
        content: part.thinking ?? part.text ?? '[thinking]',
        label: 'Internal reasoning',
        order: index,
      }
    }
    if (part.type === 'toolCall') {
      const toolName = part.toolName ?? part.name ?? 'tool'
      const argsBlock = part.arguments ? `\n\n\`\`\`json\n${formatJsonBlock(part.arguments)}\n\`\`\`` : ''
      return {
        kind: 'toolCall',
        role: 'tool',
        toolName,
        label: toolName,
        content: `${toolName}${argsBlock}`,
        order: index,
      }
    }
    if (part.type === 'toolResult') {
      const toolName = part.toolName ?? parentMessage?.toolName ?? 'tool'
      const resultText = part.text ?? (part.content ? formatJsonBlock(part.content) : '')
      return {
        kind: 'toolResult',
        role: 'toolResult',
        toolName,
        label: toolName,
        content: resultText || `[toolResult] ${toolName}`,
        order: index,
      }
    }
    return { kind: part.type ?? 'unknown', role: 'system', content: `[${part.type}]`, order: index }
  })
}

function toTimestampMs(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function flattenContent(content, parentRole = 'assistant') {
  return contentParts(content, parentRole)
    .map((part) => part.content)
    .join('\n')
}

const DEBUG_WEBUI_BRIDGE = true

function bridgeLog(event, details = {}) {
  if (!DEBUG_WEBUI_BRIDGE) return
  try {
    console.log(`[webui-bridge] ${event}`, JSON.stringify(details))
  } catch {
    console.log(`[webui-bridge] ${event}`)
  }
}

const messageProcessors = [
  function defaultMessageProcessor(message) {
    return message
  },
]

function processMessage(message, context = {}) {
  return messageProcessors.reduce((current, processor) => {
    if (!current) return current
    return processor(current, context)
  }, message)
}

function toRenderItem(message, sessionId, sessionKey) {
  const kind =
    message.kind === 'toolCall' || message.role === 'tool'
      ? 'toolCall'
      : message.kind === 'toolResult' || message.role === 'toolResult'
        ? 'toolResult'
        : message.role === 'verbose'
          ? 'verbose'
          : message.role === 'user'
            ? 'user'
            : message.role === 'system'
              ? 'system'
              : 'assistant'

  return {
    id: message.id,
    sessionId,
    sessionKey,
    runId: String(message.id).split(':')[0],
    kind,
    status: message.runStatus,
    title:
      kind === 'toolCall'
        ? 'Tool Call'
        : kind === 'toolResult'
          ? 'Tool Result'
          : kind === 'verbose'
            ? 'Verbose'
            : kind === 'assistant'
              ? 'Assistant'
              : kind === 'user'
                ? 'You'
                : 'System',
    label: message.label,
    toolName: message.toolName,
    content: message.content,
    timestamp: String(message.timestamp ?? ''),
  }
}

function toTimelineMessageEvent(message, sessionId, sessionKey) {
  const kind =
    message.kind === 'toolCall' || message.role === 'tool'
      ? 'toolCall'
      : message.kind === 'toolResult' || message.role === 'toolResult'
        ? 'toolResult'
        : message.kind === 'verbose' || message.role === 'verbose'
          ? 'verbose'
          : message.kind
  const type =
    kind === 'toolCall'
      ? message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'stopped'
        ? 'tool.call.completed'
        : 'tool.call.started'
      : kind === 'toolResult'
        ? 'tool.result.created'
        : kind === 'verbose'
          ? message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'stopped'
            ? 'message.verbose.completed'
            : 'message.verbose.delta'
          : kind === 'text' || message.role === 'assistant'
            ? message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'stopped'
              ? 'message.assistant.completed'
              : 'message.assistant.delta'
            : 'timeline.message'

  return {
    eventId: `evt:${message.id}`,
    sessionId,
    sessionKey,
    runId: String(message.id).split(':')[0],
    ts: Number(message.timestamp || Date.now()),
    type,
    payload: {
      messageId: message.id,
      kind: message.kind,
      role: message.role,
      status: message.runStatus,
      content: message.content,
    },
  }
}

function toRunTimelineEvent({ sessionId, sessionKey, runId, state, stopReason, errorMessage, timestamp }) {
  const type =
    state === 'error'
      ? 'run.failed'
      : state === 'final'
        ? stopReason === 'abort'
          ? 'run.stopped'
          : 'run.completed'
        : 'run.started'

  return {
    eventId: `run:${runId || sessionKey}:${type}`,
    sessionId,
    sessionKey,
    runId: runId || undefined,
    ts: Number(timestamp || Date.now()),
    type,
    payload: {
      stopReason,
      errorMessage,
    },
  }
}

function mapHistoryMessages(sessionId, history) {
  return history.messages.flatMap((message, index) => {
    const baseId = message.runId || `${sessionId}-${index}`
    const parts = contentParts(message.content, message.role, message)
    if (parts.length === 0) {
      const processed = processMessage({
        id: `${baseId}:message:0`,
        timestamp: message.timestamp ?? '',
        role: message.role,
        content: '',
      }, { source: 'history', sessionId, message, index })
      return processed ? [processed] : []
    }

    return parts
      .map((part, partIndex) =>
        processMessage(
          {
            id: `${baseId}:${part.kind || part.role || 'part'}:${part.order ?? partIndex}`,
            timestamp: message.timestamp ?? '',
            role: part.role ?? message.role,
            content: part.content,
            kind: part.kind,
            label: part.label,
            toolName: part.toolName,
          },
          { source: 'history', sessionId, message, index, part, partIndex },
        ),
      )
      .filter(Boolean)
  })
}

class NativeGatewayBridge {
  constructor() {
    this.ws = null
    this.connected = false
    this.connecting = false
    this.hello = null
    this.gatewayConfig = null
    this.pending = new Map()
    this.sessionToClients = new Map()
    this.sessionKeyToId = new Map()
    this.clientToSession = new Map()
    this.reconnectTimer = null
    this.subscribedSessionKeys = new Set()
    this.pendingChatEvents = new Map()
    this.pendingChatTimers = new Map()
    this.sessionMessageState = new Map()
    this.sessionSnapshots = new Map()
    this.sessionTimelines = new Map()
  }

  getSnapshot(sessionKey) {
    return this.sessionSnapshots.get(sessionKey) ?? []
  }

  setSnapshot(sessionKey, messages) {
    this.sessionSnapshots.set(
      sessionKey,
      [...messages].sort((a, b) => {
        const diff = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp)
        return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id))
      }),
    )
  }

  getTimeline(sessionKey) {
    return this.sessionTimelines.get(sessionKey) ?? { events: [], renderItems: [] }
  }

  setTimeline(sessionKey, timeline) {
    this.sessionTimelines.set(sessionKey, {
      events: [...timeline.events].sort((a, b) => a.ts - b.ts || String(a.eventId).localeCompare(String(b.eventId))),
      renderItems: [...timeline.renderItems].sort(
        (a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp) || String(a.id).localeCompare(String(b.id)),
      ),
    })
  }

  async ensureStarted() {
    if (this.connected || this.connecting) return
    this.connecting = true
    this.gatewayConfig = await loadGatewayConfig()
    await this.openSocket()
  }

  async openSocket() {
    const ws = new WebSocket(this.gatewayConfig.wsUrl)
    this.ws = ws

    ws.on('open', () => {
      this.connecting = false
      bridgeLog('gateway.ws.open')
    })

    ws.on('message', async (buf) => {
      try {
        const msg = JSON.parse(String(buf))

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          this.send({
            type: 'req',
            id: 'connect',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'gateway-client',
                displayName: 'OpenClaw Web UI Bridge',
                version: '0.0.0',
                platform: process.platform,
                mode: 'ui',
                instanceId: 'openclaw-web-ui-bridge',
              },
              auth: {
                ...(this.gatewayConfig.token ? { token: this.gatewayConfig.token } : {}),
                ...(this.gatewayConfig.password ? { password: this.gatewayConfig.password } : {}),
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
            },
          })
          return
        }

        if (msg.type === 'res' && msg.id === 'connect' && msg.ok && msg.payload?.type === 'hello-ok') {
          this.connected = true
          this.hello = msg.payload
          bridgeLog('gateway.connect.ok', { sessionCount: this.sessionToClients.size })
          this.subscribedSessionKeys.clear()
          for (const sessionKey of this.sessionToClients.keys()) {
            this.send({
              type: 'req',
              id: `sub:${sessionKey}`,
              method: 'chat.subscribe',
              params: { sessionKey },
            })
          }
          return
        }

        if (msg.type === 'event' && msg.event === 'chat') {
          bridgeLog('gateway.chat.event', {
            sessionKey: msg.payload?.sessionKey,
            state: msg.payload?.state,
            runId: msg.payload?.runId,
            hasMessage: !!msg.payload?.message,
          })
          this.handleChatEvent(msg.payload)
          return
        }

        if (msg.type === 'res' && typeof msg.id === 'string' && msg.id.startsWith('sub:') && msg.ok) {
          this.subscribedSessionKeys.add(msg.id.slice(4))
          return
        }

        if (msg.type === 'res' && typeof msg.id === 'string' && msg.id.startsWith('unsub:') && msg.ok) {
          this.subscribedSessionKeys.delete(msg.id.slice(6))
          return
        }

        if (msg.type === 'res' && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.ok) pending.resolve(msg.payload)
          else pending.reject(new Error(msg.error?.message || 'gateway_request_failed'))
        }
      } catch {
        // ignore malformed frames
      }
    })

    ws.on('close', () => {
      this.connected = false
      this.connecting = false
      this.ws = null
      for (const [, pending] of this.pending) {
        pending.reject(new Error('gateway_ws_closed'))
      }
      this.pending.clear()
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        void this.ensureStarted()
      }, 1500)
    })

    ws.on('error', () => {
      // close handler will reconnect
    })
  }

  send(frame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      this.pending.set(id, { resolve, reject })
      this.send({ type: 'req', id, method, params })
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`gateway_request_timeout:${method}`))
      }, 10000)
    })
  }

  async subscribe(clientId, sessionId, sessionKey) {
    await this.ensureStarted()
    bridgeLog('client.subscribe.begin', { clientId, sessionId, sessionKey })

    const previous = this.clientToSession.get(clientId)
    if (previous && previous !== sessionKey) {
      const prevClients = this.sessionToClients.get(previous)
      if (prevClients) {
        prevClients.delete(clientId)
        if (prevClients.size === 0) {
          this.sessionToClients.delete(previous)
          this.send({
            type: 'req',
            id: `unsub:${previous}`,
            method: 'chat.unsubscribe',
            params: { sessionKey: previous },
          })
        }
      }
    }

    this.clientToSession.set(clientId, sessionKey)
    this.sessionKeyToId.set(sessionKey, sessionId)

    let clients = this.sessionToClients.get(sessionKey)
    if (!clients) {
      clients = new Set()
      this.sessionToClients.set(sessionKey, clients)
    }
    clients.add(clientId)

    if (this.connected && !this.subscribedSessionKeys.has(sessionKey)) {
      await this.request('chat.subscribe', { sessionKey })
      this.subscribedSessionKeys.add(sessionKey)
    }

    bridgeLog('client.subscribe.ready', {
      clientId,
      sessionId,
      sessionKey,
      clientCount: clients.size,
      snapshotSize: this.getSnapshot(sessionKey).length,
    })
  }

  unsubscribeClient(clientId) {
    const sessionKey = this.clientToSession.get(clientId)
    if (!sessionKey) return

    this.clientToSession.delete(clientId)
    const clients = this.sessionToClients.get(sessionKey)
    if (!clients) return
    clients.delete(clientId)
    if (clients.size === 0) {
      this.sessionToClients.delete(sessionKey)
      this.subscribedSessionKeys.delete(sessionKey)
      const pendingTimer = this.pendingChatTimers.get(sessionKey)
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        this.pendingChatTimers.delete(sessionKey)
      }
      this.pendingChatEvents.delete(sessionKey)
      this.sessionMessageState.delete(sessionKey)
      this.sessionSnapshots.delete(sessionKey)
      this.sessionTimelines.delete(sessionKey)
      if (this.connected) {
        this.send({
          type: 'req',
          id: `unsub:${sessionKey}`,
          method: 'chat.unsubscribe',
          params: { sessionKey },
        })
      }
    }
  }

  flushChatEvent(sessionKey) {
    const payload = this.pendingChatEvents.get(sessionKey)
    if (!payload) return

    this.pendingChatEvents.delete(sessionKey)
    const pendingTimer = this.pendingChatTimers.get(sessionKey)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.pendingChatTimers.delete(sessionKey)
    }

    const sessionId = this.sessionKeyToId.get(sessionKey)
    const clients = this.sessionToClients.get(sessionKey)
    if (!sessionId || !clients || clients.size === 0) return

    const parts = payload.message ? contentParts(payload.message.content, payload.message.role, payload.message) : []
    const runKey = payload.runId || `session:${sessionKey}`
    const sessionState = this.sessionMessageState.get(sessionKey) ?? new Map()
    this.sessionMessageState.set(sessionKey, sessionState)

    const runStatus =
      payload.state === 'error'
        ? 'failed'
        : payload.state === 'final'
          ? payload.stopReason === 'abort'
            ? 'stopped'
            : 'completed'
          : 'running'

    const batchMessages = parts
      .map((part, index) => {
        const partOrder = part.order ?? index
        const messageId = `${runKey}:${part.kind || part.role || 'part'}:${partOrder}`
        const processed = processMessage(
          {
            id: messageId,
            timestamp: payload.message?.timestamp ?? '',
            role: part.role ?? payload.message?.role ?? 'assistant',
            content: part.content ?? '',
            kind: part.kind,
            label: part.label,
            toolName: part.toolName,
            runStatus,
          },
          { source: 'realtime-batch', sessionId, sessionKey, payload, part, partIndex: index },
        )
        if (!processed) return null
        const merged = {
          ...(sessionState.get(messageId) ?? {}),
          ...processed,
          id: messageId,
          runStatus,
        }
        sessionState.set(messageId, merged)
        return merged
      })
      .filter(Boolean)

    const event = {
      type: 'chat.event',
      sessionId,
      sessionKey,
      state: payload.state,
      runId: payload.runId,
      message: null,
      errorMessage: payload.errorMessage,
      stopReason: payload.stopReason,
    }

    const nextSnapshot = [...this.getSnapshot(sessionKey)]
    for (const message of batchMessages) {
      const existingIndex = nextSnapshot.findIndex((item) => item.id === message.id)
      if (existingIndex >= 0) nextSnapshot[existingIndex] = { ...nextSnapshot[existingIndex], ...message }
      else nextSnapshot.push(message)
    }
    this.setSnapshot(sessionKey, nextSnapshot)

    const currentTimeline = this.getTimeline(sessionKey)
    const nextTimeline = {
      events: [...currentTimeline.events],
      renderItems: [...currentTimeline.renderItems],
    }
    const runEvent = toRunTimelineEvent({
      sessionId,
      sessionKey,
      runId: payload.runId,
      state: payload.state,
      stopReason: payload.stopReason,
      errorMessage: payload.errorMessage,
      timestamp: payload.message?.timestamp,
    })
    const existingRunEventIndex = nextTimeline.events.findIndex((item) => item.eventId === runEvent.eventId)
    if (existingRunEventIndex >= 0) nextTimeline.events[existingRunEventIndex] = runEvent
    else nextTimeline.events.push(runEvent)

    for (const message of batchMessages) {
      const eventItem = toTimelineMessageEvent(message, sessionId, sessionKey)
      const renderItem = toRenderItem(message, sessionId, sessionKey)
      const existingEventIndex = nextTimeline.events.findIndex((item) => item.eventId === eventItem.eventId)
      if (existingEventIndex >= 0) nextTimeline.events[existingEventIndex] = eventItem
      else nextTimeline.events.push(eventItem)
      const existingRenderIndex = nextTimeline.renderItems.findIndex((item) => item.id === renderItem.id)
      if (existingRenderIndex >= 0) nextTimeline.renderItems[existingRenderIndex] = renderItem
      else nextTimeline.renderItems.push(renderItem)
    }
    this.setTimeline(sessionKey, nextTimeline)

    bridgeLog('chat.flush', {
      sessionId,
      sessionKey,
      runKey,
      state: payload.state,
      partCount: parts.length,
      batchCount: batchMessages.length,
      snapshotSize: nextSnapshot.length,
      timelineEvents: nextTimeline.events.length,
      renderItems: nextTimeline.renderItems.length,
    })

    const batchEvent = {
      type: 'message.batch',
      sessionId,
      sessionKey,
      replace: false,
      messages: batchMessages,
    }

    for (const clientId of clients) {
      const client = realtimeClients.get(clientId)
      if (!client) continue
      sendWs(client.ws, {
        type: 'timeline.event',
        sessionId,
        sessionKey,
        event: runEvent,
      })
      for (const message of batchMessages) {
        sendWs(client.ws, {
          type: 'message.upsert',
          sessionId,
          sessionKey,
          message,
        })
        sendWs(client.ws, {
          type: 'timeline.event',
          sessionId,
          sessionKey,
          event: toTimelineMessageEvent(message, sessionId, sessionKey),
          renderItem: toRenderItem(message, sessionId, sessionKey),
        })
      }
      if (batchMessages.length) sendWs(client.ws, batchEvent)
      sendWs(client.ws, event)
    }

    if (payload.state === 'final' || payload.state === 'error') {
      for (const key of Array.from(sessionState.keys())) {
        if (key.startsWith(`${runKey}:`)) {
          const current = sessionState.get(key)
          if (current) sessionState.set(key, { ...current, runStatus })
        }
      }
    }
  }

  handleChatEvent(payload) {
    const sessionKey = payload?.sessionKey
    if (!sessionKey) return
    const sessionId = this.sessionKeyToId.get(sessionKey)
    const clients = this.sessionToClients.get(sessionKey)
    if (!sessionId || !clients || clients.size === 0) return

    this.pendingChatEvents.set(sessionKey, payload)
    const pendingTimer = this.pendingChatTimers.get(sessionKey)
    if (pendingTimer) clearTimeout(pendingTimer)

    const delay = payload.state === 'final' || payload.state === 'error' ? 10 : payload.state === 'delta' ? 15 : 30
    const timer = setTimeout(() => {
      this.flushChatEvent(sessionKey)
    }, delay)
    this.pendingChatTimers.set(sessionKey, timer)
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    const health = await runOpenClawJson(['health', '--json'])
    res.json(health)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'health_failed' })
  }
})

app.get('/api/status', async (_req, res) => {
  try {
    const status = await runOpenClawJson(['status', '--json'])
    res.json(status)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'status_failed' })
  }
})

app.get('/api/sessions', async (_req, res) => {
  try {
    const result = await listSessions()
    res.json({ count: result.count, sessions: result.sessions.map(normalizeSession) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'sessions_failed' })
  }
})

app.post('/api/sessions', async (req, res) => {
  try {
    const sessionKey = `agent:main:tui-${crypto.randomUUID()}`
    const initialLabel = String(req.body?.label ?? 'Untitled').trim() || 'Untitled'
    const result = await runGatewayCall('agent', {
      sessionKey,
      message: String(req.body?.message ?? 'Start a new session.'),
      idempotencyKey: crypto.randomUUID(),
    })

    await runGatewayCall('sessions.patch', {
      key: sessionKey,
      label: initialLabel,
    })

    res.json({ ok: true, sessionKey, label: initialLabel, result })
  } catch (error) {
    res.status(500).json({
      error: 'create_session_failed',
      message: error instanceof Error ? error.message : 'create_session_failed',
    })
  }
})

app.get('/api/sessions/:sessionId/history', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const history = await runGatewayCall('chat.history', { sessionKey: session.key, limit: 50 })
    res.json({ sessionId: req.params.sessionId, sessionKey: session.key, messages: mapHistoryMessages(req.params.sessionId, history) })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({ error: error instanceof Error ? error.message : 'history_failed' })
  }
})

app.post('/api/sessions/:sessionId/message', async (req, res) => {
  const message = String(req.body?.message ?? '').trim()
  if (!message) return res.status(400).json({ error: 'empty_message' })

  try {
    const session = await resolveSession(req.params.sessionId)
    const result = await runGatewayCall('chat.send', { sessionKey: session.key, message, idempotencyKey: crypto.randomUUID() })
    res.json({ ok: true, sessionKey: session.key, result })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({ error: 'send_failed', message: error instanceof Error ? error.message : 'send_failed' })
  }
})

app.post('/api/sessions/:sessionId/abort', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const result = await runGatewayCall('chat.abort', { sessionKey: session.key, idempotencyKey: crypto.randomUUID() })
    res.json({ ok: true, sessionKey: session.key, result })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({ error: 'abort_failed', message: error instanceof Error ? error.message : 'abort_failed' })
  }
})

app.post('/api/sessions/:sessionId/label', async (req, res) => {
  const label = String(req.body?.label ?? '').trim()
  if (!label) return res.status(400).json({ error: 'empty_label' })

  try {
    const session = await resolveSession(req.params.sessionId)
    const result = await runGatewayCall('sessions.patch', { key: session.key, label })
    res.json({ ok: true, sessionKey: session.key, label, result })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({
      error: 'rename_session_failed',
      message: error instanceof Error ? error.message : 'rename_session_failed',
    })
  }
})

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const result = await runGatewayCall('sessions.delete', { key: session.key })
    res.json({ ok: true, sessionKey: session.key, result })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({
      error: 'delete_session_failed',
      message: error instanceof Error ? error.message : 'delete_session_failed',
    })
  }
})

app.use(express.static(DIST_DIR))
app.get(/^(?!\/api\/).*/, async (_req, res) => {
  try {
    await fs.access(INDEX_HTML)
    res.sendFile(INDEX_HTML)
  } catch {
    res.status(503).send('Web UI not built yet. Run `npm run build` first.')
  }
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/api/realtime' })
const realtimeClients = new Map()
const gatewayBridge = new NativeGatewayBridge()

function sendWs(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID()
  realtimeClients.set(clientId, { ws })
  bridgeLog('client.ws.connected', { clientId })
  sendWs(ws, { type: 'hello', clientId })

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(String(raw))
      if (data.type === 'subscribe' && typeof data.sessionId === 'string') {
        const session = await resolveSession(data.sessionId)
        await gatewayBridge.subscribe(clientId, data.sessionId, session.key)
        const history = await runGatewayCall('chat.history', { sessionKey: session.key, limit: 50 })
        const mappedMessages = mapHistoryMessages(data.sessionId, history)
        gatewayBridge.setSnapshot(session.key, mappedMessages)
        const timeline = {
          events: mappedMessages.map((message) => toTimelineMessageEvent(message, data.sessionId, session.key)),
          renderItems: mappedMessages.map((message) => toRenderItem(message, data.sessionId, session.key)),
        }
        gatewayBridge.setTimeline(session.key, timeline)
        bridgeLog('client.subscribe.snapshot', {
          clientId,
          sessionId: data.sessionId,
          sessionKey: session.key,
          messageCount: mappedMessages.length,
        })
        sendWs(ws, {
          type: 'session.update',
          sessionId: data.sessionId,
          sessionKey: session.key,
          sendStatus: 'idle',
          toolActivityStatus: 'idle',
          messages: mappedMessages,
        })
        sendWs(ws, {
          type: 'message.batch',
          sessionId: data.sessionId,
          sessionKey: session.key,
          replace: true,
          messages: mappedMessages,
        })
        sendWs(ws, {
          type: 'timeline.snapshot',
          sessionId: data.sessionId,
          sessionKey: session.key,
          events: timeline.events,
          renderItems: timeline.renderItems,
        })
      }
    } catch (error) {
      sendWs(ws, { type: 'session.error', message: error instanceof Error ? error.message : 'invalid_ws_message' })
    }
  })

  ws.on('close', () => {
    bridgeLog('client.ws.closed', { clientId })
    gatewayBridge.unsubscribeClient(clientId)
    realtimeClients.delete(clientId)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`OpenClaw Web UI listening on http://${HOST}:${PORT}`)
})
