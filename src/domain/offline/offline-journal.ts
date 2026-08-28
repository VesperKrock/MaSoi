import {
  projectLocalModeratorJournal,
  type ModeratorJournalFact,
  type ModeratorJournalSnapshot,
} from '../gameplay/moderator-journal'
import { classicRoleById } from '../roles/classic-catalog'
import { getOfflinePlayers, type OfflineSessionState } from './offline-session'

/**
 * Offline adds only physical identity discovery facts. Every gameplay line is
 * projected from the same typed RoomState journal used by Online.
 */
export function projectOfflineModeratorJournal(
  state: OfflineSessionState,
): ModeratorJournalSnapshot {
  const players = getOfflinePlayers(state)
  const playerNameById = new Map(
    players.map((player) => [player.id, player.alias]),
  )
  const identityBase = state.authority
    ? state.authority.createdAt - state.offlineEvents.length - 1
    : undefined
  const discoveryFacts = state.offlineEvents.map(
    (event, index): ModeratorJournalFact => ({
      id: event.id,
      phase: 'NIGHT',
      cycleNumber: 1,
      kind: 'ROLE_IDENTITIES_DISCOVERED',
      occurredAt: identityBase === undefined
        ? event.occurredAt
        : identityBase + index,
      roleName: classicRoleById[event.roleId].displayName,
      relatedNames: event.holderPlayerIds
        .map((playerId) => playerNameById.get(playerId))
        .filter((name): name is string => Boolean(name)),
    }),
  )
  const authorityFacts = state.authority
    ? projectLocalModeratorJournal(state.authority).facts
    : []
  const uniqueFacts = new Map<string, ModeratorJournalFact>()
  for (const fact of [...discoveryFacts, ...authorityFacts]) {
    if (!uniqueFacts.has(fact.id)) uniqueFacts.set(fact.id, fact)
  }
  return { facts: [...uniqueFacts.values()] }
}
