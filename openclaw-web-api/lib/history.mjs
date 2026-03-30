export function pickGatewayHasMoreFlag(raw) {
  if (raw == null || typeof raw !== 'object') return undefined
  if (typeof raw.hasMore === 'boolean') return raw.hasMore
  if (typeof raw.has_more === 'boolean') return raw.has_more
  if (typeof raw.more === 'boolean') return raw.more
  if (raw.nextCursor != null && String(raw.nextCursor).trim() !== '') return true
  if (raw.next_cursor != null && String(raw.next_cursor).trim() !== '') return true
  return undefined
}

export function computeHistoryHasMore(gatewayPayload, mappedLength, limit) {
  const explicit = pickGatewayHasMoreFlag(gatewayPayload)
  if (explicit === false) return false
  if (explicit === true) return true
  return mappedLength >= limit
}

export function applyBeforeCursorSanitize(mappedSortedAsc, beforeId) {
  if (!beforeId || mappedSortedAsc.length === 0) return mappedSortedAsc
  const idx = mappedSortedAsc.findIndex((m) => m.id === beforeId)
  if (idx >= 0) return mappedSortedAsc.slice(0, idx)
  return mappedSortedAsc.filter((m) => m.id !== beforeId)
}

export function sliceOlderPageBeforeId(wideMappedAsc, beforeId, limit) {
  const idx = wideMappedAsc.findIndex((m) => m.id === beforeId)
  if (idx < 0) {
    return { page: [], hasMore: false, foundCursor: false }
  }
  const older = wideMappedAsc.slice(0, idx)
  const page = older.length <= limit ? older : older.slice(older.length - limit)
  const hasMore = older.length > limit
  return { page, hasMore, foundCursor: true }
}
