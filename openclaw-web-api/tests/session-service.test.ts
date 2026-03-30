import { describe, expect, it, vi } from 'vitest'
import {
  applyGatewaySessionPreferencePatch,
  normalizeSession,
  normalizeSessionBool,
  normalizeSessionThinkLevel,
} from '../lib/session-service.mjs'

describe('normalizeSessionBool', () => {
  it('normalizes bool-like values', () => {
    expect(normalizeSessionBool(true)).toBe(true)
    expect(normalizeSessionBool('true')).toBe(true)
    expect(normalizeSessionBool(0)).toBe(false)
    expect(normalizeSessionBool('nope')).toBeUndefined()
  })
})

describe('normalizeSessionThinkLevel', () => {
  it('normalizes think aliases', () => {
    expect(normalizeSessionThinkLevel('minimal')).toBe('low')
    expect(normalizeSessionThinkLevel('maximum')).toBe('high')
    expect(normalizeSessionThinkLevel('disabled')).toBe('off')
  })
})

describe('normalizeSession', () => {
  it('normalizes verbose and think fields from variant names', () => {
    const result = normalizeSession({
      key: 'agent:main:tui-1',
      sessionId: '123',
      thinkingLevel: 'maximum',
      verboseEnabled: 'true',
      model: 'gpt-5-mini',
      modelProvider: 'openai',
    })

    expect(result).toMatchObject({
      key: 'agent:main:tui-1',
      sessionId: '123',
      think: 'high',
      verbose: true,
      model: 'gpt-5-mini',
      modelProvider: 'openai',
    })
  })
})

describe('applyGatewaySessionPreferencePatch', () => {
  it('applies core patch via sessions.patch only', async () => {
    const runGatewayCall = vi.fn().mockResolvedValue({ ok: true })
    const invalidateHistoryCacheForSessionKey = vi.fn()
    const cryptoImpl = { randomUUID: vi.fn(() => 'uuid-1') }

    await applyGatewaySessionPreferencePatch(
      'agent:main:tui-1',
      { label: 'Renamed' },
      { runGatewayCall, invalidateHistoryCacheForSessionKey, cryptoImpl },
    )

    expect(runGatewayCall).toHaveBeenCalledTimes(1)
    expect(runGatewayCall).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:tui-1',
      label: 'Renamed',
    })
    expect(invalidateHistoryCacheForSessionKey).not.toHaveBeenCalled()
  })

  it('applies verbose/think via chat.send slash commands', async () => {
    const runGatewayCall = vi.fn().mockResolvedValue({ ok: true })
    const invalidateHistoryCacheForSessionKey = vi.fn()
    const cryptoImpl = { randomUUID: vi.fn(() => 'uuid-1') }

    await applyGatewaySessionPreferencePatch(
      'agent:main:tui-1',
      { verbose: false, think: 'low' },
      { runGatewayCall, invalidateHistoryCacheForSessionKey, cryptoImpl },
    )

    expect(runGatewayCall).toHaveBeenNthCalledWith(
      1,
      'chat.send',
      { sessionKey: 'agent:main:tui-1', message: '/verbose off', idempotencyKey: 'uuid-1' },
      60000,
    )
    expect(runGatewayCall).toHaveBeenNthCalledWith(
      2,
      'chat.send',
      { sessionKey: 'agent:main:tui-1', message: '/thinking low', idempotencyKey: 'uuid-1' },
      60000,
    )
    expect(invalidateHistoryCacheForSessionKey).toHaveBeenCalledTimes(2)
  })
})
