function splitProviderFromId(fullId) {
  const s = String(fullId ?? '').trim()
  const i = s.indexOf('/')
  if (i <= 0) return { modelProvider: undefined, model: s }
  return { modelProvider: s.slice(0, i), model: s.slice(i + 1) }
}

export function normalizeModelCatalogEntry(item) {
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

export function normalizeModelsArray(arr) {
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

export function extractModelsFromStatusLike(obj) {
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

export function parseModelsListCliResponse(raw, sourceLabel) {
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

export function parseModelsStatusCliResponse(raw, sourceLabel) {
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

export async function loadModelsCatalogPayload(runOpenClawJson) {
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
  for (const { run } of attempts) {
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
