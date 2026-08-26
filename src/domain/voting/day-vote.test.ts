import { describe, expect, it } from 'vitest'
import {
  createDayHangingEffect,
  createHunterRevengeEffect,
  getDayVoteWeight,
  resolveDayVote,
} from './day-vote'

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

  it('uses server-derived Mayor weight and treats one positive vote as sufficient', () => {
    expect(getDayVoteWeight('mayor')).toBe(2)
    expect(getDayVoteWeight('villager')).toBe(1)
    expect(
      resolveDayVote(
        { mayor: 'chau', normal: 'minh' },
        ['mayor', 'normal', 'abstain'],
        ['chau', 'minh'],
        { mayor: 2, normal: 1 },
      ),
    ).toEqual({
      kind: 'UNIQUE',
      targetIds: ['chau'],
      counts: { chau: 2, minh: 1 },
    })
    expect(resolveDayVote({ a: 'chau' }, ['a', 'b'], ['chau'])).toMatchObject({
      kind: 'UNIQUE',
      targetIds: ['chau'],
    })
  })

  it('resolves a weighted top tie and all abstain to no hanging', () => {
    expect(
      resolveDayVote(
        { mayor: 'chau', a: 'minh', b: 'minh' },
        ['mayor', 'a', 'b'],
        ['chau', 'minh'],
        { mayor: 2 },
      ),
    ).toEqual({
      kind: 'TIE',
      targetIds: ['chau', 'minh'],
      counts: { chau: 2, minh: 2 },
    })
    expect(resolveDayVote({ a: null }, ['a', 'b'], ['chau'])).toEqual({
      kind: 'NO_VOTES',
      targetIds: [],
      counts: {},
    })
  })

  it('models hanging and revenge as final source-aware non-blockable effects', () => {
    expect(createDayHangingEffect('hang', 'hunter')).toMatchObject({
      sourceType: 'DAY_HANGING',
      protectorBlockable: false,
      finalized: true,
    })
    expect(createHunterRevengeEffect('shot', 'hunter', 'target')).toMatchObject({
      sourceType: 'HUNTER_REVENGE_SHOT',
      sourceRoleId: 'hunter',
      protectorBlockable: false,
      finalized: true,
    })
  })
})
