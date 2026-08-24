import { describe, expect, it } from 'vitest'
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
      { type: 'CAST_WOLF_VOTE', playerId: wolfB, targetId: null },
      environment,
    )
    state = run(
      state,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfA },
      environment,
    )
    state = run(
      state,
      { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfB },
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
    ).toHaveLength(3)
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

  it('waits for the deadline, then randomizes all-abstain from initial ties', () => {
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
    ).toThrow('Chỉ có thể chốt sớm')

    advance(10_000)
    state = run(
      state,
      { type: 'RESOLVE_WOLF_VOTE', atDeadline: true },
      environment,
    )
    expect(state.night?.actionsByRole.werewolf?.result).toEqual({
      targetId: targetA,
      random: true,
      reason: 'REVOTE_ALL_ABSTAIN_RANDOM',
    })
    const randomEvent = state.journal.find(
      (event) => event.type === 'WOLF_RANDOM_RESOLUTION',
    )
    expect(randomEvent?.metadata?.candidateIds).toEqual([targetA, targetB])
  })
})
