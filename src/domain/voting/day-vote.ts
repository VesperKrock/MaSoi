import type { DayEffect, DayVoteResult, PlayerId, RoleId } from '../game/types'

export const dayVoteDurationMs = 30_000

export function getDayVoteWeight(roleId: RoleId | undefined): 1 | 2 {
  return roleId === 'mayor' ? 2 : 1
}

export function resolveDayVote(
  votes: Readonly<Record<PlayerId, PlayerId | null>>,
  livingVoterIds: readonly PlayerId[],
  livingTargetIds: readonly PlayerId[],
  weights: Readonly<Record<PlayerId, number>> = {},
): DayVoteResult {
  const targets = new Set(livingTargetIds)
  const counts: Record<PlayerId, number> = {}

  for (const voterId of livingVoterIds) {
    const targetId = votes[voterId]
    if (targetId && targets.has(targetId)) {
      const weight = weights[voterId] ?? 1
      counts[targetId] = (counts[targetId] ?? 0) + weight
    }
  }

  const topCount = Math.max(0, ...Object.values(counts))
  const targetIds = Object.entries(counts)
    .filter(([, count]) => count === topCount && count > 0)
    .map(([targetId]) => targetId)

  if (targetIds.length === 0) {
    return { kind: 'NO_VOTES', targetIds: [], counts }
  }

  return {
    kind: targetIds.length === 1 ? 'UNIQUE' : 'TIE',
    targetIds,
    counts,
  }
}

export function createDayHangingEffect(
  id: string,
  targetPlayerId: PlayerId,
): DayEffect {
  return {
    id,
    sourceType: 'DAY_HANGING',
    category: 'DAY_LETHAL_EFFECT',
    targetPlayerId,
    lethal: true,
    protectorBlockable: false,
    finalized: true,
  }
}

export function createHunterRevengeEffect(
  id: string,
  hunterPlayerId: PlayerId,
  targetPlayerId: PlayerId,
): DayEffect {
  return {
    id,
    sourceType: 'HUNTER_REVENGE_SHOT',
    sourceRoleId: 'hunter',
    actorPlayerId: hunterPlayerId,
    category: 'NON_VILLAIN_LETHAL_EFFECT',
    targetPlayerId,
    lethal: true,
    protectorBlockable: false,
    finalized: true,
  }
}
