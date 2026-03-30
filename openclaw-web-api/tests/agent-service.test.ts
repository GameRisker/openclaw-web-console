import { describe, expect, it } from 'vitest'
import { normalizeAgentListItem } from '../lib/agent-service.mjs'

describe('normalizeAgentListItem', () => {
  it('returns null for invalid input', () => {
    expect(normalizeAgentListItem(null)).toBeNull()
    expect(normalizeAgentListItem({})).toBeNull()
  })

  it('normalizes id/status/timestamps', () => {
    const result = normalizeAgentListItem({
      agentId: 'research',
      label: 'Research Agent',
      status: 'idle',
      updatedAt: '2026-03-30T12:00:00.000Z',
      createdAt: '2026-03-29T12:00:00.000Z',
      model: 'glm-4.7',
      modelProvider: 'zai',
    })

    expect(result).toMatchObject({
      agentId: 'research',
      id: 'research',
      label: 'Research Agent',
      status: 'idle',
      model: 'glm-4.7',
      modelProvider: 'zai',
    })
    expect(result?.updatedAt).toBeTypeOf('number')
    expect(result?.createdAt).toBeTypeOf('number')
  })
})
