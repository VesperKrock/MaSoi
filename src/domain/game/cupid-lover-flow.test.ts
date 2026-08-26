import { describe, expect, it } from 'vitest'
import { projectRoomSnapshot } from '../../state/room-projection'
import { createInitialCupidLoverState } from '../gameplay/lovers'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoomCommand, RoomState } from './types'

function environment() {
  let now = 50_000
  let id = 0
  return {
    value: {
      now: () => now,
      nextId: () => `cupid-flow-${++id}`,
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

function nightRoom(
  env: GameEnvironment,
  roles: RoomState['roleAssignments'][number]['roleId'][],
): RoomState {
  const state = createDemoRoom(7, 'RANDOM_ON_TIE', env)
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: roles[index],
  }))
  state.config.roleComposition = roles.reduce<RoomState['config']['roleComposition']>(
    (composition, roleId) => {
      composition[roleId] = (composition[roleId] ?? 0) + 1
      return composition
    },
    {},
  )
  state.config.nightRoleIds = [
    ...new Set(
      roles.filter((roleId) =>
        ['werewolf', 'cupid', 'hunter', 'witch'].includes(roleId),
      ),
    ),
  ]
  state.cupidLovers = createInitialCupidLoverState(
    state.roleAssignments,
    env.now(),
  )
  return run(state, { type: 'START_NIGHT' }, env)
}

function pair(
  state: RoomState,
  env: GameEnvironment,
  loverPlayerIds: [string, string],
) {
  let next = run(state, { type: 'CALL_NIGHT_ROLE', roleId: 'cupid' }, env)
  next = run(
    next,
    {
      type: 'SUBMIT_CUPID_PAIRING',
      playerId: 'player-2',
      targetIds: loverPlayerIds,
    },
    env,
  )
  return next
}

