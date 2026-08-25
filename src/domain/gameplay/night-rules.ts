import type { PlayerId, RoleId } from '../game/types'

export interface NightRoleHolder {
  playerId: PlayerId
  roleId: RoleId
  alive: boolean
  halfWolfTransformed?: boolean
}

export type SeerDetection = 'WOLF' | 'NON_WOLF'

export function getWolfGroupVoterIds(
  holders: readonly NightRoleHolder[],
): PlayerId[] {
  const hasLivingBiteCapableWolf = holders.some(
    (holder) =>
      holder.alive &&
      (holder.roleId === 'werewolf' ||
        (holder.roleId === 'half-wolf' && holder.halfWolfTransformed === true)),
  )

  if (!hasLivingBiteCapableWolf) return []

  return holders
    .filter(
      (holder) =>
        holder.alive &&
        (holder.roleId === 'werewolf' ||
          holder.roleId === 'traitor' ||
          (holder.roleId === 'half-wolf' && holder.halfWolfTransformed === true)),
    )
    .map((holder) => holder.playerId)
}

export function detectForSeer(
  roleId: RoleId,
  options: { halfWolfTransformed?: boolean } = {},
): SeerDetection {
  return roleId === 'werewolf' ||
    (roleId === 'half-wolf' && options.halfWolfTransformed === true)
    ? 'WOLF'
    : 'NON_WOLF'
}

export function canProtectorTarget(input: {
  nightNumber: number
  targetId: PlayerId
  targetAlive: boolean
  previousNightTargetId?: PlayerId | null
}): boolean {
  if (!input.targetAlive) return false
  if (input.nightNumber <= 1) return true
  return input.previousNightTargetId !== input.targetId
}
