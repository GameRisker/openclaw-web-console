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

/**
 * WS 订阅首包 / 未传 limit 时的默认条数。
 * 须与 openclaw-web-client/src/constants/history.ts 的 HISTORY_PAGE_SIZE 一致。
 */
const HISTORY_PAGE_DEFAULT = 20
const HISTORY_PAGE_MAX = 200

/** 网关 connect 请求的 scopes；部分网关要求 operator.admin，可通过 OPENCLAW_WEB_GATEWAY_SCOPES 覆盖（逗号分隔）。 */
function gatewayConnectScopes() {
  const raw = process.env.OPENCLAW_WEB_GATEWAY_SCOPES?.trim()
  if (raw) return raw.split(/[,\s]+/).filter(Boolean)
  return ['operator.read', 'operator.write', 'operator.admin']
}

function parseHistoryLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return HISTORY_PAGE_DEFAULT
  return Math.min(HISTORY_PAGE_MAX, Math.floor(n))
}

function buildChatHistoryParams(sessionKey, limit, before) {
  const params = { sessionKey, limit }
  if (before) params.before = before
  return params
}

function sortMappedHistoryMessages(mapped) {
  return [...mapped].sort(
    (a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp) || String(a.id).localeCompare(String(b.id)),
  )
}

/** 网关若返回精确 hasMore，优先采用；否则用「本页条数 >= limit」启发式 */
function pickGatewayHasMoreFlag(raw) {
  if (raw == null || typeof raw !== 'object') return undefined
  if (typeof raw.hasMore === 'boolean') return raw.hasMore
  if (typeof raw.has_more === 'boolean') return raw.has_more
  if (typeof raw.more === 'boolean') return raw.more
  if (raw.nextCursor != null && String(raw.nextCursor).trim() !== '') return true
  if (raw.next_cursor != null && String(raw.next_cursor).trim() !== '') return true
  return undefined
}

function computeHistoryHasMore(gatewayPayload, mappedLength, limit) {
  const explicit = pickGatewayHasMoreFlag(gatewayPayload)
  if (explicit === false) return false
  if (explicit === true) return true
  return mappedLength >= limit
}

/** 去掉与游标同 id；若网关误把 before 行放进本页则裁到该 id 之前（严格更早） */
function applyBeforeCursorSanitize(mappedSortedAsc, beforeId) {
  if (!beforeId || mappedSortedAsc.length === 0) return mappedSortedAsc
  const idx = mappedSortedAsc.findIndex((m) => m.id === beforeId)
  if (idx >= 0) return mappedSortedAsc.slice(0, idx)
  return mappedSortedAsc.filter((m) => m.id !== beforeId)
}

function parseHistoryBeforeFromQuery(query) {
  const raw = query.before ?? query.beforeMessageId ?? query.cursor ?? query.before_id
  if (raw == null) return undefined
  const s = String(raw).trim()
  return s === '' ? undefined : s
}

app.use(express.json())

function normalizeSessionBool(value) {
  if (value === true || value === false) return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return undefined
}

/** Web 仅使用 low | high | off；从网关 think / thinkLevel / thinking* 等映射 */
function normalizeSessionThinkLevel(raw) {
  if (raw == null || raw === '') return undefined
  const s = String(raw).trim().toLowerCase().replace(/-/g, '_')
  if (['low', 'minimal', 'min', 'small'].includes(s)) return 'low'
  if (['high', 'xhigh', 'max', 'maximum', 'heavy'].includes(s)) return 'high'
  if (['off', 'none', 'no', 'disabled', 'false', '0'].includes(s)) return 'off'
  if (['low', 'high', 'off'].includes(s)) return s
  return undefined
}

function normalizeSession(item) {
  const thinkRaw = item.think ?? item.thinkLevel ?? item.thinking ?? item.thinkingLevel
  const think = normalizeSessionThinkLevel(thinkRaw)
  const verbose =
    normalizeSessionBool(item.verbose) ??
    normalizeSessionBool(item.verboseEnabled) ??
    normalizeSessionBool(item.isVerbose)
  return {
    key: item.key,
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    ageMs: item.ageMs,
    createdAt: item.createdAt,
    model: item.model,
    modelProvider: item.modelProvider,
    totalTokens: item.totalTokens,
    contextTokens: item.contextTokens,
    kind: item.kind,
    label: item.label,
    displayName: item.displayName,
    verbose,
    think,
  }
}

/** `provider/model` → { modelProvider, model } */
function splitProviderFromId(fullId) {
  const s = String(fullId ?? '').trim()
  const i = s.indexOf('/')
  if (i <= 0) return { modelProvider: undefined, model: s }
  return { modelProvider: s.slice(0, i), model: s.slice(i + 1) }
}

/**
 * 统一为 Web 使用的条目：id、model、name、可选 modelProvider（与 openclaw models list --json 等对齐）。
 * 字符串视为完整 id（如 openai/gpt-4o）。
 */
