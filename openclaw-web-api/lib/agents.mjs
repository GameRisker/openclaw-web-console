export function toTimestampMs(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseAgentSlotFromSessionKey(key) {
  if (key == null || typeof key !== 'string') return null
  const m = /^agent:([^:]+):/.exec(key.trim())
  return m ? m[1] : null
}

export function agentsDerivedFromSessionsList(result) {
  const sessions = Array.isArray(result?.sessions) ? result.sessions : []
  const bySlot = new Map()
  for (const s of sessions) {
    const slot = parseAgentSlotFromSessionKey(String(s.key ?? ''))
    const bucketId = slot ?? '_other'
    const updatedAt =
      typeof s.updatedAt === 'number' && s.updatedAt > 0
        ? s.updatedAt
        : toTimestampMs(s.updatedAt)
    const prev = bySlot.get(bucketId)
    if (!prev) {
      bySlot.set(bucketId, { sessionCount: 1, updatedAt, slot })
    } else {
      prev.sessionCount += 1
      if (updatedAt > prev.updatedAt) prev.updatedAt = updatedAt
    }
  }
  const agents = []
  for (const [bucketId, pack] of bySlot) {
    const isOther = bucketId === '_other'
    agents.push({
      agentId: bucketId,
      id: bucketId,
      label: isOther ? '其他会话' : bucketId,
      displayName: isOther ? '非 agent:* 命名空间的会话' : `Agent · ${bucketId}`,
      description: `${pack.sessionCount} 个会话`,
      status: 'idle',
      updatedAt: pack.updatedAt > 0 ? pack.updatedAt : Date.now(),
    })
  }
  agents.sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)),
  )
  return agents
}

export function mergeAgentListsById(gatewayAgents, derivedAgents) {
  const byId = new Map()

  for (const d of derivedAgents) {
    const id = String(d.agentId ?? d.id ?? '').trim()
    if (!id) continue
    byId.set(id, { ...d })
  }

  for (const g of gatewayAgents) {
    const id = String(g.agentId ?? g.id ?? '').trim()
    if (!id) continue
    const prev = byId.get(id)
    if (prev) {
      const uG = Number(g.updatedAt) || 0
      const uP = Number(prev.updatedAt) || 0
      byId.set(id, {
        agentId: id,
        id,
        label: g.label ?? g.displayName ?? prev.label,
        displayName: g.displayName ?? prev.displayName,
        description: g.description ?? prev.description,
        status: g.status ?? g.state ?? prev.status,
        state: g.state ?? prev.state,
        model: g.model ?? prev.model,
        modelProvider: g.modelProvider ?? prev.modelProvider,
        key: g.key ?? prev.key,
        name: g.name ?? prev.name,
        updatedAt: Math.max(uG, uP) || prev.updatedAt,
        createdAt: g.createdAt ?? prev.createdAt,
      })
    } else {
      byId.set(id, g)
    }
  }

  const merged = [...byId.values()]
  merged.sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)),
  )
  return merged
}
