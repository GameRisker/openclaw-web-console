import { describe, expect, it } from 'vitest'
import { agentsDerivedFromSessionsList, mergeAgentListsById, parseAgentSlotFromSessionKey } from '../lib/agents.mjs'

describe('parseAgentSlotFromSessionKey', () => {
  it('extracts slot from session key', () => {
    expect(parseAgentSlotFromSessionKey('agent:main:tui-123')).toBe('main')
  })

  it('returns null for non-agent key', () => {
    expect(parseAgentSlotFromSessionKey('session:abc')).toBeNull()
  })
})

describe('agentsDerivedFromSessionsList', () => {
  it('derives agents from session keys and groups non-agent sessions', () => {
    const result = agentsDerivedFromSessionsList({
      sessions: [
        { key: 'agent:main:tui-1', updatedAt: 100 },
        { key: 'agent:main:tui-2', updatedAt: 120 },
        { key: 'agent:research:tui-3', updatedAt: 110 },
        { key: 'misc-session', updatedAt: 90 },
      ],
    })

    expect(result.map((x) => x.id)).toEqual(['main', 'research', '_other'])
    expect(result.find((x) => x.id === 'main')?.description).toBe('2 个会话')
  })
})

describe('mergeAgentListsById', () => {
  it('merges gateway agents over derived agents while preserving derived entries', () => {
    const result = mergeAgentListsById(
      [
        { agentId: 'main', label: 'Main Agent', updatedAt: 200, model: 'gpt-5-mini' },
      ],
      [
        { agentId: 'main', id: 'main', label: 'main', updatedAt: 100, description: '2 个会话' },
        { agentId: 'research', id: 'research', label: 'research', updatedAt: 150, description: '1 个会话' },
      ],
    )

    expect(result.map((x) => x.id)).toEqual(['main', 'research'])
    expect(result[0]).toMatchObject({
      id: 'main',
      label: 'Main Agent',
      model: 'gpt-5-mini',
      updatedAt: 200,
    })
  })
})
