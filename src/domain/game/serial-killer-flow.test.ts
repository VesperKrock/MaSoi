import { describe, expect, it } from 'vitest'
import { projectRoomSnapshot } from '../../state/room-projection'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoleId, RoomCommand, RoomState } from './types'

function environment(): GameEnvironment {
  let now = 70_000
  let id = 0
  return {
    now: () => ++now,
    nextId: () => `g1-${++id}`,
    random: fixedRandom(0),
  }
}

function run(
  state: RoomState,
  env: GameEnvironment,
  command: RoomCommand,
): RoomState {
  return applyRoomCommand(state, command, env)
}

function startedRoom(
  env: GameEnvironment,
  roles: RoleId[],
): RoomState {
  const state = createDemoRoom(roles.length, 'RANDOM_ON_TIE', env)
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
  state.config.nightRoleIds = [
    ...new Set(
      roles.filter((roleId) =>
        [
          'werewolf',
          'serial-killer',
          'protector',
          'hunter',
          'witch',
        ].includes(roleId),
      ),
    ),
  ]
  return run(state, env, { type: 'START_NIGHT' })
}

function completeWolf(
  state: RoomState,
  env: GameEnvironment,
  targetId: string,
): RoomState {
  let next = run(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'werewolf',
  })
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

function completeSerialKiller(
  state: RoomState,
  env: GameEnvironment,
  actorId: string,
  targetId: string | null,
): RoomState {
  let next = run(state, env, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'serial-killer',
  })
  next = run(next, env, {
    type: 'CAST_SERIAL_KILLER_ATTACK',
    playerId: actorId,
    targetId,
  })
  return run(next, env, {
    type: 'CONFIRM_SERIAL_KILLER_ATTACK',
    playerId: actorId,
  })
}

