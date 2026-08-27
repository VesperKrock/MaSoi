import {
  getEligibleDayTargets,
  getEligibleRoleTargets,
  getRoleIdForPlayer,
} from '../domain/actions/target-rules'
import { getDayVoteWeight, resolveDayVote } from '../domain/voting/day-vote'
import type {
  NightAction,
  Player,
  PlayerId,
  RoleId,
  RoomState,
} from '../domain/game/types'
import { roleDefinitions } from '../domain/roles/role-definitions'
import { getLoverPartnerId } from '../domain/gameplay/lovers'
import {
  cardAssetUrl,
  classicRoleById,
} from '../domain/roles/classic-catalog'
import {
  projectEndMatch,
  type EndMatchSnapshot,
} from '../domain/gameplay/end-match'

export type RoomAudience =
  | { kind: 'MODERATOR' }
  | { kind: 'PLAYER'; playerId: PlayerId }

export interface ModeratorRoomSnapshot {
  audience: 'MODERATOR'
  state: RoomState
  endMatch?: EndMatchSnapshot
}

export interface PlayerActionSnapshot {
  id: string
  kind: NightAction['kind']
  roleId: RoleId
  roleName: string
  instructions: string
  round?: 'INITIAL' | 'REVOTE'
  deadlineAt?: number
  candidates: Player[]
  currentTargetId?: PlayerId | null
  hasSelected: boolean
  mode?:
    | 'WOLF_BALLOT'
    | 'WOLF_REVOTE'
    | 'SEER_SELECT'
    | 'SEER_RESULT'
    | 'PROTECTOR_SELECT'
    | 'HUNTER_PRELOCK'
    | 'SERIAL_KILLER_ATTACK'
    | 'WITCH_DECISION'
    | 'CUPID_PAIRING'
  resurrectionCandidates?: Player[]
  poisonCandidates?: Player[]
  resurrectionAvailable?: boolean
  poisonAvailable?: boolean
  witchAttackedThisNight?: boolean
  inspectedTarget?: Player
  seerResult?: 'WOLF' | 'NON_WOLF'
  selectedTargetIds?: PlayerId[]
}

export interface PlayerRoomSnapshot {
  audience: 'PLAYER'
  revision: number
  roomId: string
  roomCode: string
  lifecycle: RoomState['lifecycle']
  seatCount: number
  phase: RoomState['phase']
  dayNumber: number
  matchResult?: {
    outcome: NonNullable<RoomState['matchResult']>['outcome']
  }
  endMatch?: EndMatchSnapshot
  self: Player
  players: Player[]
  roleIdentity?: {
    roleId: RoleId
    displayName: string
    factionMeaning: string
    rulesText: string
    cardAsset: string
  }
  roleRevealPending: boolean
  loverRelationship?: {
    partner: Player
    revealPending: boolean
  }
  cupidPair?: {
    lovers: [Player, Player]
  }
  nightAction?: PlayerActionSnapshot
  dayVote?: {
    status: 'OPEN' | 'CLOSED'
    candidates: Player[]
    currentTargetId?: PlayerId | null
    openedAt: number
    deadlineAt: number
    totals: Record<PlayerId, number>
    result?: {
      kind: 'UNIQUE' | 'TIE' | 'NO_VOTES'
      hangedPlayer?: Player
      hunterRevealed: boolean
      hunterRevengeStatus?: 'PENDING' | 'RESOLVED'
      hunterRevengeTarget?: Player | null
    }
    hunterRevengeAction?: {
      candidates: Player[]
    }
  }
}

export type RoomSnapshot = ModeratorRoomSnapshot | PlayerRoomSnapshot

function playerById(state: RoomState, playerId: PlayerId): Player {
  const player = state.players.find((entry) => entry.id === playerId)
  if (!player) {
    throw new Error('Ghế người chơi không tồn tại trong phòng hiện tại.')
  }
  return player
}

