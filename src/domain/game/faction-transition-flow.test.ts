import { describe, expect, it } from 'vitest'
import { getEligibleWolfTargets } from '../actions/target-rules'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoomCommand, RoomState } from './types'

function environment() {
  let now = 10_000
  let id = 0
  return {
    value: {
      now: () => now,
      nextId: () => `e-${++id}`,
      random: fixedRandom(0),
    } satisfies GameEnvironment,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

function run(state: RoomState, command: RoomCommand, env: GameEnvironment) {
  return applyRoomCommand(state, command, env)
}

function factionRoom(env: GameEnvironment): RoomState {
  const state = createDemoRoom(7, 'RANDOM_ON_TIE', env)
  const roleIds = [
    'werewolf',
    'traitor',
    'half-wolf',
    'seer',
    'protector',
    'villager',
    'villager',
  ] as const
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: roleIds[index],
  }))
  state.config.roleComposition = {
    werewolf: 1,
    traitor: 1,
    'half-wolf': 1,
    seer: 1,
    protector: 1,
    villager: 2,
  }
  state.config.nightRoleIds = ['werewolf', 'seer', 'protector']
  state.factionTransitions = undefined
  return run(state, { type: 'START_NIGHT' }, env)
}

function completeProtector(
  state: RoomState,
  targetId: string,
  env: GameEnvironment,
) {
  const next = run(
    state,
    { type: 'CALL_NIGHT_ROLE', roleId: 'protector' },
    env,
  )
  return run(
    next,
    {
      type: 'SUBMIT_PROTECTOR_TARGET',
      playerId: 'player-5',
      targetId,
    },
    env,
  )
}

function completeWolfCall(
  state: RoomState,
  targetId: string,
  actorIds: readonly string[],
  env: GameEnvironment,
) {
  let next = run(
    state,
    { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
    env,
  )
  for (const actorId of actorIds) {
    next = run(
      next,
      { type: 'CAST_WOLF_VOTE', playerId: actorId, targetId },
      env,
    )
    next = run(
      next,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: actorId },
      env,
    )
  }
  return run(next, { type: 'RESOLVE_WOLF_VOTE' }, env)
}

function completeSeer(
  state: RoomState,
  targetId: string,
  env: GameEnvironment,
) {
  let next = run(
    state,
    { type: 'CALL_NIGHT_ROLE', roleId: 'seer' },
    env,
  )
  next = run(
    next,
    {
      type: 'SUBMIT_SEER_INSPECTION',
      playerId: 'player-4',
      targetId,
    },
    env,
  )
  const result = next.night?.actionsByRole.seer?.seer?.result
  next = run(
    next,
    { type: 'ACKNOWLEDGE_SEER_RESULT', playerId: 'player-4' },
    env,
  )
  return { state: next, result }
}

function reachDayAfterBite(
  clock: ReturnType<typeof environment>,
  protectorTargetId = 'player-7',
) {
  let state = factionRoom(clock.value)
  state = completeProtector(state, protectorTargetId, clock.value)
  state = completeWolfCall(
    state,
    'player-3',
    ['player-1', 'player-2'],
    clock.value,
  )
  const seer = completeSeer(state, 'player-3', clock.value)
  state = run(seer.state, { type: 'RESOLVE_NIGHT_EFFECTS' }, clock.value)
  state = run(state, { type: 'FINALIZE_NIGHT_CHECKPOINT' }, clock.value)
  state = run(state, { type: 'START_DAY' }, clock.value)
  return { state, seerResult: seer.result }
}

function closeVoteFor(
  state: RoomState,
  voterId: string,
  targetId: string,
  clock: ReturnType<typeof environment>,
) {
  let next = run(state, { type: 'OPEN_DAY_VOTE' }, clock.value)
  next = run(
    next,
    { type: 'CAST_DAY_VOTE', playerId: voterId, targetId },
    clock.value,
  )
  clock.advance(30_000)
  return run(next, { type: 'CLOSE_DAY_VOTE' }, clock.value)
}

describe('MS-1E natural faction transition lifecycle', () => {
  it('bites Half-Wolf on Night 1 and naturally transforms before Night 2 calls', () => {
    const clock = environment()
    const result = reachDayAfterBite(clock)
    let state = result.state
    const seerResult = result.seerResult
    expect(seerResult).toBe('NON_WOLF')
    expect(state.players[2].alive).toBe(true)
    expect(state.nightResolution).toMatchObject({
      outcome: 'BITE_SCHEDULED',
      provisionalDeathCandidateIds: [],
    })
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'PENDING_TRANSFORMATION',
    )

    state = closeVoteFor(state, 'player-1', 'player-7', clock)
    state = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)
    expect(state.dayNumber).toBe(2)
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'TRANSFORMED',
    )
    expect(state.night?.activeRoleId).toBeNull()

    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      clock.value,
    )
    expect(state.night?.actionsByRole.werewolf?.eligibleActorIds).toEqual([
      'player-1',
      'player-2',
      'player-3',
    ])
    expect(getEligibleWolfTargets(state)).not.toContain('player-3')
  })

  it('lets Protector block the bite and leaves Half-Wolf Village on Night 2', () => {
    const clock = environment()
    let { state } = reachDayAfterBite(clock, 'player-3')
    expect(state.nightResolution?.outcome).toBe('BLOCKED')
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'VILLAGE',
    )
    state = closeVoteFor(state, 'player-1', 'player-7', clock)
    state = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      clock.value,
    )
    expect(state.night?.actionsByRole.werewolf?.eligibleActorIds).toEqual([
      'player-1',
      'player-2',
    ])
    expect(getEligibleWolfTargets(state)).toContain('player-3')
  })

  it('converts Traitor permanently when the last normal Wolf dies before pending Half-Wolf transforms', () => {
    const clock = environment()
    let { state } = reachDayAfterBite(clock)
    state = closeVoteFor(state, 'player-6', 'player-1', clock)
    expect(state.players[0].alive).toBe(false)
    expect(state.factionTransitions?.traitors['player-2'].status).toBe(
      'CONVERTED_VILLAGE',
    )

    state = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'TRANSFORMED',
    )
    expect(state.factionTransitions?.traitors['player-2'].status).toBe(
      'CONVERTED_VILLAGE',
    )
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      clock.value,
    )
    expect(state.night?.actionsByRole.werewolf?.eligibleActorIds).toEqual([
      'player-3',
    ])
    expect(getEligibleWolfTargets(state)).toContain('player-2')
  })

  it('cancels a bitten Half-Wolf hanged before Night 2', () => {
    const clock = environment()
    let { state } = reachDayAfterBite(clock)
    state = closeVoteFor(state, 'player-1', 'player-3', clock)
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'CANCELED',
    )
    state = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)
    expect(state.factionTransitions?.halfWolves['player-3'].status).toBe(
      'CANCELED',
    )
  })
})
