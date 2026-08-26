import { getEligibleDayTargets, getEligibleRoleTargets } from '../domain/actions/target-rules'
import type {
  NightAction,
  Player,
  PlayerId,
  RoleId,
  RoomState,
} from '../domain/game/types'
import { roleDefinitions } from '../domain/roles/role-definitions'
import {
  cardAssetUrl,
  classicRoleById,
} from '../domain/roles/classic-catalog'

export type RoomAudience =
  | { kind: 'MODERATOR' }
  | { kind: 'PLAYER'; playerId: PlayerId }

export interface ModeratorRoomSnapshot {
  audience: 'MODERATOR'
  state: RoomState
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
    | 'WITCH_DECISION'
  resurrectionCandidates?: Player[]
  poisonCandidates?: Player[]
  resurrectionAvailable?: boolean
  poisonAvailable?: boolean
  witchAttackedThisNight?: boolean
  inspectedTarget?: Player
  seerResult?: 'WOLF' | 'NON_WOLF'
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
  nightAction?: PlayerActionSnapshot
  dayVote?: {
    status: 'OPEN' | 'CLOSED'
    candidates: Player[]
    currentTargetId?: PlayerId | null
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
              : action.roleId === 'witch'
                ? 'WITCH_DECISION'
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
  }
}

export function projectRoomSnapshot(
  state: RoomState,
  audience: RoomAudience,
): RoomSnapshot {
  if (audience.kind === 'MODERATOR') {
    return { audience: 'MODERATOR', state: structuredClone(state) }
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

  return {
    audience: 'PLAYER',
    revision: state.revision,
    roomId: state.roomId,
    roomCode: state.roomCode,
    lifecycle: state.lifecycle,
    seatCount: state.config.seatCount,
    phase: state.phase,
    dayNumber: state.dayNumber,
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
    nightAction: projectNightAction(state, self),
    dayVote:
      state.phase === 'DAY' && state.dayVote
        ? {
            status: state.dayVote.status,
            candidates:
              state.dayVote.status === 'OPEN' && self.alive
                ? getEligibleDayTargets(state, self.id).map((targetId) =>
                    playerById(state, targetId),
                  )
                : [],
            currentTargetId: state.dayVote.votes[self.id],
          }
        : undefined,
  }
}
