export function toTimestampMs(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeAgentListItem(item) {
  if (!item || typeof item !== 'object') return null
  const id = item.agentId ?? item.id ?? item.key
  if (id == null || String(id).trim() === '') return null
  const agentId = String(item.agentId ?? item.id ?? id).trim()
  return {
    agentId,
    id: String(item.id ?? item.agentId ?? agentId).trim(),
    key: item.key,
    name: item.name,
    label: item.label,
    displayName: item.displayName,
    description: item.description,
    status: item.status ?? item.state,
    state: item.state,
    updatedAt:
      typeof item.updatedAt === 'number' && item.updatedAt > 0
        ? item.updatedAt
        : toTimestampMs(item.updatedAt),
    createdAt:
      typeof item.createdAt === 'number' && item.createdAt > 0
        ? item.createdAt
        : toTimestampMs(item.createdAt),
    model: item.model,
    modelProvider: item.modelProvider,
  }
}
