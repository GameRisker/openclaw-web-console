import { describe, expect, it } from 'vitest'
import { buildSessionPatchPayloadStrict, canonicalizeGatewayChatState, splitPatchForGateway } from '../lib/sessions.mjs'

describe('buildSessionPatchPayloadStrict', () => {
  it('accepts valid patch payload', () => {
    const result = buildSessionPatchPayloadStrict({ label: '  Demo  ', verbose: true, think: 'HIGH' })
    expect(result).toEqual({
      patch: {
        label: 'Demo',
        verbose: true,
        think: 'high',
      },
    })
  })

  it('rejects unknown fields', () => {
    const result = buildSessionPatchPayloadStrict({ label: 'ok', foo: 'bar' })
    expect(result.error?.code).toBe('unknown_fields')
  })

  it('rejects invalid verbose type', () => {
    const result = buildSessionPatchPayloadStrict({ verbose: 'yes' })
    expect(result.error?.code).toBe('invalid_verbose')
  })

  it('rejects invalid think value', () => {
    const result = buildSessionPatchPayloadStrict({ think: 'medium' })
    expect(result.error?.code).toBe('invalid_think')
  })

  it('rejects empty patch', () => {
    const result = buildSessionPatchPayloadStrict({ label: '   ' })
    expect(result.error?.code).toBe('empty_patch')
  })
})

describe('splitPatchForGateway', () => {
  it('splits core patch and slash messages', () => {
    const result = splitPatchForGateway({
      label: 'Test',
      model: 'gpt-5-mini',
      modelProvider: 'openai',
      verbose: false,
      think: 'low',
    })
    expect(result).toEqual({
      core: {
        label: 'Test',
        model: 'gpt-5-mini',
        modelProvider: 'openai',
      },
      slashMessages: ['/verbose off', '/thinking low'],
    })
  })
})

describe('canonicalizeGatewayChatState', () => {
  it('normalizes final-like states', () => {
    expect(canonicalizeGatewayChatState('completed')).toBe('final')
    expect(canonicalizeGatewayChatState('done')).toBe('final')
  })

  it('normalizes error-like states', () => {
    expect(canonicalizeGatewayChatState('failed')).toBe('error')
    expect(canonicalizeGatewayChatState('cancelled')).toBe('error')
  })

  it('normalizes delta-like states', () => {
    expect(canonicalizeGatewayChatState('streaming')).toBe('delta')
    expect(canonicalizeGatewayChatState('running')).toBe('delta')
  })
})
