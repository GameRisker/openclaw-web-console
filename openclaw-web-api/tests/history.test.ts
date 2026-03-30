import { describe, expect, it } from 'vitest'
import { applyBeforeCursorSanitize, computeHistoryHasMore, pickGatewayHasMoreFlag, sliceOlderPageBeforeId } from '../lib/history.mjs'

describe('pickGatewayHasMoreFlag', () => {
  it('reads explicit boolean flags', () => {
    expect(pickGatewayHasMoreFlag({ hasMore: true })).toBe(true)
    expect(pickGatewayHasMoreFlag({ has_more: false })).toBe(false)
  })

  it('derives true from next cursor fields', () => {
    expect(pickGatewayHasMoreFlag({ nextCursor: 'abc' })).toBe(true)
  })
})

describe('computeHistoryHasMore', () => {
  it('prefers explicit false over heuristics', () => {
    expect(computeHistoryHasMore({ hasMore: false }, 20, 20)).toBe(false)
  })

  it('falls back to length heuristic when explicit flag missing', () => {
    expect(computeHistoryHasMore({}, 20, 20)).toBe(true)
    expect(computeHistoryHasMore({}, 19, 20)).toBe(false)
  })
})

describe('applyBeforeCursorSanitize', () => {
  it('removes before cursor and everything after it', () => {
    const result = applyBeforeCursorSanitize(
      [{ id: '1' }, { id: '2' }, { id: '3' }],
      '2',
    )
    expect(result).toEqual([{ id: '1' }])
  })
})

describe('sliceOlderPageBeforeId', () => {
  it('returns older page before cursor with hasMore', () => {
    const result = sliceOlderPageBeforeId(
      [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
      '4',
      2,
    )
    expect(result).toEqual({
      page: [{ id: '2' }, { id: '3' }],
      hasMore: true,
      foundCursor: true,
    })
  })

  it('returns empty result when cursor missing', () => {
    const result = sliceOlderPageBeforeId([{ id: '1' }], '9', 2)
    expect(result).toEqual({ page: [], hasMore: false, foundCursor: false })
  })
})
