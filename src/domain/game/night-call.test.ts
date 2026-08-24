import { describe, expect, it } from 'vitest'
import { projectRoomSnapshot } from '../../state/room-projection'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { PlayerId, RoomState } from './types'

function deterministicEnvironment() {
  let now = 1_000
  let id = 0
  const environment: GameEnvironment = {
    now: () => now,
    nextId: () => `event-${++id}`,
    random: fixedRandom(0),
  }
  return {
    environment,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

function command(
  state: RoomState,
  environment: GameEnvironment,
  nextCommand: Parameters<typeof applyRoomCommand>[1],
) {
  return applyRoomCommand(state, nextCommand, environment)
}

function completeWolfCall(state: RoomState, environment: GameEnvironment) {
  let next = command(state, environment, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'werewolf',
  })
  const action = next.night?.actionsByRole.werewolf
  if (!action) throw new Error('Expected a living wolf action')

  for (const actorId of action.eligibleActorIds) {
    next = command(next, environment, {
      type: 'CAST_WOLF_VOTE',
      playerId: actorId,
      targetId: null,
    })
    next = command(next, environment, {
      type: 'CONFIRM_NIGHT_ACTION',
      playerId: actorId,
    })
  }
  return command(next, environment, { type: 'RESOLVE_WOLF_VOTE' })
}

function completeLivingSeerCall(
  state: RoomState,
  environment: GameEnvironment,
  seerId: PlayerId,
) {
  let next = command(state, environment, {
    type: 'CALL_NIGHT_ROLE',
    roleId: 'seer',
  })
  const targetId = next.players.find((player) => player.id !== seerId)?.id
  if (!targetId) throw new Error('Expected a Seer target')
  next = command(next, environment, {
    type: 'SUBMIT_TARGET_ACTION',
    playerId: seerId,
    targetId,
  })
  return next
}

describe('dead-role nightly call secrecy', () => {
  it('keeps dead Seer in the next-night ritual without activating any player', () => {
    const { environment, advance } = deterministicEnvironment()
    let state = createDemoRoom(6, 'RANDOM_ON_TIE', environment)
    const seerId = state.roleAssignments.find(
      (assignment) => assignment.roleId === 'seer',
    )?.playerId
    if (!seerId) throw new Error('Expected demo Seer')

    state = command(state, environment, { type: 'START_NIGHT' })
    state = completeWolfCall(state, environment)
    state = completeLivingSeerCall(state, environment, seerId)
    state = command(state, environment, { type: 'START_DAY' })
    state = command(state, environment, {
      type: 'MODERATOR_SET_ALIVE',
      playerId: seerId,
      alive: false,
      reason: 'Treo cổ ngày 1',
    })

    advance(60_000)
    state = command(state, environment, { type: 'START_NIGHT' })
    expect(state.dayNumber).toBe(2)
    expect(state.night?.calls.map(({ roleId, status }) => ({ roleId, status }))).toEqual([
      { roleId: 'werewolf', status: 'NOT_CALLED' },
      { roleId: 'seer', status: 'NOT_CALLED' },
    ])

    state = completeWolfCall(state, environment)
    state = command(state, environment, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'seer',
    })

    expect(state.night?.calls.find((call) => call.roleId === 'seer')?.status).toBe(
      'CALLED',
    )
    expect(state.night?.actionsByRole.seer).toBeUndefined()
    for (const player of state.players) {
      const snapshot = projectRoomSnapshot(state, {
        kind: 'PLAYER',
        playerId: player.id,
      })
      expect(snapshot.audience).toBe('PLAYER')
      if (snapshot.audience === 'PLAYER') {
        expect(snapshot.nightAction).toBeUndefined()
      }
    }

    state = command(state, environment, {
      type: 'COMPLETE_NIGHT_CALL',
      roleId: 'seer',
    })
    expect(state.night?.calls.find((call) => call.roleId === 'seer')?.status).toBe(
      'COMPLETED',
    )
    state = command(state, environment, { type: 'START_DAY' })
    expect(state.phase).toBe('DAY')
    expect(
      state.journal.some(
        (event) =>
          event.type === 'ROLE_CALLED' &&
          event.actorRoleId === 'seer' &&
          event.dayNumber === 2,
      ),
    ).toBe(true)
  })

  it('does not expose room assignments or Moderator journal in a player snapshot', () => {
    const { environment } = deterministicEnvironment()
    const state = createDemoRoom(6, 'RANDOM_ON_TIE', environment)
    const snapshot = projectRoomSnapshot(state, {
      kind: 'PLAYER',
      playerId: 'player-1',
    })

    expect(snapshot.audience).toBe('PLAYER')
    expect('roleAssignments' in snapshot).toBe(false)
    expect('journal' in snapshot).toBe(false)
  })
})
