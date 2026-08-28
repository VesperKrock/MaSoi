import {
  projectLocalModeratorJournal,
  type ModeratorJournalFact,
  type ModeratorJournalSnapshot,
} from '../gameplay/moderator-journal'
import { classicRoleById } from '../roles/classic-catalog'
import { getOfflinePlayers, type OfflineSessionState } from './offline-session'

/**
 * Offline adds physical discovery and Moderator-only Day decision facts.
 * Gameplay consequences still come from the shared typed RoomState journal.
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
  const offlineFacts = state.offlineEvents.map(
    (event, index): ModeratorJournalFact => {
      if (event.type === 'ROLE_IDENTITY_DISCOVERED') {
        return {
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
        }
      }
      return {
        id: event.id,
        phase: 'DAY',
        cycleNumber: event.dayNumber,
        kind: event.type,
        occurredAt: event.occurredAt,
        targetName: event.type === 'DAY_NO_CANDIDATE'
          ? undefined
          : playerNameById.get(event.candidatePlayerId),
      }
    },
  )
  const authorityFacts = state.authority
    ? projectLocalModeratorJournal(state.authority).facts
    : []
  const uniqueFacts = new Map<string, ModeratorJournalFact>()
  for (const fact of [...offlineFacts, ...authorityFacts]) {
    if (!uniqueFacts.has(fact.id)) uniqueFacts.set(fact.id, fact)
  }
  return { facts: [...uniqueFacts.values()] }
}
