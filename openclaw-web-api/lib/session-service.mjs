export function normalizeSessionBool(value) {
  if (value === true || value === false) return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return undefined
}

export function normalizeSessionThinkLevel(raw) {
  if (raw == null || raw === '') return undefined
  const s = String(raw).trim().toLowerCase().replace(/-/g, '_')
  if (['low', 'minimal', 'min', 'small'].includes(s)) return 'low'
  if (['high', 'xhigh', 'max', 'maximum', 'heavy'].includes(s)) return 'high'
  if (['off', 'none', 'no', 'disabled', 'false', '0'].includes(s)) return 'off'
  if (['low', 'high', 'off'].includes(s)) return s
  return undefined
}

export function normalizeSession(item) {
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

export function splitPatchForGateway(patch) {
  const core = {}
  if (patch.label != null && String(patch.label).trim() !== '') core.label = String(patch.label).trim()
  if (patch.model != null && String(patch.model).trim() !== '') core.model = String(patch.model).trim()
  if (patch.modelProvider != null && String(patch.modelProvider).trim() !== '') {
    core.modelProvider = String(patch.modelProvider).trim()
  }

  const slashMessages = []
  if (patch.verbose === true) slashMessages.push('/verbose on')
  if (patch.verbose === false) slashMessages.push('/verbose off')
  if (patch.think != null && String(patch.think).trim() !== '') {
    const t = String(patch.think).trim().toLowerCase()
    if (t === 'low' || t === 'high' || t === 'off') slashMessages.push(`/thinking ${t}`)
  }
  return { core, slashMessages }
}

export function gatewaySessionPatchParams(sessionKey, core) {
  return { key: sessionKey, ...core }
}

export async function applyGatewaySessionPreferencePatch(sessionKey, patch, deps) {
  const { runGatewayCall, invalidateHistoryCacheForSessionKey, cryptoImpl } = deps
  const { core, slashMessages } = splitPatchForGateway(patch)
  let result
  if (Object.keys(core).length > 0) {
    result = await runGatewayCall('sessions.patch', gatewaySessionPatchParams(sessionKey, core))
  }
  for (const message of slashMessages) {
    result = await runGatewayCall(
      'chat.send',
      { sessionKey, message, idempotencyKey: cryptoImpl.randomUUID() },
      60000,
    )
    invalidateHistoryCacheForSessionKey(sessionKey)
  }
  return result
}