function projectNightAction(
  state: RoomState,
  player: Player,
): PlayerActionSnapshot | undefined {
  if (state.phase !== 'NIGHT' || !state.night?.activeRoleId || !player.alive) {
    return undefined
  }
  const action = state.night.actionsByRole[state.night.activeRoleId]
  if (
    !action ||
    action.status !== 'OPEN' ||
    !action.eligibleActorIds.includes(player.id) ||
    action.confirmedActorIds.includes(player.id)
  ) {
    return undefined
  }

  const targetIds =
    action.kind === 'WITCH_DECISION'
      ? action.eligibleTargetIds
      : action.kind === 'HUNTER_PRELOCK'
        ? action.eligibleTargetIds
        : action.kind === 'SERIAL_KILLER_ATTACK'
          ? action.eligibleTargetIds
        : action.kind === 'SELECT_TARGET'
          ? getEligibleRoleTargets(state, action.roleId, player.id)
          : action.eligibleTargetIds
  const hasSelected = Object.prototype.hasOwnProperty.call(
    action.selections,
    player.id,
  )

  const definition = roleDefinitions[action.roleId]
  if (!definition) return undefined

  return {
    id: action.id,
    kind: action.kind,
    roleId: action.roleId,
    roleName: definition.displayName,
    instructions: definition.instructions,
    round: action.wolf?.round,
    deadlineAt: action.wolf?.deadlineAt,
    candidates: targetIds.map((targetId) => playerById(state, targetId)),
    currentTargetId: hasSelected ? action.selections[player.id] : undefined,
    hasSelected,
    mode:
      action.kind === 'WOLF_VOTE'
        ? action.wolf?.round === 'REVOTE'
          ? 'WOLF_REVOTE'
          : 'WOLF_BALLOT'
        : action.roleId === 'seer'
          ? action.seer
            ? 'SEER_RESULT'
            : 'SEER_SELECT'
          : action.roleId === 'protector'
            ? 'PROTECTOR_SELECT'
            : action.roleId === 'hunter'
              ? 'HUNTER_PRELOCK'
              : action.roleId === 'serial-killer'
                ? 'SERIAL_KILLER_ATTACK'
              : action.roleId === 'witch'
                ? 'WITCH_DECISION'
                : action.roleId === 'cupid'
                  ? 'CUPID_PAIRING'
                : undefined,
    resurrectionCandidates: action.witch?.resurrectionCandidateIds.map(
      (targetId) => playerById(state, targetId),
    ),
    poisonCandidates: action.witch?.poisonCandidateIds.map((targetId) =>
      playerById(state, targetId),
    ),
    resurrectionAvailable: action.witch?.resurrectionAvailable,
    poisonAvailable: action.witch?.poisonAvailable,
    witchAttackedThisNight: action.witch?.attackedThisNight,
    inspectedTarget: action.seer
      ? playerById(state, action.seer.targetId)
      : undefined,
    seerResult: action.seer?.result,
    selectedTargetIds: action.cupid?.selectedTargetIds,
  }
}