describe('MS-1G1 local Serial Killer authority flow', () => {
  it('keeps a mutable target/Nobody intent private and confirms exactly once', () => {
    const env = environment()
    let state = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    state = run(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'serial-killer',
    })
    state = run(state, env, {
      type: 'CAST_SERIAL_KILLER_ATTACK',
      playerId: 'player-2',
      targetId: 'player-4',
    })
    state = run(state, env, {
      type: 'CAST_SERIAL_KILLER_ATTACK',
      playerId: 'player-2',
      targetId: null,
    })

    const holder = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-2',
    })
    const ordinary = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-4',
    })
    expect(holder.audience).toBe('PLAYER')
    expect(ordinary.audience).toBe('PLAYER')
    if (holder.audience === 'PLAYER') {
      expect(holder.nightAction).toMatchObject({
        kind: 'SERIAL_KILLER_ATTACK',
        mode: 'SERIAL_KILLER_ATTACK',
        currentTargetId: null,
        hasSelected: true,
      })
      expect(holder.nightAction?.candidates.map((player) => player.id)).not.toContain(
        'player-2',
      )
    }
    if (ordinary.audience === 'PLAYER') {
      expect(ordinary.nightAction).toBeUndefined()
      expect(JSON.stringify(ordinary)).not.toContain('serial-killer')
    }

    state = run(state, env, {
      type: 'CONFIRM_SERIAL_KILLER_ATTACK',
      playerId: 'player-2',
    })
    expect(
      state.night?.calls.find((call) => call.roleId === 'serial-killer')?.status,
    ).toBe('COMPLETED')
    expect(() =>
      run(state, env, {
        type: 'CAST_SERIAL_KILLER_ATTACK',
        playerId: 'player-2',
        targetId: 'player-4',
      }),
    ).toThrow()
  })

  it('preserves Wolf and Serial Killer sources for one unprotected victim', () => {
    const env = environment()
    let state = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    state = completeWolf(state, env, 'player-4')
    state = completeSerialKiller(state, env, 'player-2', 'player-4')
    state = run(state, env, { type: 'RESOLVE_NIGHT_EFFECTS' })

    expect(state.nightResolution?.effects.map((effect) => effect.sourceType)).toEqual([
      'WOLF_ATTACK',
      'SERIAL_KILLER_ATTACK',
    ])
    expect(state.nightResolution?.provisionalDeathCandidateIds).toEqual([
      'player-4',
    ])
    expect(
      state.journal.find(
        (event) => event.type === 'NIGHT_DEATH_CANDIDATE_CREATED',
      )?.metadata?.sourceEffectIds,
    ).toHaveLength(2)
  })

  it('lets one Protector shield block both hostile sources', () => {
    const env = environment()
    let state = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'protector',
      'witch',
      'villager',
      'villager',
      'villager',
    ])
    state = completeWolf(state, env, 'player-5')
    state = completeSerialKiller(state, env, 'player-2', 'player-5')
    state = run(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'protector',
    })
    state = run(state, env, {
      type: 'SUBMIT_PROTECTOR_TARGET',
      playerId: 'player-3',
      targetId: 'player-5',
    })
    state = run(state, env, { type: 'RESOLVE_NIGHT_EFFECTS' })

    expect(state.nightResolution?.outcome).toBe('BLOCKED')
    expect(state.nightResolution?.effects.map((effect) => effect.outcome)).toEqual([
      'BLOCKED_BY_PROTECTOR',
      'BLOCKED_BY_PROTECTOR',
    ])
    expect(state.nightResolution?.provisionalDeathCandidateIds).toEqual([])
  })

  it('records Wolf immunity for Serial Killer unless Protector blocks first', () => {
    const env = environment()
    let immune = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    immune = completeWolf(immune, env, 'player-2')
    immune = completeSerialKiller(immune, env, 'player-2', null)
    immune = run(immune, env, { type: 'RESOLVE_NIGHT_EFFECTS' })
    expect(immune.nightResolution?.effects[0]).toMatchObject({
      sourceType: 'WOLF_ATTACK',
      outcome: 'IMMUNE_TO_WOLF_ATTACK',
      lethal: false,
    })
    expect(immune.nightResolution?.provisionalDeathCandidateIds).toEqual([])

    let shielded = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'protector',
      'witch',
      'villager',
      'villager',
      'villager',
    ])
    shielded = completeWolf(shielded, env, 'player-2')
    shielded = completeSerialKiller(shielded, env, 'player-2', null)
    shielded = run(shielded, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'protector',
    })
    shielded = run(shielded, env, {
      type: 'SUBMIT_PROTECTOR_TARGET',
      playerId: 'player-3',
      targetId: 'player-2',
    })
    shielded = run(shielded, env, { type: 'RESOLVE_NIGHT_EFFECTS' })
    expect(shielded.nightResolution?.effects[0].outcome).toBe(
      'BLOCKED_BY_PROTECTOR',
    )
  })

  it('treats a Serial Killer strike on untransformed Half-Wolf as ordinary lethal damage', () => {
    const env = environment()
    let state = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'half-wolf',
      'witch',
      'villager',
      'villager',
      'villager',
    ])
    state = completeWolf(state, env, 'player-5')
    state = completeSerialKiller(state, env, 'player-2', 'player-3')
    state = run(state, env, { type: 'RESOLVE_NIGHT_EFFECTS' })

    expect(state.nightResolution?.provisionalDeathCandidateIds).toContain(
      'player-3',
    )
    expect(state.factionTransitions?.halfWolves['player-3']?.status).toBe(
      'VILLAGE',
    )
    expect(
      state.journal.some(
        (event) =>
          event.type === 'HALF_WOLF_BITE_SCHEDULED' &&
          event.targetPlayerId === 'player-3',
      ),
    ).toBe(false)
  })

  it('keeps a dead-before-Night Serial Killer ritual visible but actionless', () => {
    const env = environment()
    let state = startedRoom(env, [
      'werewolf',
      'serial-killer',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    const killer = state.players.find((player) => player.id === 'player-2')
    if (!killer) throw new Error('Serial Killer missing')
    killer.alive = false

    state = run(state, env, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'serial-killer',
    })
    expect(state.night?.activeRoleId).toBe('serial-killer')
    expect(state.night?.actionsByRole['serial-killer']).toBeUndefined()
    state = run(state, env, {
      type: 'COMPLETE_NIGHT_CALL',
      roleId: 'serial-killer',
    })
    expect(
      state.night?.calls.find((call) => call.roleId === 'serial-killer')?.status,
    ).toBe('COMPLETED')
  })
})
