import { describe, expect, it } from 'vitest'
import { projectRoomSnapshot } from '../../state/room-projection'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoomCommand, RoomState } from './types'

function environment(): GameEnvironment {
  let now = 10_000
  let id = 0
  return {
    now: () => ++now,
    nextId: () => `hunter-flow-${++id}`,
    random: fixedRandom(0),
  }
}

function command(
  state: RoomState,
  env: GameEnvironment,
  next: RoomCommand,
): RoomState {
  return applyRoomCommand(state, next, env)
}

function startedHunterWitchRoom(env: GameEnvironment): RoomState {
  const state = createDemoRoom(7, 'RANDOM_ON_TIE', env)
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId:
      index === 0
        ? ('werewolf' as const)
        : index === 1
          ? ('hunter' as const)
          : index === 2
            ? ('witch' as const)
            : ('villager' as const),
  }))
  state.config.roleComposition = {
    werewolf: 1,
    hunter: 1,
    witch: 1,
    villager: 4,
  }
  state.config.nightRoleIds = ['werewolf', 'hunter', 'witch']
  return command(state, env, { type: 'START_NIGHT' })
}

function lockHunterTarget(
  state: RoomState,
  env: GameEnvironment,
  targetId: string | null,
): RoomState {
  let next = command(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'hunter',
  })
  next = command(next, env, {
    type: 'CAST_HUNTER_PRELOCK',
    playerId: 'player-2',
    targetId: targetId === 'player-5' ? 'player-4' : 'player-5',
  })
  next = command(next, env, {
    type: 'CAST_HUNTER_PRELOCK',
    playerId: 'player-2',
    targetId,
  })
  return command(next, env, {
    type: 'CONFIRM_HUNTER_PRELOCK',
    playerId: 'player-2',
  })
}

function completeWolfOnHunter(
  state: RoomState,
  env: GameEnvironment,
): RoomState {
  let next = command(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'werewolf',
  })
  next = command(next, env, {
    type: 'CAST_WOLF_VOTE',
    playerId: 'player-1',
    targetId: 'player-2',
  })
  next = command(next, env, {
    type: 'CONFIRM_NIGHT_ACTION',
    playerId: 'player-1',
  })
  return command(next, env, { type: 'RESOLVE_WOLF_VOTE' })
}

function openWitch(
  state: RoomState,
  env: GameEnvironment,
): RoomState {
  const next = command(state, env, { type: 'RESOLVE_NIGHT_EFFECTS' })
  return command(next, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'witch',
  })
}

