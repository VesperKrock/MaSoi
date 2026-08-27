import { describe, expect, it } from 'vitest'
import { projectRoomSnapshot } from '../../state/room-projection'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoomCommand, RoomState } from './types'

function testContext() {
  let timestamp = 5_000
  let id = 0
  const environment: GameEnvironment = {
    now: () => timestamp,
    nextId: () => `id-${++id}`,
    random: fixedRandom(0),
  }
  return {
    environment,
    advance(milliseconds: number) {
      timestamp += milliseconds
    },
  }
}

function run(
  state: RoomState,
  command: RoomCommand,
  environment: GameEnvironment,
) {
  return applyRoomCommand(state, command, environment)
}

describe('REVOTE_10S room flow', () => {
  it('restricts the revote pool, permits changes, and resolves a unique top early', () => {
    const { environment } = testContext()
    let state = createDemoRoom(6, 'REVOTE_10S', environment)
    state = run(state, { type: 'START_NIGHT' }, environment)
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      environment,
    )
    const initial = state.night?.actionsByRole.werewolf
    if (!initial) throw new Error('Expected initial wolf action')
    const [wolfA, wolfB] = initial.eligibleActorIds
    const [targetA, targetB, excludedTarget] = initial.eligibleTargetIds

    for (const [playerId, targetId] of [
      [wolfA, targetA],
      [wolfB, targetB],
    ] as const) {
      state = run(
        state,
        { type: 'CAST_WOLF_VOTE', playerId, targetId },
        environment,
      )
      state = run(
        state,
        { type: 'CONFIRM_NIGHT_ACTION', playerId },
        environment,
      )
    }
    state = run(state, { type: 'RESOLVE_WOLF_VOTE' }, environment)

    const revote = state.night?.actionsByRole.werewolf
    expect(revote?.wolf).toEqual({
      round: 'REVOTE',
      initialTiedTargetIds: [targetA, targetB],
      deadlineAt: 15_000,
    })
    expect(revote?.eligibleTargetIds).toEqual([targetA, targetB])
    expect(() =>
      run(
        state,
        { type: 'CAST_WOLF_VOTE', playerId: wolfA, targetId: excludedTarget },
        environment,
      ),
    ).toThrow('Mục tiêu không hợp lệ')

    state = run(
      state,
      { type: 'CAST_WOLF_VOTE', playerId: wolfA, targetId: targetB },
      environment,
    )
    state = run(
      state,
      { type: 'CAST_WOLF_VOTE', playerId: wolfA, targetId: targetA },
      environment,
    )
    state = run(
      state,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfA },
      environment,
    )
    state = run(state, { type: 'RESOLVE_WOLF_VOTE' }, environment)

    expect(state.night?.actionsByRole.werewolf?.result).toEqual({
      targetId: targetA,
      random: false,
      reason: 'REVOTE_UNIQUE_TOP',
    })
    expect(
      state.journal.filter((event) => event.type === 'WOLF_REVOTE_CHANGED'),
    ).toHaveLength(2)
    expect(
      state.journal.some((event) => event.type === 'WOLF_REVOTE_STARTED'),
    ).toBe(true)
    expect(
      state.journal.some(
        (event) =>
          event.type === 'FINAL_RESULT' && event.targetPlayerId === targetA,
      ),
    ).toBe(true)
  })

  it('rejects zero valid revote ballots before and after the deadline', () => {
    const { environment, advance } = testContext()
    let state = createDemoRoom(6, 'REVOTE_10S', environment)
    state = run(state, { type: 'START_NIGHT' }, environment)
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      environment,
    )
    const initial = state.night?.actionsByRole.werewolf
    if (!initial) throw new Error('Expected initial wolf action')
    const [wolfA, wolfB] = initial.eligibleActorIds
    const [targetA, targetB] = initial.eligibleTargetIds

    for (const [playerId, targetId] of [
      [wolfA, targetA],
      [wolfB, targetB],
    ] as const) {
      state = run(
        state,
        { type: 'CAST_WOLF_VOTE', playerId, targetId },
        environment,
      )
      state = run(
        state,
        { type: 'CONFIRM_NIGHT_ACTION', playerId },
        environment,
      )
    }
    state = run(state, { type: 'RESOLVE_WOLF_VOTE' }, environment)

    expect(() =>
      run(
        state,
        { type: 'RESOLVE_WOLF_VOTE', atDeadline: true },
        environment,
      ),
    ).toThrow('WOLF_TARGET_REQUIRED')

    advance(10_000)
    expect(() =>
      run(
        state,
        { type: 'RESOLVE_WOLF_VOTE', atDeadline: true },
        environment,
      ),
    ).toThrow('WOLF_TARGET_REQUIRED')
  })
})

