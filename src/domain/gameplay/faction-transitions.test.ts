import { describe, expect, it } from 'vitest'
import type { Player, RoleAssignment } from '../game/types'
import {
  createInitialFactionTransitionState,
  reconcileFactionTransitions,
  scheduleHalfWolfTransformation,
} from './faction-transitions'

const assignments: RoleAssignment[] = [
  { playerId: 'wolf', roleId: 'werewolf' },
  { playerId: 'half', roleId: 'half-wolf' },
  { playerId: 'traitor', roleId: 'traitor' },
  { playerId: 'villager', roleId: 'villager' },
]

function players(aliveIds: readonly string[]): Player[] {
  return assignments.map((assignment, index) => ({
    id: assignment.playerId,
    seat: index + 1,
    alias: assignment.playerId,
    alive: aliveIds.includes(assignment.playerId),
  }))
}

describe('MS-1E authoritative faction transition primitive', () => {
  it('schedules a successful Half-Wolf bite for the following Night exactly once', () => {
    const initial = createInitialFactionTransitionState(assignments)
    const first = scheduleHalfWolfTransformation({
      state: initial,
      assignments,
      playerId: 'half',
      bittenNightNumber: 1,
      now: 100,
    })
    expect(first.scheduled).toBe(true)
    expect(first.state.halfWolves.half).toEqual({
      playerId: 'half',
      status: 'PENDING_TRANSFORMATION',
      bittenNightNumber: 1,
      transformDueNightNumber: 2,
      bittenAt: 100,
    })
    expect(
      scheduleHalfWolfTransformation({
        state: first.state,
        assignments,
        playerId: 'half',
        bittenNightNumber: 1,
        now: 101,
      }).scheduled,
    ).toBe(false)
  })

  it('keeps a living pending Half-Wolf Village through Day then transforms at Night 2', () => {
    const pending = scheduleHalfWolfTransformation({
      state: createInitialFactionTransitionState(assignments),
      assignments,
      playerId: 'half',
      bittenNightNumber: 1,
      now: 100,
    }).state
    const daytime = reconcileFactionTransitions({
      state: pending,
      assignments,
      players: players(['wolf', 'half', 'traitor', 'villager']),
      nightNumber: 1,
      stage: 'AFTER_DEATH',
      now: 200,
    })
    expect(daytime.state.halfWolves.half.status).toBe(
      'PENDING_TRANSFORMATION',
    )

    const nightTwo = reconcileFactionTransitions({
      state: daytime.state,
      assignments,
      players: players(['wolf', 'half', 'traitor', 'villager']),
      nightNumber: 2,
      stage: 'START_NIGHT',
      now: 300,
    })
    expect(nightTwo.state.halfWolves.half.status).toBe('TRANSFORMED')
    expect(nightTwo.events).toContainEqual({
      type: 'HALF_WOLF_TRANSFORMED',
      playerId: 'half',
      nightNumber: 2,
    })
  })

  it('cancels a pending Half-Wolf that dies before transformation', () => {
    const pending = scheduleHalfWolfTransformation({
      state: createInitialFactionTransitionState(assignments),
      assignments,
      playerId: 'half',
      bittenNightNumber: 1,
      now: 100,
    }).state
    const result = reconcileFactionTransitions({
      state: pending,
      assignments,
      players: players(['wolf', 'traitor', 'villager']),
      nightNumber: 1,
      stage: 'AFTER_DEATH',
      now: 200,
    })
    expect(result.state.halfWolves.half).toMatchObject({
      status: 'CANCELED',
      cancellationReason: 'DIED_BEFORE_TRANSFORMATION',
    })
  })

  it('converts a surviving Traitor only when the last bite-capable Wolf dies', () => {
    const initial = createInitialFactionTransitionState(assignments)
    const withWolf = reconcileFactionTransitions({
      state: initial,
      assignments,
      players: players(['wolf', 'half', 'traitor', 'villager']),
      nightNumber: 1,
      stage: 'AFTER_DEATH',
      now: 100,
    })
    expect(withWolf.state.traitors.traitor.status).toBe('WOLF_ALIGNED')

    const withoutWolf = reconcileFactionTransitions({
      state: withWolf.state,
      assignments,
      players: players(['half', 'traitor', 'villager']),
      nightNumber: 1,
      stage: 'AFTER_DEATH',
      now: 200,
    })
    expect(withoutWolf.state.traitors.traitor).toMatchObject({
      status: 'CONVERTED_VILLAGE',
      conversionReason: 'NO_LIVING_BITE_CAPABLE_WOLF',
    })
  })

  it('lets a transformed Half-Wolf keep the Traitor aligned', () => {
    let state = scheduleHalfWolfTransformation({
      state: createInitialFactionTransitionState(assignments),
      assignments,
      playerId: 'half',
      bittenNightNumber: 1,
      now: 100,
    }).state
    state = reconcileFactionTransitions({
      state,
      assignments,
      players: players(['wolf', 'half', 'traitor']),
      nightNumber: 2,
      stage: 'START_NIGHT',
      now: 200,
    }).state
    const result = reconcileFactionTransitions({
      state,
      assignments,
      players: players(['half', 'traitor']),
      nightNumber: 2,
      stage: 'AFTER_DEATH',
      now: 300,
    })
    expect(result.state.traitors.traitor.status).toBe('WOLF_ALIGNED')
  })

  it('permanently converts Traitor before a pending Half-Wolf transforms', () => {
    const pending = scheduleHalfWolfTransformation({
      state: createInitialFactionTransitionState(assignments),
      assignments,
      playerId: 'half',
      bittenNightNumber: 1,
      now: 100,
    }).state
    const afterWolfDeath = reconcileFactionTransitions({
      state: pending,
      assignments,
      players: players(['half', 'traitor', 'villager']),
      nightNumber: 1,
      stage: 'AFTER_DEATH',
      now: 200,
    })
    const nightTwo = reconcileFactionTransitions({
      state: afterWolfDeath.state,
      assignments,
      players: players(['half', 'traitor', 'villager']),
      nightNumber: 2,
      stage: 'START_NIGHT',
      now: 300,
    })
    expect(nightTwo.state.halfWolves.half.status).toBe('TRANSFORMED')
    expect(nightTwo.state.traitors.traitor.status).toBe('CONVERTED_VILLAGE')

    const retry = reconcileFactionTransitions({
      state: nightTwo.state,
      assignments,
      players: players(['half', 'traitor', 'villager']),
      nightNumber: 2,
      stage: 'START_NIGHT',
      now: 301,
    })
    expect(retry.events).toEqual([])
    expect(retry.state).toEqual(nightTwo.state)
  })
})