describe('MS-1D1 local Hunter, Witch, and morning flow', () => {
  it('keeps a mutable pre-lock private and exposes shot victims to Witch by name only', () => {
    const env = environment()
    let state = startedHunterWitchRoom(env)
    state = command(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'hunter',
    })
    state = command(state, env, {
      type: 'CAST_HUNTER_PRELOCK',
      playerId: 'player-2',
      targetId: 'player-4',
    })
    state = command(state, env, {
      type: 'CAST_HUNTER_PRELOCK',
      playerId: 'player-2',
      targetId: 'player-5',
    })

    const hunter = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-2',
    })
    const other = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-4',
    })
    expect(hunter.audience).toBe('PLAYER')
    expect(other.audience).toBe('PLAYER')
    if (hunter.audience !== 'PLAYER' || other.audience !== 'PLAYER') return
    expect(hunter.nightAction).toMatchObject({
      mode: 'HUNTER_PRELOCK',
      currentTargetId: 'player-5',
      hasSelected: true,
    })
    expect(other.nightAction).toBeUndefined()

    state = command(state, env, {
      type: 'CONFIRM_HUNTER_PRELOCK',
      playerId: 'player-2',
    })
    const confirmedHunter = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-2',
    })
    expect(confirmedHunter.audience).toBe('PLAYER')
    if (confirmedHunter.audience === 'PLAYER') {
      expect(confirmedHunter.nightAction).toBeUndefined()
    }

    state = completeWolfOnHunter(state, env)
    state = openWitch(state, env)
    const witch = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-3',
    })
    expect(witch.audience).toBe('PLAYER')
    if (witch.audience !== 'PLAYER') return
    expect(
      witch.nightAction?.resurrectionCandidates?.map((player) => player.id),
    ).toEqual(['player-2', 'player-5'])
    expect(JSON.stringify(witch)).not.toContain('HUNTER_SHOT')
    expect(JSON.stringify(witch)).not.toContain('WOLF_ATTACK')
  })

  it('cancels the shot when Witch resurrects Hunter and does not auto-transition', () => {
    const env = environment()
    let state = lockHunterTarget(
      startedHunterWitchRoom(env),
      env,
      'player-5',
    )
    state = openWitch(completeWolfOnHunter(state, env), env)
    state = command(state, env, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-3',
      resurrectionTargetId: 'player-2',
      poisonTargetId: null,
    })
    state = command(state, env, { type: 'FINALIZE_NIGHT_CHECKPOINT' })

    expect(state.phase).toBe('NIGHT')
    expect(state.witchCheckpoint?.conditionalEffectStates).toEqual([
      {
        effectId: expect.any(String),
        status: 'CANCELED_SOURCE_SURVIVED',
      },
    ])
    expect(state.witchCheckpoint?.finalDeaths).toEqual([])
    expect(state.players.every((player) => player.alive)).toBe(true)

    state = command(state, env, { type: 'START_DAY' })
    expect(state.phase).toBe('DAY')
    expect(state.dayVote).toBeNull()
    expect(state.journal.at(-2)?.type).toBe('MORNING_STARTED')
    const eventCount = state.journal.length
    const retry = command(state, env, { type: 'START_DAY' })
    expect(retry.phase).toBe('DAY')
    expect(retry.journal).toHaveLength(eventCount)
  })

  it('activates the shot, masks both deaths during Night, then exposes death state in Day', () => {
    const env = environment()
    let state = lockHunterTarget(
      startedHunterWitchRoom(env),
      env,
      'player-5',
    )
    state = openWitch(completeWolfOnHunter(state, env), env)
    state = command(state, env, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-3',
      resurrectionTargetId: null,
      poisonTargetId: null,
    })
    state = command(state, env, { type: 'FINALIZE_NIGHT_CHECKPOINT' })

    expect(state.witchCheckpoint?.finalDeaths.map((death) => death.playerId)).toEqual([
      'player-2',
      'player-5',
    ])
    for (const playerId of ['player-2', 'player-5']) {
      const hidden = projectRoomSnapshot(state, {
        kind: 'PLAYER',
        playerId,
      })
      expect(hidden.audience).toBe('PLAYER')
      if (hidden.audience === 'PLAYER') expect(hidden.self.alive).toBe(true)
    }

    state = command(state, env, { type: 'START_DAY' })
    for (const playerId of ['player-2', 'player-5']) {
      const visible = projectRoomSnapshot(state, {
        kind: 'PLAYER',
        playerId,
      })
      expect(visible.audience).toBe('PLAYER')
      if (visible.audience === 'PLAYER') {
        expect(visible.self.alive).toBe(false)
        expect(visible.dayVote).toBeUndefined()
      }
    }
  })

  it('allows Nobody and keeps a dead-before-Night Hunter actionless while preserving ritual', () => {
    const env = environment()
    let nobody = lockHunterTarget(startedHunterWitchRoom(env), env, null)
    nobody = openWitch(completeWolfOnHunter(nobody, env), env)
    expect(nobody.nightResolution?.effects).toHaveLength(1)
    expect(nobody.nightResolution?.provisionalDeathCandidateIds).toEqual([
      'player-2',
    ])

    let dead = startedHunterWitchRoom(env)
    const hunter = dead.players.find((player) => player.id === 'player-2')
    if (!hunter) throw new Error('Missing Hunter')
    hunter.alive = false
    dead = command(dead, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'hunter',
    })
    expect(dead.night?.actionsByRole.hunter).toBeUndefined()
    for (const player of dead.players) {
      const snapshot = projectRoomSnapshot(dead, {
        kind: 'PLAYER',
        playerId: player.id,
      })
      if (snapshot.audience === 'PLAYER') {
        expect(snapshot.nightAction).toBeUndefined()
      }
    }
    dead = command(dead, env, {
      type: 'COMPLETE_NIGHT_CALL',
      roleId: 'hunter',
    })
    expect(
      dead.night?.calls.find((call) => call.roleId === 'hunter')?.status,
    ).toBe('COMPLETED')
  })
})
