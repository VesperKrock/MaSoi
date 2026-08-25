import { roleDefinitions } from '../roles/role-definitions'
import { classicRoleById } from '../roles/classic-catalog'
import type { PlayerId, RoleId, RoomState } from '../game/types'
import {
  canProtectorTarget,
  getWolfGroupVoterIds,
} from '../gameplay/night-rules'

export function getRoleIdForPlayer(
  state: RoomState,
  playerId: PlayerId,
): RoleId | undefined {
  return state.roleAssignments.find(
    (assignment) => assignment.playerId === playerId,
  )?.roleId
}

export function getLivingHolders(
  state: RoomState,
  roleId: RoleId,
): PlayerId[] {
  const livingIds = new Set(
    state.players.filter((player) => player.alive).map((player) => player.id),
  )

  return state.roleAssignments
    .filter(
      (assignment) =>
        assignment.roleId === roleId && livingIds.has(assignment.playerId),
    )
    .map((assignment) => assignment.playerId)
}

function roleHolders(state: RoomState) {
  return state.roleAssignments.map((assignment) => ({
    playerId: assignment.playerId,
    roleId: assignment.roleId,
    alive:
      state.players.find((player) => player.id === assignment.playerId)?.alive ??
      false,
  }))
}

export function getEligibleWolfGroupActors(state: RoomState): PlayerId[] {
  return getWolfGroupVoterIds(roleHolders(state))
}

export function getEligibleWolfTargets(state: RoomState): PlayerId[] {
  const actorIds = new Set(getEligibleWolfGroupActors(state))
  return state.players
    .filter((player) => player.alive && !actorIds.has(player.id))
    .map((player) => player.id)
}

function previousProtectorTargetId(state: RoomState): PlayerId | undefined {
  return [...state.journal]
    .reverse()
    .find(
      (event) =>
        event.type === 'PROTECTOR_INTENT' &&
        event.dayNumber === state.dayNumber - 1,
    )?.targetPlayerId
}

export function getEligibleRoleTargets(
  state: RoomState,
  roleId: RoleId,
  actorId?: PlayerId,
): PlayerId[] {
  const definition = roleDefinitions[roleId]
  if (!definition) return []

  return state.players
    .filter((player) => player.alive)
    .filter((player) => {
      if (definition.targetRule === 'LIVING_NON_WOLF') {
        const targetRoleId = getRoleIdForPlayer(state, player.id)
        return targetRoleId
          ? classicRoleById[targetRoleId].marketGroup !== 'WEREWOLF'
          : true
      }

      if (definition.targetRule === 'LIVING_OTHER') {
        return player.id !== actorId
      }

      if (definition.targetRule === 'LIVING_ANY') {
        return canProtectorTarget({
          nightNumber: state.dayNumber,
          targetId: player.id,
          targetAlive: player.alive,
          previousNightTargetId: previousProtectorTargetId(state),
        })
      }

      return false
    })
    .map((player) => player.id)
}

export function getEligibleDayTargets(
  state: RoomState,
  voterId: PlayerId,
): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== voterId)
    .map((player) => player.id)
}