function resolveWolf(
  state: RoomState,
  env: GameEnvironment,
  targetId: string,
) {
  let next = run(state, { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' }, env)
  next = run(
    next,
    { type: 'CAST_WOLF_VOTE', playerId: 'player-1', targetId },
    env,
  )
  next = run(
    next,
    { type: 'CONFIRM_NIGHT_ACTION', playerId: 'player-1' },
    env,
  )
  next = run(next, { type: 'RESOLVE_WOLF_VOTE' }, env)
  return run(next, { type: 'RESOLVE_NIGHT_EFFECTS' }, env)
}

function completeWitch(
  state: RoomState,
  env: GameEnvironment,
  resurrectionTargetId: string | null,
) {
  let next = run(state, { type: 'CALL_NIGHT_ROLE', roleId: 'witch' }, env)
  next = run(
    next,
    {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: 'player-3',
      resurrectionTargetId,
      poisonTargetId: null,
    },
    env,
  )
  return run(next, { type: 'FINALIZE_NIGHT_CHECKPOINT' }, env)
}

describe('MS-1F Cupid and Lovers room flow', () => {
  it('pairs only on Night 1 and keeps the relationship private to Cupid and each Lover', () => {
    const clock = environment()
    let state = nightRoom(clock.value, [
      'werewolf',
      'cupid',
      'witch',
      'villager',
      'villager',
      'villager',
      'villager',
    ])
    state = run(state, { type: 'CALL_NIGHT_ROLE', roleId: 'cupid' }, clock.value)

    const cupidAction = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-2',
    })
    expect(cupidAction.audience).toBe('PLAYER')
    if (cupidAction.audience !== 'PLAYER') throw new Error('wrong audience')
    expect(cupidAction.nightAction).toMatchObject({
      mode: 'CUPID_PAIRING',
      selectedTargetIds: [],
    })
    expect(cupidAction.nightAction?.candidates.map((target) => target.id)).not.toContain(
      'player-2',
    )

    state = run(
      state,
      {
        type: 'SUBMIT_CUPID_PAIRING',
        playerId: 'player-2',
        targetIds: ['player-4', 'player-5'],
      },
      clock.value,
    )
    const loverA = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-4',
    })
    const loverB = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-5',
    })
    const ordinary = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-6',
    })
    const cupid = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-2',
    })
    expect(loverA.audience).toBe('PLAYER')
    expect(loverB.audience).toBe('PLAYER')
    expect(ordinary.audience).toBe('PLAYER')
    expect(cupid.audience).toBe('PLAYER')
    if (
      loverA.audience !== 'PLAYER' ||
      loverB.audience !== 'PLAYER' ||
      ordinary.audience !== 'PLAYER' ||
      cupid.audience !== 'PLAYER'
    ) throw new Error('wrong audience')
    expect(loverA.loverRelationship?.partner).toMatchObject({ id: 'player-5' })
    expect(loverB.loverRelationship?.partner).toMatchObject({ id: 'player-4' })
    expect(ordinary.loverRelationship).toBeUndefined()
    expect(ordinary.cupidPair).toBeUndefined()
    expect(cupid.cupidPair?.lovers.map((lover) => lover.id)).toEqual([
      'player-4',
      'player-5',
    ])
    expect(loverA.loverRelationship?.partner).not.toHaveProperty('roleId')

    state = run(
      state,
      { type: 'ACKNOWLEDGE_LOVER_REVEAL', playerId: 'player-4' },
      clock.value,
    )
    const refreshed = projectRoomSnapshot(state, {
      kind: 'PLAYER', playerId: 'player-4',
    })
    expect(refreshed.audience).toBe('PLAYER')
    if (refreshed.audience !== 'PLAYER') throw new Error('wrong audience')
    expect(refreshed.loverRelationship).toMatchObject({ revealPending: false })
  })

  it('does not let Witch finalization pass an incomplete configured Cupid ritual', () => {
    const clock = environment()
    let state = nightRoom(clock.value, [
      'werewolf', 'cupid', 'witch', 'villager', 'villager', 'villager', 'villager',
    ])
    state = resolveWolf(state, clock.value, 'player-4')
    expect(() => completeWitch(state, clock.value, null)).toThrow(/trước Phù Thủy|nghi thức/i)
  })

  it('Witch rescue prevents final Lover death and therefore prevents heartbreak', () => {
    const clock = environment()
    let state = nightRoom(clock.value, [
      'werewolf', 'cupid', 'witch', 'villager', 'villager', 'villager', 'villager',
    ])
    state = pair(state, clock.value, ['player-4', 'player-5'])
    state = resolveWolf(state, clock.value, 'player-4')
    state = completeWitch(state, clock.value, 'player-4')
    expect(state.players.find((player) => player.id === 'player-4')?.alive).toBe(true)
    expect(state.players.find((player) => player.id === 'player-5')?.alive).toBe(true)
    expect(state.nightResolution?.effects).not.toContainEqual(
      expect.objectContaining({ sourceType: 'LOVER_HEARTBREAK' }),
    )
  })

  it('final Lover death creates one non-blockable heartbreak death and Cupid fallback', () => {
    const clock = environment()
    let state = nightRoom(clock.value, [
      'werewolf', 'cupid', 'witch', 'villager', 'villager', 'villager', 'villager',
    ])
    state = pair(state, clock.value, ['player-4', 'player-5'])
    state = resolveWolf(state, clock.value, 'player-4')
    state = completeWitch(state, clock.value, null)
    expect(state.players.filter((player) => !player.alive).map((player) => player.id)).toEqual([
      'player-4',
      'player-5',
    ])
    expect(state.nightResolution?.effects).toContainEqual(
      expect.objectContaining({
        sourceType: 'LOVER_HEARTBREAK',
        sourcePlayerId: 'player-4',
        targetPlayerId: 'player-5',
        protectorBlockable: false,
        witchInteractable: false,
      }),
    )
    expect(state.cupidLovers?.objective).toMatchObject({
      status: 'FALLBACK_VILLAGE',
      reason: 'COUPLE_DEAD',
    })
    expect(state.roleAssignments.find((entry) => entry.playerId === 'player-2')?.roleId).toBe('cupid')
  })

  it('stabilizes Night heartbreak into the existing Hunter pre-lock shot', () => {
    const clock = environment()
    let state = nightRoom(clock.value, [
      'werewolf', 'cupid', 'witch', 'hunter', 'villager', 'villager', 'villager',
    ])
    state = pair(state, clock.value, ['player-4', 'player-5'])
    state = run(state, { type: 'CALL_NIGHT_ROLE', roleId: 'hunter' }, clock.value)
    state = run(
      state,
      { type: 'CAST_HUNTER_PRELOCK', playerId: 'player-4', targetId: 'player-6' },
      clock.value,
    )
    state = run(
      state,
      { type: 'CONFIRM_HUNTER_PRELOCK', playerId: 'player-4' },
      clock.value,
    )
    state = resolveWolf(state, clock.value, 'player-5')
    state = completeWitch(state, clock.value, null)
    expect(state.players.filter((player) => !player.alive).map((player) => player.id)).toEqual([
      'player-4',
      'player-5',
      'player-6',
    ])
    expect(state.witchCheckpoint?.conditionalEffectStates).toContainEqual(
      expect.objectContaining({ status: 'ACTIVATED' }),
    )
  })

  it('propagates hanging and Hunter revenge through Lovers before allowing next Night', () => {
    const clock = environment()
    let hanging = nightRoom(clock.value, [
      'werewolf', 'cupid', 'witch', 'villager', 'villager', 'villager', 'villager',
    ])
    hanging = pair(hanging, clock.value, ['player-4', 'player-5'])
    hanging.phase = 'DAY'
    hanging.night = null
    hanging.witchCheckpoint = undefined
    hanging.nightResolution = undefined
    hanging = run(hanging, { type: 'OPEN_DAY_VOTE' }, clock.value)
    hanging = run(
      hanging,
      { type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-4' },
      clock.value,
    )
    clock.advance(30_000)
    hanging = run(hanging, { type: 'CLOSE_DAY_VOTE' }, clock.value)
    expect(hanging.players.filter((player) => !player.alive).map((player) => player.id)).toEqual([
      'player-4',
      'player-5',
    ])
    expect(hanging.dayVote?.consequenceEffects).toContainEqual(
      expect.objectContaining({ sourceType: 'LOVER_HEARTBREAK' }),
    )

    const revengeClock = environment()
    let revenge = nightRoom(revengeClock.value, [
      'werewolf', 'cupid', 'witch', 'hunter', 'villager', 'villager', 'villager',
    ])
    revenge = pair(revenge, revengeClock.value, ['player-5', 'player-6'])
    revenge.phase = 'DAY'
    revenge.night = null
    revenge.witchCheckpoint = undefined
    revenge.nightResolution = undefined
    revenge = run(revenge, { type: 'OPEN_DAY_VOTE' }, revengeClock.value)
    revenge = run(
      revenge,
      { type: 'CAST_DAY_VOTE', playerId: 'player-1', targetId: 'player-4' },
      revengeClock.value,
    )
    revengeClock.advance(30_000)
    revenge = run(revenge, { type: 'CLOSE_DAY_VOTE' }, revengeClock.value)
    expect(() => run(revenge, { type: 'START_NEXT_NIGHT' }, revengeClock.value)).toThrow(/Thợ Săn/i)
    revenge = run(
      revenge,
      { type: 'SUBMIT_HUNTER_REVENGE', playerId: 'player-4', targetId: 'player-5' },
      revengeClock.value,
    )
    expect(revenge.players.filter((player) => !player.alive).map((player) => player.id)).toEqual([
      'player-4',
      'player-5',
      'player-6',
    ])
  })
})
