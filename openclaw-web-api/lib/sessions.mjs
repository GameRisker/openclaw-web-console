export const SESSION_PATCH_ALLOWED_KEYS = new Set(['label', 'model', 'modelProvider', 'verbose', 'think'])

export function buildSessionPatchPayloadStrict(body) {
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

export function canonicalizeGatewayChatState(state) {
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
