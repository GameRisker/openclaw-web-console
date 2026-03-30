import { describe, expect, it } from 'vitest'

function splitProviderFromId(fullId: string) {
  const s = String(fullId ?? '').trim()
  const i = s.indexOf('/')
  if (i <= 0) return { modelProvider: undefined, model: s }
  return { modelProvider: s.slice(0, i), model: s.slice(i + 1) }
}

function normalizeModelCatalogEntry(item: unknown) {
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
  const x = item as Record<string, unknown>
  const prov = x.modelProvider ?? x.provider ?? x.vendor
  const modOnly = x.model != null && String(x.model).trim() !== '' ? String(x.model).trim() : null
  let id =
    x.key != null && String(x.key).trim() !== ''
      ? String(x.key).trim()
      : x.id != null && String(x.id).trim() !== ''
        ? String(x.id).trim()
        : null
  if (!id && modOnly && prov) id = `${String(prov).trim()}/${modOnly}`
  if (!id && modOnly) id = modOnly
  if (!id) return null
  const sp = splitProviderFromId(id)
  const name = String(x.name ?? x.label ?? x.displayName ?? id)
  return {
    id,
    model: sp.model,
    name,
    label: name,
    ...(sp.modelProvider ? { modelProvider: sp.modelProvider } : {}),
  }
}

describe('normalizeModelCatalogEntry', () => {
  it('normalizes provider/model string ids', () => {
    expect(normalizeModelCatalogEntry('openai/gpt-5-mini')).toEqual({
      id: 'openai/gpt-5-mini',
      model: 'gpt-5-mini',
      name: 'openai/gpt-5-mini',
      label: 'openai/gpt-5-mini',
      modelProvider: 'openai',
    })
  })

  it('builds id from provider + model fields', () => {
    expect(normalizeModelCatalogEntry({ provider: 'zai', model: 'glm-4.7', label: 'GLM-4.7' })).toEqual({
      id: 'zai/glm-4.7',
      model: 'glm-4.7',
      name: 'GLM-4.7',
      label: 'GLM-4.7',
      modelProvider: 'zai',
    })
  })
})
