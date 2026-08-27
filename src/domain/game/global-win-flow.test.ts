import { describe, expect, it } from 'vitest'
import { applyRoomCommand, createDemoRoom, type GameEnvironment } from './room-engine'
import type { RoomState } from './types'

function environment(now = 31_000): GameEnvironment {
  let id = 0
  return {
    now: () => now,
    nextId: () => `g2-${++id}`,
    random: { pick: <T>(values: readonly T[]) => values[0] },
  }
}

function dayState(roles: RoomState['roleAssignments']): RoomState {
  const env = environment()
  const state = createDemoRoom(Math.max(3, roles.length), 'RANDOM_ON_TIE', env)
  state.phase = 'DAY'
  state.lifecycle = 'IN_GAME'
  state.roleAssignments = roles
  state.players = roles.map((assignment, index) => ({
    id: assignment.playerId,
    seat: index + 1,
    alias: assignment.playerId,
    alive: true,
  }))
  state.factionTransitions = { halfWolves: {}, traitors: {} }
  state.cupidLovers = { couple: null, loverRevealAcknowledgedPlayerIds: [], objective: null }
  state.dayVote = {
    status: 'OPEN',
    votes: {},
    openedAt: 0,
    deadlineAt: 30_000,
  }
  state.matchResult = null
  return state
}

describe('global winner lifecycle checkpoints', () => {
  it('finishes immediately as Fool on authoritative hanging and freezes gameplay', () => {
    const env = environment()
    const state = dayState([
      { playerId: 'fool', roleId: 'fool' },
      { playerId: 'wolf', roleId: 'werewolf' },
      { playerId: 'villager', roleId: 'villager' },
    ])
    state.dayVote!.votes = { wolf: 'fool' }

    const finished = applyRoomCommand(state, { type: 'CLOSE_DAY_VOTE' }, env)
    expect(finished.matchResult).toMatchObject({
      outcome: 'FOOL',
      trigger: 'FOOL_DAY_HANGING',
      subjectPlayerIds: ['fool'],
    })
    expect(finished.lifecycle).toBe('FINISHED')
    expect(finished.phase).toBe('ENDED')
    expect(finished.journal.filter((event) => event.type === 'MATCH_ENDED')).toHaveLength(1)
    expect(() =>
      applyRoomCommand(finished, { type: 'OPEN_DAY_VOTE' }, env),
    ).toThrow('MATCH_FINISHED')
    expect(() =>
      applyRoomCommand(finished, { type: 'START_NEXT_NIGHT' }, env),
    ).toThrow('MATCH_FINISHED')
  })

  it('does not grant Fool victory merely for receiving votes in a tie', () => {
    const env = environment()
    const state = dayState([
      { playerId: 'fool', roleId: 'fool' },
      { playerId: 'wolf', roleId: 'werewolf' },
      { playerId: 'villager', roleId: 'villager' },
    ])
    state.dayVote!.votes = { fool: 'villager', villager: 'fool' }
    const result = applyRoomCommand(state, { type: 'CLOSE_DAY_VOTE' }, env)
    expect(result.dayVote?.result?.kind).toBe('TIE')
    expect(result.matchResult).toBeNull()
  })

  it('transforms pending Half-Wolf and resolves Wolf before the first next-Night call', () => {
    const env = environment()
    const state = dayState([
      { playerId: 'half', roleId: 'half-wolf' },
      { playerId: 'traitor', roleId: 'traitor' },
    ])
    state.dayVote = {
      status: 'CLOSED',
      votes: {},
      openedAt: 0,
      deadlineAt: 30_000,
      closedAt: 30_000,
      result: { kind: 'NO_VOTES', targetIds: [], counts: {} },
    }
    state.factionTransitions = {
      halfWolves: {
        half: {
          playerId: 'half',
          status: 'PENDING_TRANSFORMATION',
          bittenNightNumber: 1,
          transformDueNightNumber: 2,
        },
      },
      traitors: {
        traitor: {
          playerId: 'traitor',
          status: 'CONVERTED_VILLAGE',
          conversionReason: 'NO_LIVING_BITE_CAPABLE_WOLF',
        },
      },
    }

    const finished = applyRoomCommand(
      state,
      { type: 'START_NEXT_NIGHT' },
      env,
    )
    expect(finished.dayNumber).toBe(2)
    expect(finished.factionTransitions?.halfWolves.half.status).toBe('TRANSFORMED')
    expect(finished.factionTransitions?.traitors.traitor.status).toBe('CONVERTED_VILLAGE')
    expect(finished.matchResult?.outcome).toBe('WOLF')
    expect(finished.matchResult?.trigger).toBe('START_NIGHT')
    expect(finished.night).toBeNull()
    expect(finished.journal.some((event) => event.type === 'ROLE_CALLED')).toBe(false)
  })

  it('produces one immutable logical result from repeated pure-state evaluation paths', () => {
    const env = environment()
    const state = dayState([
      { playerId: 'wolf', roleId: 'werewolf' },
      { playerId: 'villager', roleId: 'villager' },
    ])
    state.dayVote!.votes = { villager: 'villager' }
    // Self-vote is ignored by authoritative target validation in real flow;
    // resolve a deterministic no-vote stable state instead.
    state.dayVote!.votes = {}
    const first = applyRoomCommand(state, { type: 'CLOSE_DAY_VOTE' }, env)
    const concurrent = applyRoomCommand(state, { type: 'CLOSE_DAY_VOTE' }, env)
    expect(first.matchResult).toEqual(concurrent.matchResult)
    expect(first.journal.filter((event) => event.type === 'MATCH_ENDED')).toHaveLength(1)
  })
})
