import type { Player, PlayerId, RoleAssignment } from '../game/types'
import type { FactionTransitionState } from './faction-transitions'
import type { CupidLoverState } from './lovers'

export type MatchOutcome =
  | 'FOOL'
  | 'WOLF'
  | 'COUPLE'
  | 'SERIAL_KILLER'
  | 'VILLAGE'
  | 'DRAW'

export type MatchFinishTrigger =
  | 'FOOL_DAY_HANGING'
  | 'NIGHT_STABILIZED'
  | 'DAY_STABILIZED'
  | 'START_NIGHT'

export interface MatchResult {
  outcome: MatchOutcome
  finishedAt: number
  finishedPhase: 'NIGHT' | 'DAY'
  dayNumber: number
  trigger: MatchFinishTrigger
  subjectPlayerIds: PlayerId[]
}

export interface GlobalWinContext {
  players: readonly Player[]
  assignments: readonly RoleAssignment[]
  factionTransitions?: FactionTransitionState | null
  cupidLovers?: CupidLoverState | null
}

export type GlobalWinResolution =
  | { outcome: MatchOutcome; subjectPlayerIds: PlayerId[] }
  | { outcome: null; subjectPlayerIds: [] }

export function isLivingPendingHalfWolf(
  context: GlobalWinContext,
  playerId: PlayerId,
): boolean {
  return (
    context.players.some((player) => player.id === playerId && player.alive) &&
    context.factionTransitions?.halfWolves[playerId]?.status ===
      'PENDING_TRANSFORMATION'
  )
}

/** Resolve only already-stabilized authoritative truth. Checkpoint timing is
 * deliberately owned by the room engine/server wrappers, never the client. */
export function resolveGlobalWin(
  context: GlobalWinContext,
): GlobalWinResolution {
  const livingPlayers = context.players.filter((player) => player.alive)
  const livingIds = new Set(livingPlayers.map((player) => player.id))
  const assignments = new Map(
    context.assignments.map((assignment) => [assignment.playerId, assignment]),
  )

  const biteCapableWolfIds = livingPlayers
    .filter((player) => {
      const roleId = assignments.get(player.id)?.roleId
      return (
        roleId === 'werewolf' ||
        (roleId === 'half-wolf' &&
          context.factionTransitions?.halfWolves[player.id]?.status ===
            'TRANSFORMED')
      )
    })
    .map((player) => player.id)
  const serialKillerIds = livingPlayers
    .filter((player) => assignments.get(player.id)?.roleId === 'serial-killer')
    .map((player) => player.id)
  const runtimeVillageIds = livingPlayers
    .filter((player) => {
      const roleId = assignments.get(player.id)?.roleId
      if (!roleId || roleId === 'serial-killer' || roleId === 'werewolf') {
        return false
      }
      if (roleId === 'half-wolf') {
        return (
          context.factionTransitions?.halfWolves[player.id]?.status !==
          'TRANSFORMED'
        )
      }
      if (roleId === 'traitor') {
        return (
          context.factionTransitions?.traitors[player.id]?.status ===
          'CONVERTED_VILLAGE'
        )
      }
      return true
    })
    .map((player) => player.id)

  // Locked precedence: Wolf is evaluated before an otherwise valid Couple.
  if (
    biteCapableWolfIds.length > 0 &&
    biteCapableWolfIds.length >= runtimeVillageIds.length &&
    serialKillerIds.length === 0
  ) {
    return { outcome: 'WOLF', subjectPlayerIds: [] }
  }

  const couple = context.cupidLovers?.couple
  const objective = context.cupidLovers?.objective
  if (couple && objective?.status === 'ACTIVE' && livingPlayers.length === 3) {
    const requiredIds = new Set([
      couple.cupidPlayerId,
      ...couple.loverPlayerIds,
    ])
    if (
      requiredIds.size === 3 &&
      [...requiredIds].every((playerId) => livingIds.has(playerId))
    ) {
      return {
        outcome: 'COUPLE',
        subjectPlayerIds: [couple.cupidPlayerId, ...couple.loverPlayerIds],
      }
    }
  }

  if (livingPlayers.length === 1 && serialKillerIds.length === 1) {
    return {
      outcome: 'SERIAL_KILLER',
      subjectPlayerIds: [serialKillerIds[0]],
    }
  }
  if (livingPlayers.length === 0) {
    return { outcome: 'DRAW', subjectPlayerIds: [] }
  }

  const hasPendingHalfWolf = context.assignments.some(
    (assignment) =>
      assignment.roleId === 'half-wolf' &&
      isLivingPendingHalfWolf(context, assignment.playerId),
  )
  if (
    biteCapableWolfIds.length === 0 &&
    serialKillerIds.length === 0 &&
    !hasPendingHalfWolf
  ) {
    return { outcome: 'VILLAGE', subjectPlayerIds: [] }
  }
  return { outcome: null, subjectPlayerIds: [] }
}

export function resolveFoolHanging(
  context: GlobalWinContext,
  hangedPlayerId: PlayerId,
): GlobalWinResolution {
  return context.assignments.some(
    (assignment) =>
      assignment.playerId === hangedPlayerId && assignment.roleId === 'fool',
  )
    ? { outcome: 'FOOL', subjectPlayerIds: [hangedPlayerId] }
    : { outcome: null, subjectPlayerIds: [] }
}
