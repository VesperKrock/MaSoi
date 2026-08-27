import type { FinalTargetResult, PlayerId, WolfPolicy } from '../game/types'
import type { RandomSource } from './random'

export interface VoteAnalysis {
  counts: Record<PlayerId, number>
  leaders: PlayerId[]
  topCount: number
  positiveVoteCount: number
}

export type InitialWolfResolution =
  | { status: 'RESOLVED'; result: FinalTargetResult }
  | { status: 'REVOTE_REQUIRED'; tiedTargetIds: PlayerId[] }

export function analyzeWolfVotes(
  votes: Readonly<Record<PlayerId, PlayerId | null>>,
  actorIds: readonly PlayerId[],
  allowedTargetIds: readonly PlayerId[],
): VoteAnalysis {
  const allowedTargets = new Set(allowedTargetIds)
  const counts: Record<PlayerId, number> = {}

  for (const actorId of actorIds) {
    const targetId = votes[actorId]
    if (targetId && allowedTargets.has(targetId)) {
      counts[targetId] = (counts[targetId] ?? 0) + 1
    }
  }

  const topCount = Math.max(0, ...Object.values(counts))
  const leaders = Object.entries(counts)
    .filter(([, count]) => count === topCount && count > 0)
    .map(([targetId]) => targetId)

  return {
    counts,
    leaders,
    topCount,
    positiveVoteCount: Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    ),
  }
}

export function resolveInitialWolfVote(input: {
  policy: WolfPolicy
  votes: Readonly<Record<PlayerId, PlayerId | null>>
  actorIds: readonly PlayerId[]
  eligibleTargetIds: readonly PlayerId[]
  random: RandomSource
}): InitialWolfResolution {
  const analysis = analyzeWolfVotes(
    input.votes,
    input.actorIds,
    input.eligibleTargetIds,
  )

  if (analysis.leaders.length === 1) {
    return {
      status: 'RESOLVED',
      result: {
        targetId: analysis.leaders[0],
        random: false,
        reason: 'UNIQUE_TOP',
      },
    }
  }

  if (analysis.leaders.length === 0) {
    if (input.eligibleTargetIds.length === 0) {
      return {
        status: 'RESOLVED',
        result: {
          targetId: null,
          random: false,
          reason: 'NO_ELIGIBLE_TARGET',
        },
      }
    }
    throw new Error('WOLF_TARGET_REQUIRED')
  }

  if (input.policy === 'REVOTE_10S') {
    return {
      status: 'REVOTE_REQUIRED',
      tiedTargetIds: analysis.leaders,
    }
  }

  return {
    status: 'RESOLVED',
    result: {
      targetId: input.random.pick(analysis.leaders),
      random: true,
      reason: 'TIED_TOP_RANDOM',
    },
  }
}

export function resolveWolfRevote(input: {
  votes: Readonly<Record<PlayerId, PlayerId | null>>
  actorIds: readonly PlayerId[]
  initialTiedTargetIds: readonly PlayerId[]
  random: RandomSource
}): FinalTargetResult {
  const analysis = analyzeWolfVotes(
    input.votes,
    input.actorIds,
    input.initialTiedTargetIds,
  )

  if (analysis.leaders.length === 1) {
    return {
      targetId: analysis.leaders[0],
      random: false,
      reason: 'REVOTE_UNIQUE_TOP',
    }
  }

  if (analysis.leaders.length === 0) {
    if (input.initialTiedTargetIds.length === 0) {
      return {
        targetId: null,
        random: false,
        reason: 'NO_ELIGIBLE_TARGET',
      }
    }
    throw new Error('WOLF_TARGET_REQUIRED')
  }

  return {
    targetId: input.random.pick(analysis.leaders),
    random: true,
    reason: 'REVOTE_TIED_RANDOM',
  }
}
