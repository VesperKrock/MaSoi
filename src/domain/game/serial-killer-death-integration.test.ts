import { describe, expect, it } from 'vitest'
import {
  createInitialCupidLoverState,
  pairLovers,
} from '../gameplay/lovers'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoleId, RoomCommand, RoomState } from './types'

function clock() {
  let now = 20_000
  let id = 0
  return {
    value: {
      now: () => now,
      nextId: () => `g1-death-${++id}`,
      random: fixedRandom(0),
    } satisfies GameEnvironment,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

function run(state: RoomState, env: GameEnvironment, command: RoomCommand) {
  return applyRoomCommand(state, command, env)
}

function assign(state: RoomState, roles: RoleId[]) {
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: roles[index],
  }))
  state.config.roleComposition = roles.reduce<Partial<Record<RoleId, number>>>(
    (result, roleId) => {
      result[roleId] = (result[roleId] ?? 0) + 1
      return result
    },
    {},
  )
}

function callWolfWithTarget(state: RoomState, env: GameEnvironment) {
  let next = run(state, env, { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' })
  const targetId = next.night?.actionsByRole.werewolf?.eligibleTargetIds[0]
  if (!targetId) throw new Error('Expected a legal Wolf target')
  next = run(next, env, {
    type: 'CAST_WOLF_VOTE',
    playerId: 'player-1',
    targetId,
  })
  next = run(next, env, {
    type: 'CONFIRM_NIGHT_ACTION',
    playerId: 'player-1',
  })
  return run(next, env, { type: 'RESOLVE_WOLF_VOTE' })
}

function callSerialKiller(
  state: RoomState,
  env: GameEnvironment,
  targetId: string | null,
) {
  let next = run(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'serial-killer',
  })
  next = run(next, env, {
    type: 'CAST_SERIAL_KILLER_ATTACK',
    playerId: 'player-2',
    targetId,
  })
  return run(next, env, {
    type: 'CONFIRM_SERIAL_KILLER_ATTACK',
    playerId: 'player-2',
  })
}

describe('MS-1G1 existing death-pipeline integrations', () => {
  it('allows Night-2 Witch poison to kill Serial Killer', () => {
    const time = clock()
    let state = createDemoRoom(7, 'RANDOM_ON_TIE', time.value)
    assign(state, [
      'werewolf',
      'serial-killer',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    state.config.nightRoleIds = ['werewolf', 'serial-killer', 'witch']
    state.dayNumber = 2
    state = run(state, time.value, { type: 'START_NIGHT' })
    state = callWolfWithTarget(state, time.value)
    state = callSerialKiller(state, time.value, null)
    state = run(state, time.value, { type: 'RESOLVE_NIGHT_EFFECTS' })
    state = run(state, time.value, { type: 'CALL_NIGHT_ROLE', roleId: 'witch' })
    state = run(state, time.value, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-3',
      resurrectionTargetId: null,
      poisonTargetId: 'player-2',
    })
    state = run(state, time.value, { type: 'FINALIZE_NIGHT_CHECKPOINT' })

    expect(state.players[1].alive).toBe(false)
    expect(state.witchCheckpoint?.poisonEffect).toMatchObject({
      sourceType: 'WITCH_POISON',
      targetPlayerId: 'player-2',
      protectorBlockable: false,
    })
  })

  it('lets an existing Hunter Night shot kill Serial Killer', () => {
    const time = clock()
    let state = createDemoRoom(7, 'RANDOM_ON_TIE', time.value)
    assign(state, [
      'werewolf',
      'serial-killer',
      'hunter',
      'witch',
      'villager',
      'villager',
      'villager',
    ])
    state.config.nightRoleIds = ['werewolf', 'serial-killer', 'hunter', 'witch']
    state = run(state, time.value, { type: 'START_NIGHT' })
    let next = run(state, time.value, {
      type: 'CALL_NIGHT_ROLE', roleId: 'hunter',
    })
    next = run(next, time.value, {
      type: 'CAST_HUNTER_PRELOCK', playerId: 'player-3', targetId: 'player-2',
    })
    next = run(next, time.value, {
      type: 'CONFIRM_HUNTER_PRELOCK', playerId: 'player-3',
    })
    next = callSerialKiller(next, time.value, null)
    next = run(next, time.value, { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' })
    next = run(next, time.value, {
      type: 'CAST_WOLF_VOTE', playerId: 'player-1', targetId: 'player-3',
    })
    next = run(next, time.value, {
      type: 'CONFIRM_NIGHT_ACTION', playerId: 'player-1',
    })
    next = run(next, time.value, { type: 'RESOLVE_WOLF_VOTE' })
    next = run(next, time.value, { type: 'RESOLVE_NIGHT_EFFECTS' })
    next = run(next, time.value, { type: 'CALL_NIGHT_ROLE', roleId: 'witch' })
    next = run(next, time.value, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-4',
      resurrectionTargetId: null,
      poisonTargetId: null,
    })
    next = run(next, time.value, { type: 'FINALIZE_NIGHT_CHECKPOINT' })

    expect(next.players[1].alive).toBe(false)
    expect(next.nightResolution?.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'HUNTER_SHOT',
          targetPlayerId: 'player-2',
          protectorBlockable: false,
        }),
      ]),
    )
  })

  it('allows Day hanging and Hunter revenge to kill Serial Killer', () => {
    const hangingClock = clock()
    let hanging = createDemoRoom(7, 'RANDOM_ON_TIE', hangingClock.value)
    assign(hanging, [
      'villager',
      'serial-killer',
      'hunter',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    hanging.phase = 'DAY'
    hanging.night = null
    hanging = run(hanging, hangingClock.value, { type: 'OPEN_DAY_VOTE' })
    hanging = run(hanging, hangingClock.value, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-2',
    })
    hangingClock.advance(30_000)
    hanging = run(hanging, hangingClock.value, { type: 'CLOSE_DAY_VOTE' })
    expect(hanging.players[1].alive).toBe(false)
    expect(hanging.dayVote?.hangingEffect?.sourceType).toBe('DAY_HANGING')

    const revengeClock = clock()
    let revenge = createDemoRoom(7, 'RANDOM_ON_TIE', revengeClock.value)
    assign(revenge, [
      'villager',
      'serial-killer',
      'hunter',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    revenge.phase = 'DAY'
    revenge.night = null
    revenge = run(revenge, revengeClock.value, { type: 'OPEN_DAY_VOTE' })
    revenge = run(revenge, revengeClock.value, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-3',
    })
    revengeClock.advance(30_000)
    revenge = run(revenge, revengeClock.value, { type: 'CLOSE_DAY_VOTE' })
    revenge = run(revenge, revengeClock.value, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-3', targetId: 'player-2',
    })
    expect(revenge.players[1].alive).toBe(false)
    expect(revenge.dayVote?.hunterRevenge?.effect?.sourceType).toBe(
      'HUNTER_REVENGE_SHOT',
    )
  })

  it('allows Lover heartbreak to kill Serial Killer without changing its role', () => {
    const time = clock()
    let state = createDemoRoom(7, 'RANDOM_ON_TIE', time.value)
    assign(state, [
      'cupid',
      'serial-killer',
      'villager',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    const initial = createInitialCupidLoverState(
      state.roleAssignments,
      time.value.now(),
    )
    state.cupidLovers = pairLovers({
      state: initial,
      coupleId: 'g1-couple',
      cupidPlayerId: 'player-1',
      targetPlayerIds: ['player-2', 'player-3'],
      livingPlayerIds: state.players.map((player) => player.id),
      nightNumber: 1,
      now: time.value.now(),
    })
    state.phase = 'DAY'
    state.night = null
    state = run(state, time.value, { type: 'OPEN_DAY_VOTE' })
    state = run(state, time.value, {
      type: 'CAST_DAY_VOTE', playerId: 'player-4', targetId: 'player-3',
    })
    time.advance(30_000)
    state = run(state, time.value, { type: 'CLOSE_DAY_VOTE' })

    expect(state.players[1].alive).toBe(false)
    expect(state.dayVote?.consequenceEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'LOVER_HEARTBREAK',
          targetPlayerId: 'player-2',
          protectorBlockable: false,
        }),
      ]),
    )
    expect(state.roleAssignments[1].roleId).toBe('serial-killer')
  })
})
