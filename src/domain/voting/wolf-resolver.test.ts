import { describe, expect, it } from 'vitest'
import type { PlayerId } from '../game/types'
import type { RandomSource } from './random'
import {
  resolveInitialWolfVote,
  resolveWolfRevote,
} from './wolf-resolver'

function recordingRandom(index = 0): {
  random: RandomSource
  pools: PlayerId[][]
} {
  const pools: PlayerId[][] = []
  return {
    pools,
    random: {
      pick<T>(values: readonly T[]): T {
        pools.push([...values] as PlayerId[])
        return values[index] as T
      },
    },
  }
}

describe('wolf resolver — abstain is neutral', () => {
  it('selects the only positive target when another wolf abstains', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau', 'wolf-b': null },
      random,
    })

    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'chau', random: false, reason: 'UNIQUE_TOP' },
    })
  })

  it('keeps a two-vote majority with a third wolf abstaining', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'REVOTE_10S',
      actorIds: ['wolf-a', 'wolf-b', 'wolf-c'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'chau', 'wolf-c': null },
      random,
    })

    expect(resolution.status).toBe('RESOLVED')
    if (resolution.status === 'RESOLVED') {
      expect(resolution.result.targetId).toBe('chau')
      expect(resolution.result.random).toBe(false)
    }
  })

  it('supports N wolves rather than a fixed pair', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b', 'wolf-c'],
      eligibleTargetIds: ['chau', 'minh', 'lan'],
      votes: { 'wolf-a': 'minh', 'wolf-b': 'chau', 'wolf-c': 'minh' },
      random,
    })

    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'minh', random: false, reason: 'UNIQUE_TOP' },
    })
  })
})

describe('RANDOM_ON_TIE', () => {
  it('randomizes only among positive top tied targets', () => {
    const { random, pools } = recordingRandom(1)
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh', 'lan'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'minh' },
      random,
    })

    expect(pools).toEqual([['chau', 'minh']])
    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: {
        targetId: 'minh',
        random: true,
        reason: 'TIED_TOP_RANDOM',
      },
    })
  })

  it('randomizes among all eligible targets only when everyone abstains', () => {
    const { random, pools } = recordingRandom(1)
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh', 'lan'],
      votes: { 'wolf-a': null, 'wolf-b': null },
      random,
    })

    expect(pools).toEqual([['chau', 'minh', 'lan']])
    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: {
        targetId: 'minh',
        random: true,
        reason: 'ALL_ABSTAIN_RANDOM',
      },
    })
  })
})

describe('REVOTE_10S', () => {
  it('opens a revote containing only the initially tied targets', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'REVOTE_10S',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh', 'lan'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'minh' },
      random,
    })

    expect(resolution).toEqual({
      status: 'REVOTE_REQUIRED',
      tiedTargetIds: ['chau', 'minh'],
    })
  })

  it('selects one positive revote target when another wolf abstains', () => {
    const { random } = recordingRandom()
    const result = resolveWolfRevote({
      actorIds: ['wolf-a', 'wolf-b'],
      initialTiedTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau', 'wolf-b': null },
      random,
    })

    expect(result).toEqual({
      targetId: 'chau',
      random: false,
      reason: 'REVOTE_UNIQUE_TOP',
    })
  })

  it('randomizes only among current tied leaders at the deadline', () => {
    const { random, pools } = recordingRandom(1)
    const result = resolveWolfRevote({
      actorIds: ['wolf-a', 'wolf-b', 'wolf-c', 'wolf-d'],
      initialTiedTargetIds: ['chau', 'minh', 'lan'],
      votes: {
        'wolf-a': 'chau',
        'wolf-b': 'minh',
        'wolf-c': 'chau',
        'wolf-d': 'minh',
      },
      random,
    })

    expect(pools).toEqual([['chau', 'minh']])
    expect(result).toEqual({
      targetId: 'minh',
      random: true,
      reason: 'REVOTE_TIED_RANDOM',
    })
  })

  it('falls back to the initial tied set when every wolf abstains', () => {
    const { random, pools } = recordingRandom(1)
    const result = resolveWolfRevote({
      actorIds: ['wolf-a', 'wolf-b'],
      initialTiedTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': null, 'wolf-b': null },
      random,
    })

    expect(pools).toEqual([['chau', 'minh']])
    expect(result).toEqual({
      targetId: 'minh',
      random: true,
      reason: 'REVOTE_ALL_ABSTAIN_RANDOM',
    })
  })
})
