import type {
  Player,
  PlayerId,
  RoleAssignment,
} from '../game/types'

export type HalfWolfRuntimeStatus =
  | 'VILLAGE'
  | 'PENDING_TRANSFORMATION'
  | 'TRANSFORMED'
  | 'CANCELED'

export interface HalfWolfRuntimeState {
  playerId: PlayerId
  status: HalfWolfRuntimeStatus
  bittenNightNumber?: number
  transformDueNightNumber?: number
  bittenAt?: number
  transformedAt?: number
  canceledAt?: number
  cancellationReason?: 'DIED_BEFORE_TRANSFORMATION'
}

export type TraitorRuntimeStatus = 'WOLF_ALIGNED' | 'CONVERTED_VILLAGE'

export interface TraitorRuntimeState {
  playerId: PlayerId
  status: TraitorRuntimeStatus
  convertedAt?: number
  conversionReason?: 'NO_LIVING_BITE_CAPABLE_WOLF'
}

export interface FactionTransitionState {
  halfWolves: Record<PlayerId, HalfWolfRuntimeState>
  traitors: Record<PlayerId, TraitorRuntimeState>
}

export type FactionTransitionEvent =
  | {
      type: 'HALF_WOLF_TRANSFORMATION_CANCELED'
      playerId: PlayerId
      reason: 'DIED_BEFORE_TRANSFORMATION'
    }
  | {
      type: 'HALF_WOLF_TRANSFORMED'
      playerId: PlayerId
      nightNumber: number
    }
  | {
      type: 'TRAITOR_CONVERTED_TO_VILLAGE'
      playerId: PlayerId
      reason: 'NO_LIVING_BITE_CAPABLE_WOLF'
    }

export type FactionReconciliationStage = 'AFTER_DEATH' | 'START_NIGHT'

export function createInitialFactionTransitionState(
  assignments: readonly RoleAssignment[],
): FactionTransitionState {
  return {
    halfWolves: Object.fromEntries(
      assignments
        .filter((assignment) => assignment.roleId === 'half-wolf')
        .map((assignment) => [
          assignment.playerId,
          { playerId: assignment.playerId, status: 'VILLAGE' as const },
        ]),
    ),
    traitors: Object.fromEntries(
      assignments
        .filter((assignment) => assignment.roleId === 'traitor')
        .map((assignment) => [
          assignment.playerId,
          { playerId: assignment.playerId, status: 'WOLF_ALIGNED' as const },
        ]),
    ),
  }
}

export function normalizeFactionTransitionState(
  assignments: readonly RoleAssignment[],
  current?: FactionTransitionState | null,
): FactionTransitionState {
  const initial = createInitialFactionTransitionState(assignments)
  return {
    halfWolves: { ...initial.halfWolves, ...(current?.halfWolves ?? {}) },
    traitors: { ...initial.traitors, ...(current?.traitors ?? {}) },
  }
}

export function isHalfWolfTransformed(
  state: FactionTransitionState | null | undefined,
  playerId: PlayerId,
): boolean {
  return state?.halfWolves[playerId]?.status === 'TRANSFORMED'
}

export function isTraitorConverted(
  state: FactionTransitionState | null | undefined,
  playerId: PlayerId,
): boolean {
  return state?.traitors[playerId]?.status === 'CONVERTED_VILLAGE'
}

export function scheduleHalfWolfTransformation(input: {
  state: FactionTransitionState | null | undefined
  assignments: readonly RoleAssignment[]
  playerId: PlayerId
  bittenNightNumber: number
  now: number
}): { state: FactionTransitionState; scheduled: boolean } {
  const state = normalizeFactionTransitionState(input.assignments, input.state)
  const assignment = input.assignments.find(
    (entry) => entry.playerId === input.playerId,
  )
  if (assignment?.roleId !== 'half-wolf') {
    throw new Error('HALF_WOLF_TARGET_REQUIRED')
  }
  const existing = state.halfWolves[input.playerId]
  if (existing.status !== 'VILLAGE') return { state, scheduled: false }

  state.halfWolves[input.playerId] = {
    playerId: input.playerId,
    status: 'PENDING_TRANSFORMATION',
    bittenNightNumber: input.bittenNightNumber,
    transformDueNightNumber: input.bittenNightNumber + 1,
    bittenAt: input.now,
  }
  return { state, scheduled: true }
}

