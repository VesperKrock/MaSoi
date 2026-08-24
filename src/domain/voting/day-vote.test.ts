import { describe, expect, it } from 'vitest'
import { resolveDayVote } from './day-vote'

describe('day vote', () => {
  it('proposes a unique top target', () => {
    expect(
      resolveDayVote(
        { a: 'chau', b: 'chau', c: 'minh' },
        ['a', 'b', 'c'],
        ['chau', 'minh'],
      ),
    ).toEqual({
      kind: 'UNIQUE',
      targetIds: ['chau'],
      counts: { chau: 2, minh: 1 },
    })
  })

  it('reports a tie without inventing a tiebreak rule', () => {
    expect(
      resolveDayVote(
        { a: 'chau', b: 'minh' },
        ['a', 'b'],
        ['chau', 'minh'],
      ),
    ).toEqual({
      kind: 'TIE',
      targetIds: ['chau', 'minh'],
      counts: { chau: 1, minh: 1 },
    })
  })
})
