import { applyBeforeCursorSanitize, computeHistoryHasMore, sliceOlderPageBeforeId } from './history.mjs'

export const HISTORY_PAGE_DEFAULT = 20
export const HISTORY_PAGE_MAX = 200

export function parseHistoryLimit(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return HISTORY_PAGE_DEFAULT
  return Math.min(HISTORY_PAGE_MAX, Math.floor(n))
}

export function buildChatHistoryParams(sessionKey, limit, before) {
  const params = { sessionKey, limit }
  if (before) params.before = before
  return params
}

export function parseHistoryBeforeFromQuery(query) {
  const raw = query.before ?? query.beforeMessageId ?? query.cursor ?? query.before_id
  if (raw == null) return undefined
  const s = String(raw).trim()
  return s === '' ? undefined : s
}

export function sortMappedHistoryMessages(mapped, toTimestampMs) {
  return [...mapped].sort(
    (a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp) || String(a.id).localeCompare(String(b.id)),
  )
}

export function createHistoryCache(config = {}) {
  const enabled = config.enabled ?? !/^0|false|no$/i.test(String(process.env.HISTORY_CACHE_ENABLED ?? '1').trim())
  const maxEntries =
    config.maxEntries ??
    Math.min(2000, Math.max(16, Number.parseInt(process.env.HISTORY_CACHE_MAX_ENTRIES ?? '256', 10) || 256))
  const ttlMs = config.ttlMs ?? Math.max(0, Number.parseInt(process.env.HISTORY_CACHE_TTL_MS ?? '0', 10) || 0)

  const store = new Map()

  function storageKey(sessionKey, limit, before) {
    return `${sessionKey}\x1e${limit}\x1e${before ?? ''}`
  }

  function touch(key, entry) {
    if (store.has(key)) store.delete(key)
    store.set(key, entry)
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
  }

  function get(key) {
    const entry = store.get(key)
    if (!entry) return null
    if (ttlMs > 0 && Date.now() - entry.at > ttlMs) {
      store.delete(key)
      return null
    }
    store.delete(key)
    store.set(key, entry)
    return entry
  }

  function invalidateSession(sessionKey) {
    if (!sessionKey) return
    const prefix = `${sessionKey}\x1e`
    for (const k of [...store.keys()]) {
      if (k.startsWith(prefix)) store.delete(k)
    }
  }

  return {
    enabled,
    storageKey,
    touch,
    get,
    invalidateSession,
  }
}

export async function loadHistoryMappedForSession({
  sessionId,
  sessionKey,
  limit,
  before,
  runGatewayCall,
  mapHistoryMessages,
  toTimestampMs,
  cache,
  structuredCloneImpl = structuredClone,
  bridgeLog = () => {},
}) {
  const storageKey = cache.storageKey(sessionKey, limit, before ?? '')
  if (cache.enabled) {
    const hit = cache.get(storageKey)
    if (hit) {
      return { messages: structuredCloneImpl(hit.messages), hasMore: hit.hasMore }
    }
  }

  let history
  let mapped
  let hasMore

  try {
    history = await runGatewayCall('chat.history', buildChatHistoryParams(sessionKey, limit, before))
    mapped = sortMappedHistoryMessages(mapHistoryMessages(sessionId, history), toTimestampMs)
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
    const wideMapped = sortMappedHistoryMessages(mapHistoryMessages(sessionId, history), toTimestampMs)
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

  if (cache.enabled) {
    cache.touch(storageKey, { at: Date.now(), messages: structuredCloneImpl(mapped), hasMore })
  }
  return { messages: mapped, hasMore }
}