export function projectRoomSnapshot(
  state: RoomState,
  audience: RoomAudience,
): RoomSnapshot {
  if (audience.kind === 'MODERATOR') {
    const endMatch = projectEndMatch(state)
    return {
      audience: 'MODERATOR',
      state: structuredClone(state),
      ...(endMatch ? { endMatch } : {}),
    }
  }

  const self = playerById(state, audience.playerId)
  const hiddenCurrentNightDeathIds =
    state.phase === 'NIGHT' &&
    state.witchCheckpoint?.nightNumber === state.dayNumber
      ? new Set(
          state.witchCheckpoint.finalDeaths.map((death) => death.playerId),
        )
      : new Set<PlayerId>()
  const projectedPlayers = state.players.map((player) =>
    hiddenCurrentNightDeathIds.has(player.id)
      ? { ...player, alive: true }
      : structuredClone(player),
  )
  const projectedSelf = projectedPlayers.find((player) => player.id === self.id)
  if (!projectedSelf) {
    throw new Error('Ghế người chơi không tồn tại trong projection.')
  }
  const roleAssignment = state.roleAssignments.find(
    (assignment) => assignment.playerId === self.id,
  )
  const catalogRole = roleAssignment
    ? classicRoleById[roleAssignment.roleId]
    : undefined
  const roleRevealPending =
    state.lifecycle === 'ROLE_REVEAL' &&
    Boolean(catalogRole) &&
    !state.roleRevealConfirmedPlayerIds.includes(self.id)
  const dayVote = state.phase === 'DAY' ? state.dayVote : null
  const livingIds = state.players
    .filter((player) => player.alive)
    .map((player) => player.id)
  const liveDayResult = dayVote
    ? dayVote.result ??
      resolveDayVote(
        dayVote.votes,
        livingIds,
        livingIds,
        Object.fromEntries(
          livingIds.map((playerId) => [
            playerId,
            getDayVoteWeight(getRoleIdForPlayer(state, playerId)),
          ]),
        ),
      )
    : undefined
  const hangedPlayerId =
    dayVote?.result?.kind === 'UNIQUE'
      ? dayVote.result.targetIds[0]
      : undefined
  const revengeTargetId = dayVote?.hunterRevenge?.targetPlayerId
  const loverPartnerId = getLoverPartnerId(state.cupidLovers, self.id)
  const cupidPair =
    roleAssignment?.roleId === 'cupid' && state.cupidLovers?.couple
      ? state.cupidLovers.couple.loverPlayerIds
      : null
  const endMatch = projectEndMatch(state)

  return {
    audience: 'PLAYER',
    revision: state.revision,
    roomId: state.roomId,
    roomCode: state.roomCode,
    lifecycle: state.lifecycle,
    seatCount: state.config.seatCount,
    phase: state.phase,
    dayNumber: state.dayNumber,
    matchResult: state.matchResult
      ? { outcome: state.matchResult.outcome }
      : undefined,
    endMatch,
    self: projectedSelf,
    players: projectedPlayers,
    roleIdentity:
      catalogRole
        ? {
            roleId: catalogRole.id,
            displayName: catalogRole.displayName,
            factionMeaning: catalogRole.factionMeaning,
            rulesText: catalogRole.rulesText,
            cardAsset: cardAssetUrl(catalogRole.assetFiles[0]),
          }
        : undefined,
    roleRevealPending,
    loverRelationship: loverPartnerId
      ? {
          partner: playerById(state, loverPartnerId),
          revealPending: !(
            state.cupidLovers?.loverRevealAcknowledgedPlayerIds.includes(
              self.id,
            ) ?? false
          ),
        }
      : undefined,
    cupidPair: cupidPair
      ? {
          lovers: [
            playerById(state, cupidPair[0]),
            playerById(state, cupidPair[1]),
          ],
        }
      : undefined,
    nightAction: projectNightAction(state, self),
    dayVote:
      dayVote
        ? {
            status: dayVote.status,
            candidates:
              dayVote.status === 'OPEN' && self.alive
                ? getEligibleDayTargets(state, self.id).map((targetId) =>
                    playerById(state, targetId),
                  )
                : [],
            currentTargetId: dayVote.votes[self.id],
            openedAt: dayVote.openedAt,
            deadlineAt: dayVote.deadlineAt,
            totals: liveDayResult?.counts ?? {},
            result: dayVote.result
              ? {
                  kind: dayVote.result.kind,
                  hangedPlayer: hangedPlayerId
                    ? playerById(state, hangedPlayerId)
                    : undefined,
                  hunterRevealed: Boolean(dayVote.hunterRevenge),
                  hunterRevengeStatus: dayVote.hunterRevenge?.status,
                  hunterRevengeTarget:
                    dayVote.hunterRevenge?.status === 'RESOLVED'
                      ? revengeTargetId
                        ? playerById(state, revengeTargetId)
                        : null
                      : undefined,
                }
              : undefined,
            hunterRevengeAction:
              dayVote.hunterRevenge?.status === 'PENDING' &&
              dayVote.hunterRevenge.hunterPlayerId === self.id
                ? {
                    candidates: state.players
                      .filter((player) => player.alive && player.id !== self.id)
                      .map((player) => structuredClone(player)),
                  }
                : undefined,
          }
        : undefined,
  }
}