function normalizeModelCatalogEntry(item) {
  if (typeof item === 'string') {
    const id = item.trim()
    if (!id) return null
    const sp = splitProviderFromId(id)
    return {
      id,
      model: sp.model,
      name: id,
      label: id,
      ...(sp.modelProvider ? { modelProvider: sp.modelProvider } : {}),
    }
  }
  if (!item || typeof item !== 'object') return null

  const prov = item.modelProvider ?? item.provider ?? item.vendor
  const modOnly = item.model != null && String(item.model).trim() !== '' ? String(item.model).trim() : null

  let id =
    item.key != null && String(item.key).trim() !== ''
      ? String(item.key).trim()
      : item.id != null && String(item.id).trim() !== ''
        ? String(item.id).trim()
        : null

  if (!id && modOnly && prov) id = `${String(prov).trim()}/${modOnly}`
  if (!id && modOnly) id = modOnly
  if (!id) return null

  const sp = splitProviderFromId(id)
  const name = String(item.name ?? item.label ?? item.displayName ?? id)

  const out = {
    id,
    model: sp.model,
    name,
    label: name,
    ...(sp.modelProvider ? { modelProvider: sp.modelProvider } : {}),
  }
  if (typeof item.available === 'boolean') out.available = item.available
  if (Array.isArray(item.tags)) out.tags = item.tags
  return out
}