describe('HF1 mandatory target and authoritative pack projection', () => {
  it('denies null/confirm-without-target and resolves one confirmed target with a missing teammate', () => {
    const { environment } = testContext()
    let state = createDemoRoom(6, 'RANDOM_ON_TIE', environment)
    state = run(state, { type: 'START_NIGHT' }, environment)
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      environment,
    )
    const action = state.night?.actionsByRole.werewolf
    if (!action) throw new Error('Expected Wolf action')
    const [wolfA] = action.eligibleActorIds
    const [target] = action.eligibleTargetIds

    expect(() =>
      run(
        state,
        {
          type: 'CAST_WOLF_VOTE',
          playerId: wolfA,
          targetId: null,
        } as unknown as RoomCommand,
        environment,
      ),
    ).toThrow('Mục tiêu không hợp lệ')
    expect(() =>
      run(
        state,
        { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfA },
        environment,
      ),
    ).toThrow('WOLF_TARGET_REQUIRED')
    expect(() =>
      run(state, { type: 'RESOLVE_WOLF_VOTE' }, environment),
    ).toThrow('WOLF_TARGET_REQUIRED')

    state = run(
      state,
      { type: 'CAST_WOLF_VOTE', playerId: wolfA, targetId: target },
      environment,
    )
    state = run(
      state,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfA },
      environment,
    )
    state = run(state, { type: 'RESOLVE_WOLF_VOTE' }, environment)
    expect(state.night?.actionsByRole.werewolf?.result).toEqual({
      targetId: target,
      random: false,
      reason: 'UNIQUE_TOP',
    })
  })

  it('shares only confirmed current-round teammate ballots with another eligible Wolf', () => {
    const { environment } = testContext()
    let state = createDemoRoom(6, 'REVOTE_10S', environment)
    state = run(state, { type: 'START_NIGHT' }, environment)
    state = run(
      state,
      { type: 'CALL_NIGHT_ROLE', roleId: 'werewolf' },
      environment,
    )
    const action = state.night?.actionsByRole.werewolf
    if (!action) throw new Error('Expected Wolf action')
    const [wolfA, wolfB] = action.eligibleActorIds
    const [target] = action.eligibleTargetIds
    state = run(
      state,
      { type: 'CAST_WOLF_VOTE', playerId: wolfA, targetId: target },
      environment,
    )

    let wolfBSnapshot = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: wolfB,
    })
    expect(wolfBSnapshot.audience).toBe('PLAYER')
    if (wolfBSnapshot.audience !== 'PLAYER') return
    expect(wolfBSnapshot.nightAction?.wolfTeammateBallots).toEqual([])

    state = run(
      state,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfA },
      environment,
    )
    wolfBSnapshot = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: wolfB,
    })
    expect(wolfBSnapshot.audience).toBe('PLAYER')
    if (wolfBSnapshot.audience !== 'PLAYER') return
    expect(wolfBSnapshot.nightAction?.wolfTeammateBallots).toEqual([
      {
        voter: state.players.find((player) => player.id === wolfA),
        targetId: target,
      },
    ])

    const ordinaryId = state.players.find(
      (player) => !action.eligibleActorIds.includes(player.id),
    )?.id
    if (!ordinaryId) throw new Error('Expected ordinary Player')
    const ordinary = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: ordinaryId,
    })
    expect(ordinary.audience).toBe('PLAYER')
    if (ordinary.audience === 'PLAYER') {
      expect(ordinary.nightAction).toBeUndefined()
      expect(JSON.stringify(ordinary)).not.toContain('wolfTeammateBallots')
    }
  })
})
