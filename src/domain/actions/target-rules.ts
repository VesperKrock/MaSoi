import { roleDefinitions } from '../roles/role-definitions'
import { classicRoleById } from '../roles/classic-catalog'
import type { PlayerId, RoleId, RoomState } from '../game/types'

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
