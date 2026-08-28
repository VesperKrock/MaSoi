import { describe, expect, it } from 'vitest'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createDemoRoom,
  type GameEnvironment,
} from './room-engine'
import type { RoomCommand, RoomState } from './types'

function environment(): GameEnvironment {
  let id = 0
  return {
    now: () => 50_000,
    nextId: () => `hf3-${++id}`,
    random: fixedRandom(0),
  }
}

function dayRoom(
  env: GameEnvironment,
  roles: RoomState['roleAssignments'][number]['roleId'][],
): RoomState {
  const state = createDemoRoom(roles.length, 'RANDOM_ON_TIE', env)
  state.phase = 'DAY'
  state.dayNumber = 1
  state.night = null
  state.dayVote = null
  state.dayVerdict = null
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: roles[index],
  }))
  return state
}

function run(state: RoomState, command: RoomCommand, env: GameEnvironment) {
  return applyRoomCommand(state, command, env)
}

describe('MS-HF3 shared Moderator Day verdict entrypoint', () => {
  it('resolves no-candidate and spare without creating a hanging', () => {
    const env = environment()
    const roles = [
      'werewolf', 'seer', 'protector', 'witch', 'villager', 'villager', 'villager',
    ] as const
    const noCandidate = run(
      dayRoom(env, [...roles]),
      {
        type: 'RESOLVE_MODERATOR_DAY_VERDICT',
        candidatePlayerId: null,
        execute: false,
      },
      env,
    )
    expect(noCandidate.dayVerdict).toMatchObject({
      status: 'RESOLVED',
      outcome: 'NO_CANDIDATE',
    })
    expect(noCandidate.players.every((player) => player.alive)).toBe(true)
    expect(noCandidate.journal.some((event) => event.type === 'DAY_HANGING_CREATED')).toBe(false)

    const spared = run(
      dayRoom(env, [...roles]),
      {
        type: 'RESOLVE_MODERATOR_DAY_VERDICT',
        candidatePlayerId: 'player-5',
        execute: false,
      },
      env,
    )
    expect(spared.dayVerdict).toMatchObject({
      outcome: 'SPARED',
      candidatePlayerId: 'player-5',
    })
    expect(spared.players[4].alive).toBe(true)
    expect(spared.dayVote).toBeNull()
  })

  it('routes execution through shared hanging, Lovers and Hunter consequences', () => {
    const env = environment()
    let lovers = dayRoom(env, [
      'werewolf', 'cupid', 'seer', 'villager', 'villager', 'villager', 'villager',
    ])
    lovers.cupidLovers = {
      couple: {
        id: 'couple-1',
        cupidPlayerId: 'player-2',
        loverPlayerIds: ['player-4', 'player-5'],
        pairedNightNumber: 1,
        pairedAt: 1,
      },
      loverRevealAcknowledgedPlayerIds: ['player-4', 'player-5'],
      objective: {
        cupidPlayerId: 'player-2',
        status: 'ACTIVE',
        changedAt: 1,
      },
    }
    lovers = run(
      lovers,
      {
        type: 'RESOLVE_MODERATOR_DAY_VERDICT',
        candidatePlayerId: 'player-4',
        execute: true,
      },
      env,
    )
    expect(lovers.players.filter((player) => !player.alive).map((player) => player.id)).toEqual([
      'player-4',
      'player-5',
    ])
    expect(lovers.dayVerdict?.hangingEffect?.sourceType).toBe('DAY_HANGING')
    expect(lovers.dayVerdict?.consequenceEffects).toContainEqual(
      expect.objectContaining({ sourceType: 'LOVER_HEARTBREAK' }),
    )

    let hunter = dayRoom(env, [
      'werewolf', 'hunter', 'seer', 'protector', 'villager', 'villager', 'villager',
    ])
    hunter = run(
      hunter,
      {
        type: 'RESOLVE_MODERATOR_DAY_VERDICT',
        candidatePlayerId: 'player-2',
        execute: true,
      },
      env,
    )
    expect(hunter.dayVerdict?.hunterRevenge?.status).toBe('PENDING')
    expect(() => run(hunter, { type: 'START_NEXT_NIGHT' }, env)).toThrow(/Thợ Săn/i)
    hunter = run(
      hunter,
      {
        type: 'SUBMIT_HUNTER_REVENGE',
        playerId: 'player-2',
        targetId: 'player-4',
      },
      env,
    )
    expect(hunter.dayVerdict?.hunterRevenge).toMatchObject({
      status: 'RESOLVED',
      targetPlayerId: 'player-4',
    })
    expect(hunter.players[3].alive).toBe(false)
  })

  it('preserves immediate Fool victory and makes a resolved verdict irreversible', () => {
    const env = environment()
    let state = dayRoom(env, [
      'werewolf', 'fool', 'seer', 'protector', 'villager', 'villager', 'villager',
    ])
    state = run(
      state,
      {
        type: 'RESOLVE_MODERATOR_DAY_VERDICT',
        candidatePlayerId: 'player-2',
        execute: true,
      },
      env,
    )
    expect(state.lifecycle).toBe('FINISHED')
    expect(state.matchResult).toMatchObject({
      outcome: 'FOOL',
      subjectPlayerIds: ['player-2'],
    })
    const deathCount = state.journal.filter((event) => event.type === 'PLAYER_DEATH').length
    expect(() => run(state, {
      type: 'RESOLVE_MODERATOR_DAY_VERDICT',
      candidatePlayerId: 'player-3',
      execute: true,
    }, env)).toThrow(/MATCH_FINISHED/)
    expect(state.journal.filter((event) => event.type === 'PLAYER_DEATH')).toHaveLength(deathCount)
  })
})