function normalizeModelsArray(arr) {
  if (!Array.isArray(arr)) return []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const m = normalizeModelCatalogEntry(item)
    if (m && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

function extractModelsFromStatusLike(obj) {
  if (!obj || typeof obj !== 'object') return []
  const tryArrays = [
    obj.models,
    obj.configuredModels,
    obj.allowedModels,
    obj.availableModels,
    obj.modelCatalog,
    obj.modelChoices,
    obj.config?.models,
    obj.runtime?.models,
    obj.gateway?.models,
    obj.agent?.models,
  ]
  for (const a of tryArrays) {
    const list = normalizeModelsArray(a)
    if (list.length) return list
  }
  if (obj.agents && typeof obj.agents === 'object' && !Array.isArray(obj.agents)) {
    for (const k of Object.keys(obj.agents)) {
      const agent = obj.agents[k]
      if (agent && typeof agent === 'object') {
        const list = normalizeModelsArray(agent.models)
        if (list.length) return list
      }
    }
  }
  return []
}

function parseModelsListCliResponse(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') return null
  const arr = Array.isArray(raw) ? raw : raw.models
  if (!Array.isArray(arr) || arr.length === 0) return null
  const models = normalizeModelsArray(arr)
  return models.length
    ? {
        source: sourceLabel,
        models,
        defaultModel: raw.defaultModel ?? raw.resolvedDefault,
        count: raw.count,
      }
    : null
}

function parseModelsStatusCliResponse(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') return null
  const allowed = raw.allowed
  if (!Array.isArray(allowed) || allowed.length === 0) return null
  const models = normalizeModelsArray(allowed)
  return models.length
    ? {
        source: sourceLabel,
        models,
        defaultModel: raw.defaultModel ?? raw.resolvedDefault,
        fallbacks: raw.fallbacks,
        aliases: raw.aliases,
      }
    : null
}

/**
 * 按约定顺序探测 CLI（与 OpenClaw 文档对齐；随 CLI 演进可调整顺序）：
 * 1) status --json 内嵌模型数组（未来由 OpenClaw 提供）
 * 2) models list --json
 * 3) model list --json
 * 4) models status --json / models --status-json
 */
async function loadModelsCatalogPayload() {
  const attempts = [
    {
      label: 'openclaw status --json',
      run: async () => {
        const raw = await runOpenClawJson(['status', '--json'])
        const list = extractModelsFromStatusLike(raw)
        return list.length ? { source: 'openclaw status --json', models: list } : null
      },
    },
    {
      label: 'openclaw models list --json',
      run: async () => parseModelsListCliResponse(await runOpenClawJson(['models', 'list', '--json']), 'openclaw models list --json'),
    },
    {
      label: 'openclaw model list --json',
      run: async () => parseModelsListCliResponse(await runOpenClawJson(['model', 'list', '--json']), 'openclaw model list --json'),
    },
    {
      label: 'openclaw models status --json',
      run: async () =>
        parseModelsStatusCliResponse(await runOpenClawJson(['models', 'status', '--json']), 'openclaw models status --json'),
    },
    {
      label: 'openclaw models --status-json',
      run: async () =>
        parseModelsStatusCliResponse(await runOpenClawJson(['models', '--status-json']), 'openclaw models --status-json'),
    },
  ]

  let lastError
  for (const { label, run } of attempts) {
    try {
      const r = await run()
      if (r?.models?.length) {
        return {
          schemaVersion: 1,
          source: r.source,
          models: r.models,
          ...(r.defaultModel != null ? { defaultModel: r.defaultModel } : {}),
          ...(r.fallbacks != null ? { fallbacks: r.fallbacks } : {}),
          ...(r.aliases != null ? { aliases: r.aliases } : {}),
          ...(r.count != null ? { count: r.count } : {}),
        }
      }
    } catch (e) {
      lastError = e
    }
  }

  return {
    schemaVersion: 1,
    source: 'empty',
    models: [],
    ...(lastError instanceof Error ? { error: lastError.message, lastAttemptNote: '所有 CLI 探测均未返回非空模型列表' } : {}),
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

/** 避免短时间内多次 history / send 各打一次 sessions.list（每次都是独立 openclaw 子进程，很慢） */
let sessionsListCache = null
const SESSIONS_LIST_CACHE_TTL_MS = 4000

async function listSessions() {
  const result = await runGatewayCall('sessions.list', {})
  sessionsListCache = { at: Date.now(), data: result }
  return result
}

function invalidateSessionsListCache() {
  sessionsListCache = null
}

async function listSessionsCached() {
  const now = Date.now()
  if (sessionsListCache && now - sessionsListCache.at < SESSIONS_LIST_CACHE_TTL_MS) {
    return sessionsListCache.data
  }
  return listSessions()
}

async function resolveSession(sessionId) {
  const result = await listSessionsCached()
  const id = String(sessionId)
  const match = result.sessions.find(
    (session) => String(session.sessionId ?? '') === id || String(session.key ?? '') === id,
  )
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

const USER_FACING_ROLES = new Set([
  'user',
  'human',
  'client',
  'end_user',
  'person',
  'customer',
  'input',
  'self',
  'owner',
  'local',
  'player',
  'participant',
  'end-user',
  'human_message',
  'humanmessage',
])

function normalizeEndUserRole(role) {
  if (role == null || role === '') return 'assistant'
  const r = String(role).trim().toLowerCase()
  if (USER_FACING_ROLES.has(r)) return 'user'
  return String(role).trim()
}

function isUserFacingMessage(message) {
  if (message.kind === 'user') return true
  return normalizeEndUserRole(message.role) === 'user'
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
  const roleNorm = normalizeEndUserRole(parentRole)
  return {
    kind: roleNorm === 'user' ? 'user' : 'text',
    role: roleNorm === 'user' ? 'user' : roleNorm,
    content: normalized,
    ...meta,
  }
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

/** 设为 0 / false 可关闭桥接调试输出；默认开启 */
const DEBUG_WEBUI_BRIDGE = !['0', 'false', 'no'].includes(
  String(process.env.OPENCLAW_WEB_BRIDGE_LOG ?? '').toLowerCase(),
)

if (DEBUG_WEBUI_BRIDGE) {
  console.log('[webui-bridge] 调试日志已开启（终端）。关闭: OPENCLAW_WEB_BRIDGE_LOG=0 node server.mjs')
}

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

function resolveMessageKind(message) {
  if (message.kind === 'toolCall' || message.role === 'tool') return 'toolCall'
  if (message.kind === 'toolResult' || message.role === 'toolResult') return 'toolResult'
  if (message.role === 'verbose' || message.kind === 'verbose') return 'verbose'
  if (isUserFacingMessage(message)) return 'user'
  if (message.role === 'system' || message.kind === 'system') return 'system'
  return 'assistant'
}

function toRenderItem(message, sessionId, sessionKey) {
  const kind = resolveMessageKind(message)

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
  const rk = resolveMessageKind(message)
  const kind = rk === 'assistant' ? 'text' : rk
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

function pickHistoryRole(message) {
  if (message == null) return undefined
  const direction = String(message.direction ?? message.flow ?? '').toLowerCase()
  if (direction === 'out' || direction === 'outbound' || direction === 'upstream') return 'user'
  const from = String(message.from ?? '').toLowerCase()
  if (['user', 'client', 'human', 'local', 'self', 'operator'].includes(from)) return 'user'
  const msgType = String(message.type ?? message.messageType ?? message.kind ?? '').toLowerCase()
  if (
    msgType === 'user' ||
    msgType === 'human' ||
    msgType === 'user_message' ||
    msgType === 'prompt' ||
    msgType.includes('human') ||
    msgType.endsWith('_user')
  ) {
    return 'user'
  }
  return message.role ?? message.speaker ?? message.author ?? message.source
}

function pickHistoryContent(message) {
  if (message == null) return ''
  if (message.content != null) return message.content
  if (message.text != null) return message.text
  if (message.body != null) return message.body
  if (typeof message.message === 'string') return message.message
  if (message.message != null && typeof message.message === 'object' && message.message.content != null) {
    return message.message.content
  }
  if (typeof message.prompt === 'string') return message.prompt
  return ''
}

/** Turn gateway content into what contentParts() accepts (string or parts[]). */
function normalizeHistoryContentForParts(content) {
  if (content == null) return ''
  if (typeof content === 'string' || Array.isArray(content)) return content
  if (typeof content === 'object') {
    if (Array.isArray(content.parts)) return content.parts
    if (typeof content.text === 'string') return content.text
    if (content.content != null) return normalizeHistoryContentForParts(content.content)
    if (typeof content.message === 'string') return content.message
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function pickHistoryRunStatus(message) {
  const raw = message?.runStatus ?? message?.status ?? message?.state ?? message?.run_state
  if (raw == null || raw === '') return 'completed'
  const s = String(raw).toLowerCase()
  if (s === 'running' || s === 'in_progress' || s === 'streaming' || s === 'pending' || s === 'active') return 'running'
  if (s === 'failed' || s === 'error' || s === 'failure') return 'failed'
  if (s === 'stopped' || s === 'aborted' || s === 'cancelled' || s === 'canceled') return 'stopped'
  return 'completed'
}

function mapHistoryMessages(sessionId, history) {
  const rawMessages = Array.isArray(history?.messages)
    ? history.messages
    : Array.isArray(history?.items)
      ? history.items
      : []

  return rawMessages.flatMap((message, index) => {
    const baseId = message.runId || message.id || `${sessionId}-${index}`
    const role = normalizeEndUserRole(pickHistoryRole(message))
    const rawContent = pickHistoryContent(message)
    const content = normalizeHistoryContentForParts(rawContent)
    const parts = contentParts(content, role, message)
    const historyRunStatus = pickHistoryRunStatus(message)
    if (parts.length === 0) {
      let fallbackText = ''
      if (typeof rawContent === 'string') fallbackText = rawContent
      else if (rawContent != null) {
        const normalized = normalizeHistoryContentForParts(rawContent)
        if (typeof normalized === 'string' && normalized) fallbackText = normalized
        else {
          try {
            fallbackText = JSON.stringify(rawContent)
          } catch {
            fallbackText = String(rawContent)
          }
        }
      }
      const processed = processMessage(
        {
          id: `${baseId}:message:0`,
          timestamp: message.timestamp ?? message.createdAt ?? message.ts ?? '',
          role,
          content: fallbackText,
          runStatus: historyRunStatus,
        },
        { source: 'history', sessionId, message, index },
      )
      return processed ? [processed] : []
    }

    return parts
      .map((part, partIndex) =>
        processMessage(
          {
            id: `${baseId}:${part.kind || part.role || 'part'}:${part.order ?? partIndex}`,
            timestamp: message.timestamp ?? message.createdAt ?? message.ts ?? '',
            role: part.role ?? role,
            content: part.content,
            kind: part.kind,
            label: part.label,
            toolName: part.toolName,
            runStatus: historyRunStatus,
          },
          { source: 'history', sessionId, message, index, part, partIndex },
        ),
      )
      .filter(Boolean)
  })
}

/**
 * `chat.history` 二级缓存（进程内 LRU）。见 docs/backend-history-cache-proposal.md §4。
 * 多实例部署无共享缓存时各进程独立；可设 HISTORY_CACHE_ENABLED=0 关闭。
 */
const HISTORY_CACHE_ENABLED = !/^0|false|no$/i.test(String(process.env.HISTORY_CACHE_ENABLED ?? '1').trim())
const HISTORY_CACHE_MAX_ENTRIES = Math.min(
  2000,
  Math.max(16, Number.parseInt(process.env.HISTORY_CACHE_MAX_ENTRIES ?? '256', 10) || 256),
)
const HISTORY_CACHE_TTL_MS = Math.max(0, Number.parseInt(process.env.HISTORY_CACHE_TTL_MS ?? '0', 10) || 0)

const historyResponseCache = new Map()

function historyCacheStorageKey(sessionKey, limit, before) {
  return `${sessionKey}\x1e${limit}\x1e${before ?? ''}`
}

function historyCacheTouch(storageKey, entry) {
  if (historyResponseCache.has(storageKey)) historyResponseCache.delete(storageKey)
  historyResponseCache.set(storageKey, entry)
  while (historyResponseCache.size > HISTORY_CACHE_MAX_ENTRIES) {
    const oldest = historyResponseCache.keys().next().value
    historyResponseCache.delete(oldest)
  }
}

function historyCacheGet(storageKey) {
  const entry = historyResponseCache.get(storageKey)
  if (!entry) return null
  if (HISTORY_CACHE_TTL_MS > 0 && Date.now() - entry.at > HISTORY_CACHE_TTL_MS) {
    historyResponseCache.delete(storageKey)
    return null
  }
  historyResponseCache.delete(storageKey)
  historyResponseCache.set(storageKey, entry)
  return entry
}

function invalidateHistoryCacheForSessionKey(sessionKey) {
  if (!sessionKey) return
  const prefix = `${sessionKey}\x1e`
  for (const k of [...historyResponseCache.keys()]) {
    if (k.startsWith(prefix)) historyResponseCache.delete(k)
  }
}

/**
 * 网关若不支持 `before`（或传了即报错），`chat.history` 会整段失败 → Web 收到 500。
 * 降级：不带 before 拉一段窗口，在内存里按 beforeId 取「严格更早」且取靠近游标的最多 limit 条。
 */
function sliceOlderPageBeforeId(wideMappedAsc, beforeId, limit) {
  const idx = wideMappedAsc.findIndex((m) => m.id === beforeId)
  if (idx < 0) {
    return { page: [], hasMore: false, foundCursor: false }
  }
  const older = wideMappedAsc.slice(0, idx)
  const page = older.length <= limit ? older : older.slice(older.length - limit)
  const hasMore = older.length > limit
  return { page, hasMore, foundCursor: true }
}

async function loadHistoryMappedForSession(sessionId, sessionKey, limit, before) {
  const storageKey = historyCacheStorageKey(sessionKey, limit, before ?? '')
  if (HISTORY_CACHE_ENABLED) {
    const hit = historyCacheGet(storageKey)
    if (hit) {
      return { messages: structuredClone(hit.messages), hasMore: hit.hasMore }
    }
  }

  let history
  let mapped
  let hasMore

  try {
    history = await runGatewayCall('chat.history', buildChatHistoryParams(sessionKey, limit, before))
    mapped = sortMappedHistoryMessages(mapHistoryMessages(sessionId, history))
    if (before) mapped = applyBeforeCursorSanitize(mapped, before)
    hasMore = computeHistoryHasMore(history, mapped.length, limit)
  } catch (err) {
    if (!before) throw err
    bridgeLog('chat.history+before failed; wide fetch without before', {
      sessionKey,
      limit,
      before,
      err: err instanceof Error ? err.message : String(err),
    })
    const wideLimit = Math.min(HISTORY_PAGE_MAX, Math.max(limit * 20, 80))
    history = await runGatewayCall('chat.history', buildChatHistoryParams(sessionKey, wideLimit, undefined))
    const wideMapped = sortMappedHistoryMessages(mapHistoryMessages(sessionId, history))
    const { page, hasMore: hm, foundCursor } = sliceOlderPageBeforeId(wideMapped, before, limit)
    mapped = page
    if (!foundCursor) {
      bridgeLog('history before id missing in wide window', {
        before,
        wideLimit,
        wideLen: wideMapped.length,
      })
    }
    hasMore = foundCursor ? hm : false
  }

  if (HISTORY_CACHE_ENABLED) {
    historyCacheTouch(storageKey, { at: Date.now(), messages: structuredClone(mapped), hasMore })
  }
  return { messages: mapped, hasMore }
}

/**
 * Gateway → bridge `chat` 事件：建议 payload 含 sessionKey、state（delta|final|error）、runId、message；
 * 也接受 key / sessionId 别名，便于与 sessions.list、chat.send、chat.subscribe、chat.history 联调一致。
 */
/** Map gateway variants to bridge semantics so flushChatEvent sets runStatus / run.* timeline correctly. */
function canonicalizeGatewayChatState(state) {
  if (state == null || state === '') return state
  const s = String(state).toLowerCase().replace(/-/g, '_')
  if (['final', 'complete', 'completed', 'done', 'success', 'finished', 'end', 'ok'].includes(s)) return 'final'
  if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(s)) return 'error'
  if (
    ['delta', 'streaming', 'stream', 'partial', 'in_progress', 'running', 'generating', 'active', 'pending'].includes(s)
  ) {
    return 'delta'
  }
  return state
}

function normalizeChatEventPayload(raw) {
  if (raw == null || typeof raw !== 'object') return null
  const sessionKey = raw.sessionKey ?? raw.key ?? raw.session_key
  const sessionId = raw.sessionId ?? raw.session_id
  const runId = raw.runId ?? raw.run_id
  const rawState = raw.state ?? raw.phase ?? raw.status
  const state = rawState != null && rawState !== '' ? canonicalizeGatewayChatState(rawState) : rawState
  const errorMessage = raw.errorMessage ?? raw.error?.message ?? (typeof raw.error === 'string' ? raw.error : undefined)
  const stopReason = raw.stopReason ?? raw.stop_reason
  return {
    ...raw,
    sessionKey: sessionKey ? String(sessionKey) : undefined,
    sessionId: sessionId != null && sessionId !== '' ? String(sessionId) : undefined,
    runId,
    state,
    errorMessage,
    stopReason,
  }
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
    /** Web 客户端用的 sessionId（sessions.list.sessionId）→ 当前订阅的 sessionKey */
    this.sessionIdToKey = new Map()
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
              scopes: gatewayConnectScopes(),
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
          const rawPayload = msg.payload ?? msg.data ?? msg.body
          const normalized = normalizeChatEventPayload(rawPayload)
          bridgeLog('gateway.chat.event', {
            sessionKey: normalized?.sessionKey,
            sessionId: normalized?.sessionId,
            state: normalized?.state,
            runId: normalized?.runId,
            hasMessage: !!normalized?.message,
          })
          this.handleChatEvent(normalized ?? rawPayload)
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
          const prevSid = this.sessionKeyToId.get(previous)
          if (prevSid != null) this.sessionIdToKey.delete(prevSid)
          this.sessionKeyToId.delete(previous)
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
    this.sessionIdToKey.set(String(sessionId), sessionKey)

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
      const sid = this.sessionKeyToId.get(sessionKey)
      if (sid != null) this.sessionIdToKey.delete(String(sid))
      this.sessionKeyToId.delete(sessionKey)
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

    const parts = payload.message
      ? contentParts(payload.message.content, normalizeEndUserRole(payload.message.role), payload.message)
      : []
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
            role: part.role ?? normalizeEndUserRole(payload.message?.role) ?? 'assistant',
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
    if (payload == null || typeof payload !== 'object') return
    let sessionKey = payload.sessionKey
    if (!sessionKey && payload.sessionId != null) {
      sessionKey = this.sessionIdToKey.get(String(payload.sessionId))
    }
    if (!sessionKey) {
      bridgeLog('gateway.chat.event.skipped', {
        reason: 'no_session_key',
        sessionId: payload.sessionId,
        keys: Object.keys(payload).slice(0, 12),
      })
      return
    }
    invalidateHistoryCacheForSessionKey(sessionKey)
    const sessionId = this.sessionKeyToId.get(sessionKey)
    const clients = this.sessionToClients.get(sessionKey)
    if (!sessionId || !clients || clients.size === 0) {
      bridgeLog('gateway.chat.event.skipped', {
        reason: 'no_subscribed_clients',
        sessionKey,
        sessionId: sessionId ?? null,
        clientCount: clients?.size ?? 0,
      })
      return
    }

    this.pendingChatEvents.set(sessionKey, { ...payload, sessionKey })
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

app.get('/api/models', async (_req, res) => {
  try {
    const payload = await loadModelsCatalogPayload()
    res.json(payload)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'models_failed',
      source: 'error',
      models: [],
    })
  }
})

/** 斜杠命令补全列表；见 docs/web-console-slash-commands-contract.md */
const DEFAULT_SLASH_FALLBACK = [
  { trigger: '/help', description: '显示帮助', showInWeb: true },
  { trigger: '/model', description: '模型相关', showInWeb: true, argStyle: 'space_separated' },
  { trigger: '/reset', description: '重置会话上下文（语义以网关为准）', showInWeb: true },
]

let slashCommandsCatalogCache = null

function normalizeSlashCommandEntries(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((e) => e && typeof e.trigger === 'string' && e.trigger.trim() !== '')
    .map((e) => {
      const t = e.trigger.trim()
      const trigger = t.startsWith('/') ? t : `/${t}`
      const out = {
        trigger,
        description: String(e.description ?? ''),
        showInWeb: e.showInWeb !== false,
      }
      if (e.argStyle != null && String(e.argStyle) !== '') out.argStyle = String(e.argStyle)
      if (e.argHint != null && String(e.argHint) !== '') out.argHint = String(e.argHint)
      if (Array.isArray(e.examples) && e.examples.length) out.examples = e.examples.map((x) => String(x))
      return out
    })
}

async function loadSlashCommandsCatalog() {
  if (slashCommandsCatalogCache) return slashCommandsCatalogCache

  const envPath = process.env.OPENCLAW_WEB_SLASH_COMMANDS_JSON?.trim()
  const tryPaths = []
  if (envPath) {
    tryPaths.push(path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath))
  }
  tryPaths.push(path.join(__dirname, 'web-slash-commands.json'))

  for (const filePath of tryPaths) {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : parsed.commands
      if (Array.isArray(arr) && arr.length) {
        slashCommandsCatalogCache = {
          schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
          authorityNote:
            typeof parsed.authorityNote === 'string'
              ? parsed.authorityNote
              : '命令是否生效以 Gateway / TUI 为准；本列表仅供 Web 补全。',
          commands: normalizeSlashCommandEntries(arr),
        }
        return slashCommandsCatalogCache
      }
    } catch (err) {
      if (envPath && filePath === tryPaths[0]) {
        console.warn('[openclaw-web-api] OPENCLAW_WEB_SLASH_COMMANDS_JSON failed:', filePath, err?.message ?? err)
      }
    }
  }

  slashCommandsCatalogCache = {
    schemaVersion: 1,
    authorityNote: '使用内置回退列表；可配置 web-slash-commands.json 或 OPENCLAW_WEB_SLASH_COMMANDS_JSON。',
    commands: normalizeSlashCommandEntries(DEFAULT_SLASH_FALLBACK),
  }
  return slashCommandsCatalogCache
}

function buildSlashCommandsResponse(catalog, sessionMeta = {}) {
  const visible = catalog.commands.filter((c) => c.showInWeb)
  return {
    schemaVersion: catalog.schemaVersion,
    source: 'openclaw-web-api',
    authorityNote: catalog.authorityNote,
    commands: visible,
    ...sessionMeta,
  }
}

app.get('/api/commands', async (_req, res) => {
  try {
    const catalog = await loadSlashCommandsCatalog()
    res.json(buildSlashCommandsResponse(catalog))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'commands_failed' })
  }
})

app.get('/api/sessions/:sessionId/commands', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const catalog = await loadSlashCommandsCatalog()
    res.json(
      buildSlashCommandsResponse(catalog, {
        sessionId: req.params.sessionId,
        sessionKey: session.key,
      }),
    )
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res
      .status(code === 'session_not_found' ? 404 : 500)
      .json({ error: error instanceof Error ? error.message : 'commands_failed' })
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

    invalidateSessionsListCache()
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
    const limit = parseHistoryLimit(req.query.limit)
    const before = parseHistoryBeforeFromQuery(req.query)
    const { messages: mapped, hasMore } = await loadHistoryMappedForSession(
      req.params.sessionId,
      session.key,
      limit,
      before,
    )
    res.json({
      sessionId: req.params.sessionId,
      sessionKey: session.key,
      messages: mapped,
      hasMore,
    })
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
    invalidateHistoryCacheForSessionKey(session.key)
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
    invalidateHistoryCacheForSessionKey(session.key)
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

/** 透传网关 `sessions.patch`；白名单与 Web 一致；非法字段或类型返回 400 */
const SESSION_PATCH_ALLOWED_KEYS = new Set(['label', 'model', 'modelProvider', 'verbose', 'think'])

function buildSessionPatchPayloadStrict(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      error: { status: 400, code: 'invalid_body', message: '请求体须为 JSON 对象' },
    }
  }
  const keys = Object.keys(body)
  const unknown = keys.filter((k) => !SESSION_PATCH_ALLOWED_KEYS.has(k))
  if (unknown.length) {
    return {
      error: {
        status: 400,
        code: 'unknown_fields',
        message: `不支持的字段：${unknown.join(', ')}。仅允许：${[...SESSION_PATCH_ALLOWED_KEYS].join(', ')}`,
      },
    }
  }

  if (body.verbose !== undefined && body.verbose !== null && typeof body.verbose !== 'boolean') {
    return {
      error: { status: 400, code: 'invalid_verbose', message: 'verbose 必须为布尔类型（true / false）' },
    }
  }

  if (body.think !== undefined && body.think !== null && String(body.think).trim() !== '') {
    const t = String(body.think).trim().toLowerCase()
    if (t !== 'low' && t !== 'high' && t !== 'off') {
      return {
        error: { status: 400, code: 'invalid_think', message: 'think 仅允许 low、high、off' },
      }
    }
  }

  const out = {}
  for (const k of ['label', 'model', 'modelProvider']) {
    if (body[k] == null) continue
    const v = String(body[k]).trim()
    if (v !== '') out[k] = v
  }
  if (body.verbose === true || body.verbose === false) out.verbose = body.verbose
  if (body.think != null && String(body.think).trim() !== '') {
    out.think = String(body.think).trim().toLowerCase()
  }

  if (Object.keys(out).length === 0) {
    return {
      error: {
        status: 400,
        code: 'empty_patch',
        message: '至少需要一项有效更新：label / model / modelProvider / verbose / think',
      },
    }
  }

  return { patch: out }
}

/**
 * 网关 sessions.patch 仅支持部分字段（如 label、model）；verbose / think 需走 TUI 同款斜杠命令。
 */
function splitPatchForGateway(patch) {
  const core = {}
  if (patch.label != null && String(patch.label).trim() !== '') core.label = String(patch.label).trim()
  if (patch.model != null && String(patch.model).trim() !== '') core.model = String(patch.model).trim()
  if (patch.modelProvider != null && String(patch.modelProvider).trim() !== '')
    core.modelProvider = String(patch.modelProvider).trim()

  const slashMessages = []
  if (patch.verbose === true) slashMessages.push('/verbose on')
  if (patch.verbose === false) slashMessages.push('/verbose off')
  if (patch.think != null && String(patch.think).trim() !== '') {
    const t = String(patch.think).trim().toLowerCase()
    if (t === 'low' || t === 'high' || t === 'off') slashMessages.push(`/thinking ${t}`)
  }
  return { core, slashMessages }
}

function gatewaySessionPatchParams(sessionKey, core) {
  return { key: sessionKey, ...core }
}

function isLikelyUnsupportedGatewayMethodError(error) {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    m.includes('unknown') ||
    m.includes('not found') ||
    m.includes('unsupported') ||
    m.includes('invalid method') ||
    m.includes('no such method') ||
    m.includes('method_not_found') ||
    m.includes('404')
  )
}

/**
 * 优先独立 RPC（历史无 /compact 用户消息）；失败则回退 chat.send「/compact」。
 * OPENCLAW_COMPACT_METHOD=auto|sessions.compact|chat.compact|slash
 */
async function runCompactForSession(sessionKey) {
  const mode = (process.env.OPENCLAW_COMPACT_METHOD ?? 'auto').trim().toLowerCase()

  if (mode === 'slash' || mode === 'chat.send') {
    const result = await runGatewayCall(
      'chat.send',
      { sessionKey, message: '/compact', idempotencyKey: crypto.randomUUID() },
      60000,
    )
    return { via: 'chat.send:/compact', result }
  }

  const tryRpc = []
  if (mode === 'sessions.compact') tryRpc.push('sessions.compact')
  else if (mode === 'chat.compact') tryRpc.push('chat.compact')
  else {
    tryRpc.push('sessions.compact', 'chat.compact')
  }

  let lastErr
  for (const method of tryRpc) {
    try {
      const result = await runGatewayCall(method, { sessionKey }, 60000)
      return { via: method, result }
    } catch (e) {
      lastErr = e
      if (mode !== 'auto' && tryRpc.length === 1) throw e
      if (!isLikelyUnsupportedGatewayMethodError(e)) throw e
    }
  }

  if (mode !== 'auto' && tryRpc.length > 0) {
    throw lastErr ?? new Error('compact_rpc_failed')
  }

  const result = await runGatewayCall(
    'chat.send',
    { sessionKey, message: '/compact', idempotencyKey: crypto.randomUUID() },
    60000,
  )
  return { via: 'chat.send:/compact', result }
}

app.post('/api/sessions/:sessionId/patch', async (req, res) => {
  const built = buildSessionPatchPayloadStrict(req.body)
  if (built.error) {
    return res.status(built.error.status).json({
      error: built.error.code,
      message: built.error.message,
    })
  }

  try {
    const session = await resolveSession(req.params.sessionId)
    const { core, slashMessages } = splitPatchForGateway(built.patch)

    let result
    if (Object.keys(core).length > 0) {
      result = await runGatewayCall('sessions.patch', gatewaySessionPatchParams(session.key, core))
    }
    for (const message of slashMessages) {
      result = await runGatewayCall(
        'chat.send',
        { sessionKey: session.key, message, idempotencyKey: crypto.randomUUID() },
        60000,
      )
      invalidateHistoryCacheForSessionKey(session.key)
    }

    invalidateSessionsListCache()
    res.json({
      ok: true,
      sessionKey: session.key,
      patch: built.patch,
      applied: {
        sessionsPatch: Object.keys(core).length > 0 ? core : undefined,
        slashMessages: slashMessages.length ? slashMessages : undefined,
      },
      result,
    })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({
      error: 'session_patch_failed',
      message: error instanceof Error ? error.message : 'session_patch_failed',
    })
  }
})

/**
 * compact：默认依次尝试 sessions.compact、chat.compact，不支持则 chat.send「/compact」。
 * 环境变量 OPENCLAW_COMPACT_METHOD=auto|sessions.compact|chat.compact|slash
 */
app.post('/api/sessions/:sessionId/compact', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const { via, result } = await runCompactForSession(session.key)
    invalidateHistoryCacheForSessionKey(session.key)
    invalidateSessionsListCache()
    res.json({ ok: true, sessionKey: session.key, via, result })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    res.status(code === 'session_not_found' ? 404 : 500).json({
      error: 'compact_failed',
      message: error instanceof Error ? error.message : 'compact_failed',
    })
  }
})

app.delete('/api/sessions/:sessionId', async (req, res) => {
  try {
    const session = await resolveSession(req.params.sessionId)
    const result = await runGatewayCall('sessions.delete', { key: session.key })
    invalidateHistoryCacheForSessionKey(session.key)
    invalidateSessionsListCache()
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
        const { messages: mappedMessages, hasMore: batchHasMore } = await loadHistoryMappedForSession(
          data.sessionId,
          session.key,
          HISTORY_PAGE_DEFAULT,
          undefined,
        )
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
          hasMore: batchHasMore,
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

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[openclaw-web-api] 端口 ${PORT} 已被占用（${HOST}:${PORT}）。请结束占用该端口的进程（例如另一次 npm run dev / 调试会话），或改用环境变量 PORT，例如：PORT=3002 node server.mjs（同时要把 Vite 的 proxy 指到同一端口）。`,
    )
    process.exit(1)
  }
  console.error('[openclaw-web-api] HTTP server error:', err)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`OpenClaw Web UI listening on http://${HOST}:${PORT}`)
})
