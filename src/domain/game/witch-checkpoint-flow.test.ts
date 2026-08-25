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
  let now = 1_000
  let id = 0
  return {
    now: () => ++now,
    nextId: () => `witch-flow-${++id}`,
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

function startedWitchRoom(env: GameEnvironment): RoomState {
  const state = createDemoRoom(7, 'RANDOM_ON_TIE', env)
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId:
      index === 0
        ? ('werewolf' as const)
        : index === 1
          ? ('witch' as const)
          : ('villager' as const),
  }))
  state.config.roleComposition = { werewolf: 1, witch: 1, villager: 5 }
  state.config.nightRoleIds = ['werewolf', 'witch']
  return command(state, env, { type: 'START_NIGHT' })
}

function resolveWolfTarget(
  state: RoomState,
  env: GameEnvironment,
  targetId: string,
): RoomState {
  let next = command(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'werewolf',
  })
  next = command(next, env, {
    type: 'CAST_WOLF_VOTE',
    playerId: 'player-1',
    targetId,
  })
  next = command(next, env, {
    type: 'CONFIRM_NIGHT_ACTION',
    playerId: 'player-1',
  })
  next = command(next, env, { type: 'RESOLVE_WOLF_VOTE' })
  return command(next, env, { type: 'RESOLVE_NIGHT_EFFECTS' })
}

describe('MS-1C local room Witch checkpoint flow', () => {
  it('requires B2 resolution, projects victim names only, then rescues atomically', () => {
    const env = environment()
    let state = startedWitchRoom(env)
    expect(() =>
      command(state, env, { type: 'CALL_NIGHT_ROLE', roleId: 'witch' }),
    ).toThrow(/lượt gọi trước|phân giải/i)

    state = resolveWolfTarget(state, env, 'player-4')
    state = command(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'witch',
    })
    const projection = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-2',
    })
    expect(projection.audience).toBe('PLAYER')
    if (projection.audience !== 'PLAYER') throw new Error('wrong audience')
    expect(projection.nightAction?.mode).toBe('WITCH_DECISION')
    expect(
      projection.nightAction?.resurrectionCandidates?.map(
        (player) => player.id,
      ),
    ).toEqual(['player-4'])
    expect(JSON.stringify(projection)).not.toContain('WOLF_ATTACK')

    state = command(state, env, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-2',
      resurrectionTargetId: 'player-4',
      poisonTargetId: null,
    })
    state = command(state, env, { type: 'FINALIZE_NIGHT_CHECKPOINT' })
    expect(state.phase).toBe('NIGHT')
    expect(state.players.find((player) => player.id === 'player-4')?.alive).toBe(true)
    expect(state.witchResources).toMatchObject({
      resurrectionAvailable: false,
      poisonAvailable: true,
    })
    expect(state.nightResolution?.effects[0].sourceType).toBe('WOLF_ATTACK')
  })

  it('finalizes an unrescued victim but keeps their Night projection neutral', () => {
    const env = environment()
    let state = resolveWolfTarget(startedWitchRoom(env), env, 'player-4')
    state = command(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'witch',
    })
    expect(() =>
      command(state, env, {
        type: 'SUBMIT_WITCH_DECISION',
        playerId: 'player-2',
        resurrectionTargetId: null,
        poisonTargetId: 'player-4',
      }),
    ).toThrow(/NIGHT_ONE|Đêm 1/i)
    state = command(state, env, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-2',
      resurrectionTargetId: null,
      poisonTargetId: null,
    })
    state = command(state, env, { type: 'FINALIZE_NIGHT_CHECKPOINT' })
    expect(state.players.find((player) => player.id === 'player-4')?.alive).toBe(false)

    const victim = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-4',
    })
    expect(victim.audience).toBe('PLAYER')
    if (victim.audience !== 'PLAYER') throw new Error('wrong audience')
    expect(victim.phase).toBe('NIGHT')
    expect(victim.self.alive).toBe(true)
    expect(victim.nightAction).toBeUndefined()
    expect(JSON.stringify(victim)).not.toContain('finalDeaths')
  })
})