function livingPlayerIds(players: readonly Player[]): Set<PlayerId> {
  return new Set(
    players.filter((player) => player.alive).map((player) => player.id),
  )
}

function hasLivingBiteCapableWolf(input: {
  assignments: readonly RoleAssignment[]
  livingIds: ReadonlySet<PlayerId>
  state: FactionTransitionState
}): boolean {
  return input.assignments.some(
    (assignment) =>
      input.livingIds.has(assignment.playerId) &&
      (assignment.roleId === 'werewolf' ||
        (assignment.roleId === 'half-wolf' &&
          isHalfWolfTransformed(input.state, assignment.playerId))),
  )
}

/**
 * Reconciles secret runtime faction state from authoritative assignments and
 * alive truth. START_NIGHT intentionally converts stranded Traitors before it
 * activates due Half-Wolves: a converted Traitor can never oscillate back.
 */
export function reconcileFactionTransitions(input: {
  state: FactionTransitionState | null | undefined
  assignments: readonly RoleAssignment[]
  players: readonly Player[]
  nightNumber: number
  stage: FactionReconciliationStage
  now: number
}): { state: FactionTransitionState; events: FactionTransitionEvent[] } {
  const state = normalizeFactionTransitionState(input.assignments, input.state)
  const events: FactionTransitionEvent[] = []
  const livingIds = livingPlayerIds(input.players)

  for (const halfWolf of Object.values(state.halfWolves)) {
    if (
      halfWolf.status === 'PENDING_TRANSFORMATION' &&
      !livingIds.has(halfWolf.playerId)
    ) {
      state.halfWolves[halfWolf.playerId] = {
        ...halfWolf,
        status: 'CANCELED',
        canceledAt: input.now,
        cancellationReason: 'DIED_BEFORE_TRANSFORMATION',
      }
      events.push({
        type: 'HALF_WOLF_TRANSFORMATION_CANCELED',
        playerId: halfWolf.playerId,
        reason: 'DIED_BEFORE_TRANSFORMATION',
      })
    }
  }

  if (
    !hasLivingBiteCapableWolf({
      assignments: input.assignments,
      livingIds,
      state,
    })
  ) {
    for (const traitor of Object.values(state.traitors)) {
      if (
        traitor.status === 'WOLF_ALIGNED' &&
        livingIds.has(traitor.playerId)
      ) {
        state.traitors[traitor.playerId] = {
          ...traitor,
          status: 'CONVERTED_VILLAGE',
          convertedAt: input.now,
          conversionReason: 'NO_LIVING_BITE_CAPABLE_WOLF',
        }
        events.push({
          type: 'TRAITOR_CONVERTED_TO_VILLAGE',
          playerId: traitor.playerId,
          reason: 'NO_LIVING_BITE_CAPABLE_WOLF',
        })
      }
    }
  }

  if (input.stage === 'START_NIGHT') {
    for (const halfWolf of Object.values(state.halfWolves)) {
      if (
        halfWolf.status === 'PENDING_TRANSFORMATION' &&
        livingIds.has(halfWolf.playerId) &&
        (halfWolf.transformDueNightNumber ?? Number.POSITIVE_INFINITY) <=
          input.nightNumber
      ) {
        state.halfWolves[halfWolf.playerId] = {
          ...halfWolf,
          status: 'TRANSFORMED',
          transformedAt: input.now,
        }
        events.push({
          type: 'HALF_WOLF_TRANSFORMED',
          playerId: halfWolf.playerId,
          nightNumber: input.nightNumber,
        })
      }
    }
  }

  return { state, events }
}
