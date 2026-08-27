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

describe('wolf resolver — mandatory target', () => {
  it('resolves a single voter target without random selection', () => {
    const { random, pools } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau' },
      random,
    })

    expect(pools).toEqual([])
    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'chau', random: false, reason: 'UNIQUE_TOP' },
    })
  })

  it('rejects zero valid ballots instead of inventing a no-kill or random target', () => {
    const { random, pools } = recordingRandom(1)
    expect(() => resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': null },
      random,
    })).toThrow('WOLF_TARGET_REQUIRED')
    expect(pools).toEqual([])
  })

  it('selects the only confirmed target when a teammate has not submitted', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau' },
      random,
    })

    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'chau', random: false, reason: 'UNIQUE_TOP' },
    })
  })

  it('keeps a two-vote majority with a third wolf missing', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'REVOTE_10S',
      actorIds: ['wolf-a', 'wolf-b', 'wolf-c'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'chau' },
      random,
    })

    expect(resolution.status).toBe('RESOLVED')
    if (resolution.status === 'RESOLVED') {
      expect(resolution.result.targetId).toBe('chau')
      expect(resolution.result.random).toBe(false)
    }
  })

  it('resolves two matching votes as a unique top', () => {
    const { random } = recordingRandom()
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'chau' },
      random,
    })

    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'chau', random: false, reason: 'UNIQUE_TOP' },
    })
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

  it('randomizes a three-way top tie only among those three leaders', () => {
    const { random, pools } = recordingRandom(2)
    const resolution = resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b', 'wolf-c'],
      eligibleTargetIds: ['chau', 'minh', 'lan', 'an'],
      votes: { 'wolf-a': 'chau', 'wolf-b': 'minh', 'wolf-c': 'lan' },
      random,
    })

    expect(pools).toEqual([['chau', 'minh', 'lan']])
    expect(resolution).toEqual({
      status: 'RESOLVED',
      result: { targetId: 'lan', random: true, reason: 'TIED_TOP_RANDOM' },
    })
  })

  it('rejects an empty ballot set', () => {
    const { random, pools } = recordingRandom(1)
    expect(() => resolveInitialWolfVote({
      policy: 'RANDOM_ON_TIE',
      actorIds: ['wolf-a', 'wolf-b'],
      eligibleTargetIds: ['chau', 'minh', 'lan'],
      votes: {},
      random,
    })).toThrow('WOLF_TARGET_REQUIRED')
    expect(pools).toEqual([])
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

  it('selects one positive revote target when another wolf is missing', () => {
    const { random } = recordingRandom()
    const result = resolveWolfRevote({
      actorIds: ['wolf-a', 'wolf-b'],
      initialTiedTargetIds: ['chau', 'minh'],
      votes: { 'wolf-a': 'chau' },
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

  it('rejects a revote with zero valid ballots', () => {
    const { random, pools } = recordingRandom(1)
    expect(() => resolveWolfRevote({
      actorIds: ['wolf-a', 'wolf-b'],
      initialTiedTargetIds: ['chau', 'minh'],
      votes: {},
      random,
    })).toThrow('WOLF_TARGET_REQUIRED')
    expect(pools).toEqual([])
  })
})
