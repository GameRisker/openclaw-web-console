import { describe, expect, it, vi } from 'vitest'
import { loadModelsCatalogPayload } from '../lib/models.mjs'

describe('loadModelsCatalogPayload', () => {
  it('uses status models first when available', async () => {
    const runOpenClawJson = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        return { models: ['openai/gpt-5-mini'] }
      }
      throw new Error('should_not_call_fallback')
    })

    const result = await loadModelsCatalogPayload(runOpenClawJson)
    expect(result.source).toBe('openclaw status --json')
    expect(result.models).toHaveLength(1)
  })

  it('falls back to models list when status has no models', async () => {
    const runOpenClawJson = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd === 'status --json') return { ok: true }
      if (cmd === 'models list --json') return { models: ['zai/glm-4.7'] }
      throw new Error(`unexpected:${cmd}`)
    })

    const result = await loadModelsCatalogPayload(runOpenClawJson)
    expect(result.source).toBe('openclaw models list --json')
    expect(result.models[0]).toMatchObject({ id: 'zai/glm-4.7' })
  })

  it('returns empty payload when all probes fail', async () => {
    const runOpenClawJson = vi.fn(async () => {
      throw new Error('boom')
    })

    const result = await loadModelsCatalogPayload(runOpenClawJson)
    expect(result.source).toBe('empty')
    expect(result.models).toEqual([])
    expect(result.error).toBe('boom')
  })
})
