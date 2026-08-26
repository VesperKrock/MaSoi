import { describe, expect, it } from 'vitest'
import { getEligibleRoleTargets } from '../actions/target-rules'
import { fixedRandom } from '../voting/random'
import { projectRoomSnapshot } from '../../state/room-projection'
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
      nextId: () => `d2-${++id}`,
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

function dayRoom(env: GameEnvironment): RoomState {
  const state = createDemoRoom(7, 'RANDOM_ON_TIE', env)
  state.phase = 'DAY'
  state.dayNumber = 1
  state.night = null
  state.dayVote = null
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: [
      'mayor',
      'hunter',
      'protector',
      'witch',
      'werewolf',
      'villager',
      'villager',
    ][index] as RoomState['roleAssignments'][number]['roleId'],
  }))
  state.config.roleComposition = {
    mayor: 1,
    hunter: 1,
    protector: 1,
    witch: 1,
    werewolf: 1,
    villager: 2,
  }
  state.config.nightRoleIds = ['werewolf', 'protector', 'hunter', 'witch']
  return state
}

describe('MS-1D2 authoritative Day cycle', () => {
  it('enforces start/deadline/living/no-self and change-or-second-tap clear', () => {
    const clock = environment()
    let state = dayRoom(clock.value)

    expect(() =>
      run(state, {
        type: 'CAST_DAY_VOTE',
        playerId: 'player-1',
        targetId: 'player-2',
      }, clock.value),
    ).toThrow(/chưa mở/i)

    state = run(state, { type: 'OPEN_DAY_VOTE' }, clock.value)
    expect(state.dayVote?.deadlineAt).toBe(40_000)
    expect(() => run(state, { type: 'CLOSE_DAY_VOTE' }, clock.value)).toThrow(
      /không thể chốt sớm/i,
    )
    expect(() =>
      run(state, {
        type: 'CAST_DAY_VOTE',
        playerId: 'player-1',
        targetId: 'player-1',
      }, clock.value),
    ).toThrow(/không hợp lệ/i)

    state = run(state, {
      type: 'CAST_DAY_VOTE',
      playerId: 'player-1',
      targetId: 'player-2',
    }, clock.value)
    state = run(state, {
      type: 'CAST_DAY_VOTE',
      playerId: 'player-1',
      targetId: 'player-3',
    }, clock.value)
    expect(state.dayVote?.votes['player-1']).toBe('player-3')
    state = run(state, {
      type: 'CAST_DAY_VOTE',
      playerId: 'player-1',
      targetId: 'player-3',
    }, clock.value)
    expect(state.dayVote?.votes['player-1']).toBeNull()

    state.players[4].alive = false
    expect(() =>
      run(state, {
        type: 'CAST_DAY_VOTE',
        playerId: 'player-5',
        targetId: 'player-2',
      }, clock.value),
    ).toThrow(/còn sống/i)
    clock.advance(30_000)
    expect(() =>
      run(state, {
        type: 'CAST_DAY_VOTE',
        playerId: 'player-2',
        targetId: 'player-3',
      }, clock.value),
    ).toThrow(/kết thúc/i)
  })

  it('derives Mayor x2, hangs a unique positive top, and keeps an exact top tie harmless', () => {
    const clock = environment()
    let weighted = run(dayRoom(clock.value), { type: 'OPEN_DAY_VOTE' }, clock.value)
    weighted = run(weighted, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-6',
    }, clock.value)
    weighted = run(weighted, {
      type: 'CAST_DAY_VOTE', playerId: 'player-3', targetId: 'player-7',
    }, clock.value)
    clock.advance(30_000)
    weighted = run(weighted, { type: 'CLOSE_DAY_VOTE' }, clock.value)
    expect(weighted.dayVote?.result).toMatchObject({
      kind: 'UNIQUE',
      targetIds: ['player-6'],
      counts: { 'player-6': 2, 'player-7': 1 },
    })
    expect(weighted.players[5].alive).toBe(false)
    expect(weighted.dayVote?.hangingEffect).toMatchObject({
      sourceType: 'DAY_HANGING',
      protectorBlockable: false,
      finalized: true,
    })
    expect(weighted.dayVote?.hunterRevenge).toBeUndefined()

    const tieClock = environment()
    let tied = run(dayRoom(tieClock.value), { type: 'OPEN_DAY_VOTE' }, tieClock.value)
    tied = run(tied, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-6',
    }, tieClock.value)
    tied = run(tied, {
      type: 'CAST_DAY_VOTE', playerId: 'player-3', targetId: 'player-7',
    }, tieClock.value)
    tied = run(tied, {
      type: 'CAST_DAY_VOTE', playerId: 'player-4', targetId: 'player-7',
    }, tieClock.value)
    tieClock.advance(30_000)
    tied = run(tied, { type: 'CLOSE_DAY_VOTE' }, tieClock.value)
    expect(tied.dayVote?.result?.kind).toBe('TIE')
    expect(tied.players.every((player) => player.alive)).toBe(true)
    expect(tied.dayVote?.hangingEffect).toBeUndefined()
  })

  it('reveals only a hanged Hunter and resolves target/Nobody once', () => {
    const clock = environment()
    let state = run(dayRoom(clock.value), { type: 'OPEN_DAY_VOTE' }, clock.value)
    state = run(state, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-2',
    }, clock.value)
    clock.advance(30_000)
    state = run(state, { type: 'CLOSE_DAY_VOTE' }, clock.value)
    expect(state.players[1].alive).toBe(false)
    expect(state.dayVote?.hunterRevenge).toMatchObject({
      hunterPlayerId: 'player-2',
      status: 'PENDING',
    })
    expect(() => run(state, { type: 'START_NEXT_NIGHT' }, clock.value)).toThrow(
      /Thợ Săn/i,
    )
    expect(() => run(state, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-3', targetId: 'player-4',
    }, clock.value)).toThrow(/vừa bị treo cổ/i)
    expect(() => run(state, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-2', targetId: 'player-2',
    }, clock.value)).toThrow(/không hợp lệ/i)

    state = run(state, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-2', targetId: 'player-3',
    }, clock.value)
    expect(state.players[2].alive).toBe(false)
    expect(state.dayVote?.hunterRevenge).toMatchObject({
      status: 'RESOLVED',
      targetPlayerId: 'player-3',
      effect: {
        sourceType: 'HUNTER_REVENGE_SHOT',
        protectorBlockable: false,
      },
    })
    const retry = run(state, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-2', targetId: 'player-3',
    }, clock.value)
    expect(retry.dayVote?.hunterRevenge).toEqual(state.dayVote?.hunterRevenge)

    const nobodyClock = environment()
    let nobody = run(dayRoom(nobodyClock.value), { type: 'OPEN_DAY_VOTE' }, nobodyClock.value)
    nobody = run(nobody, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-2',
    }, nobodyClock.value)
    nobodyClock.advance(30_000)
    nobody = run(nobody, { type: 'CLOSE_DAY_VOTE' }, nobodyClock.value)
    nobody = run(nobody, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-2', targetId: null,
    }, nobodyClock.value)
    expect(nobody.dayVote?.hunterRevenge).toMatchObject({
      status: 'RESOLVED', targetPlayerId: null,
    })
    expect(nobody.players.filter((player) => !player.alive).map((player) => player.id)).toEqual(['player-2'])
  })

  it('starts Night 2 exactly once with fresh Night state and permanent truth intact', () => {
    const clock = environment()
    let state = dayRoom(clock.value)
    state.witchResources = {
      witchPlayerId: 'player-4',
      resurrectionAvailable: false,
      poisonAvailable: true,
    }
    state.journal.push({
      id: 'protector-night-1',
      type: 'PROTECTOR_INTENT',
      timestamp: 9_000,
      dayNumber: 1,
      phase: 'NIGHT',
      actorPlayerId: 'player-3',
      actorRoleId: 'protector',
      targetPlayerId: 'player-6',
    })
    state = run(state, { type: 'OPEN_DAY_VOTE' }, clock.value)
    state = run(state, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-7',
    }, clock.value)
    clock.advance(30_000)
    state = run(state, { type: 'CLOSE_DAY_VOTE' }, clock.value)
    state = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)

    expect(state.phase).toBe('NIGHT')
    expect(state.dayNumber).toBe(2)
    expect(state.night).toMatchObject({ number: 2, activeRoleId: null, actionsByRole: {} })
    expect(state.night?.calls.every((call) => call.status === 'NOT_CALLED')).toBe(true)
    expect(state.witchResources?.resurrectionAvailable).toBe(false)
    expect(state.players[6].alive).toBe(false)
    expect(getEligibleRoleTargets(state, 'protector', 'player-3')).not.toContain('player-6')

    const retry = run(state, { type: 'START_NEXT_NIGHT' }, clock.value)
    expect(retry.dayNumber).toBe(2)
    expect(retry.night?.activeRoleId).toBeNull()
  })

  it('projects only own ballot plus anonymous totals and only reveals a hanged Hunter', () => {
    const clock = environment()
    let state = run(dayRoom(clock.value), { type: 'OPEN_DAY_VOTE' }, clock.value)
    state = run(state, {
      type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-2',
    }, clock.value)
    state = run(state, {
      type: 'CAST_DAY_VOTE', playerId: 'player-3', targetId: 'player-6',
    }, clock.value)
    const mayor = projectRoomSnapshot(state, { kind: 'PLAYER', playerId: 'player-1' })
    const observer = projectRoomSnapshot(state, { kind: 'PLAYER', playerId: 'player-4' })
    expect(mayor.audience).toBe('PLAYER')
    expect(observer.audience).toBe('PLAYER')
    if (mayor.audience !== 'PLAYER' || observer.audience !== 'PLAYER') return
    expect(mayor.dayVote).toMatchObject({
      currentTargetId: 'player-2',
      totals: { 'player-2': 2, 'player-6': 1 },
    })
    expect(observer.dayVote?.currentTargetId).toBeUndefined()
    expect(observer.dayVote).not.toHaveProperty('votes')
    expect(observer).not.toHaveProperty('roleAssignments')

    clock.advance(30_000)
    state = run(state, { type: 'CLOSE_DAY_VOTE' }, clock.value)
    const publicResult = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-4',
    })
    const hunterResult = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-2',
    })
    expect(publicResult.audience).toBe('PLAYER')
    expect(hunterResult.audience).toBe('PLAYER')
    if (publicResult.audience !== 'PLAYER' || hunterResult.audience !== 'PLAYER') return
    expect(publicResult.dayVote?.result).toMatchObject({
      hangedPlayer: { id: 'player-2' },
      hunterRevealed: true,
      hunterRevengeStatus: 'PENDING',
    })
    expect(publicResult.dayVote?.hunterRevengeAction).toBeUndefined()
    expect(hunterResult.dayVote?.hunterRevengeAction?.candidates).toHaveLength(6)
  })
})
