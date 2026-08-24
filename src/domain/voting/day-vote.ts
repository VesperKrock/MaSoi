import type { DayVoteResult, PlayerId } from '../game/types'

export function resolveDayVote(
  votes: Readonly<Record<PlayerId, PlayerId | null>>,
  livingVoterIds: readonly PlayerId[],
  livingTargetIds: readonly PlayerId[],
): DayVoteResult {
  const targets = new Set(livingTargetIds)
  const counts: Record<PlayerId, number> = {}

  for (const voterId of livingVoterIds) {
    const targetId = votes[voterId]
    if (targetId && targets.has(targetId)) {
      counts[targetId] = (counts[targetId] ?? 0) + 1
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
