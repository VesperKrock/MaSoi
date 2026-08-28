import { describe, expect, it } from 'vitest'
import type { RoleComposition } from '../game/room-setup'
import type { RoleId } from '../game/types'
import { isHalfWolfTransformed } from '../gameplay/faction-transitions'
import {
  getOfflineNightOneCallPlan,
  reduceOfflineSession,
  createOfflineSessionState,
  type OfflineSessionCommand,
  type OfflineSessionState,
} from './offline-session'
import {
  loadOfflineSession,
  saveOfflineSession,
  type OfflineStorage,
} from './offline-storage'

function readySession(
  roleIds: readonly RoleId[],
): OfflineSessionState {
  const composition = roleIds.reduce<RoleComposition>((result, roleId) => {
    result[roleId] = (result[roleId] ?? 0) + 1
    return result
  }, {})
  const base = createOfflineSessionState(1)
  return {
    ...base,
    phase: 'NIGHT_1_READY',
    seatCount: roleIds.length,
    playerNames: roleIds.map((_, index) => `Người ${index + 1}`),
    roleComposition: composition,
    roleAssignments: roleIds.map((roleId, index) => ({
      playerId: `offline-player-${index + 1}`,
      roleId,
    })),
    nightOne: {
      callPlan: getOfflineNightOneCallPlan(composition),
      callIndex: getOfflineNightOneCallPlan(composition).length,
      activeStep: null,
      draftHolderIds: [],
    },
  }
}

function runner(initial: OfflineSessionState) {
  let state = initial
  let now = 1_000
  return {
    get state() {
      return state
    },
    setNow(next: number) {
      now = next
    },
    dispatch(command: OfflineSessionCommand) {
      state = reduceOfflineSession(state, command, now)
      now += 1
      return state
    },
  }
}

function callNext(testRunner: ReturnType<typeof runner>) {
  testRunner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
  return testRunner.state.authority?.night?.activeRoleId
}

function recordAllAbstentions(testRunner: ReturnType<typeof runner>) {
  const room = testRunner.state.authority
  if (!room) throw new Error('Expected authority room')
  for (const player of room.players.filter((entry) => entry.alive)) {
    testRunner.dispatch({
      type: 'CAST_OFFLINE_DAY_VOTE',
      voterId: player.id,
      targetId: null,
    })
  }
}

function expectStorageRoundTrip(state: OfflineSessionState) {
  class MemoryStorage implements OfflineStorage {
    value: string | null = null
    getItem() {
      return this.value
    }
    setItem(_key: string, value: string) {
      this.value = value
    }
  }
  const storage = new MemoryStorage()
  expect(saveOfflineSession(storage, state)).toBe(true)
  expect(loadOfflineSession(storage)).toEqual(state)
}

describe('MS-O2 Offline shared-engine authority adapter', () => {
  it('runs a mandatory one-target Wolf night, all-abstain Day and Night 2 without rediscovery', () => {
    const game = runner(
      readySession([
        'werewolf',
        'werewolf',
        'seer',
        'villager',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(game.state.authority?.phase).toBe('NIGHT')
    expect(callNext(game)).toBe('werewolf')

    const revision = game.state.authority?.revision
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    expect(game.state.blockingError).toContain('bắt buộc')
    expect(game.state.authority?.revision).toBe(revision)

    game.dispatch({ type: 'CLEAR_ERROR' })
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-3',
    })
    expect(game.state.authority?.night?.actionsByRole.werewolf?.result).toMatchObject({
      targetId: 'offline-player-3',
      random: false,
    })
    expect(callNext(game)).toBe('seer')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-1',
    })
    expect(
      game.state.authority?.night?.actionsByRole.seer?.seer?.result,
    ).toBe('WOLF')
    game.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    expect(
      game.state.authority?.players.find(
        (player) => player.id === 'offline-player-3',
      )?.alive,
    ).toBe(false)

    game.dispatch({ type: 'START_OFFLINE_DAY' })
    game.dispatch({ type: 'OPEN_OFFLINE_DAY_VOTE' })
    recordAllAbstentions(game)
    const deadline = game.state.authority?.dayVote?.deadlineAt
    if (!deadline) throw new Error('Expected Day deadline')
    game.setNow(deadline)
    game.dispatch({ type: 'CLOSE_OFFLINE_DAY_VOTE' })
    expect(game.state.authority?.dayVote?.result?.kind).toBe('NO_VOTES')
    game.dispatch({ type: 'START_OFFLINE_NEXT_NIGHT' })

    expect(game.state.phase).toBe('MATCH')
    expect(game.state.authority?.dayNumber).toBe(2)
    expect(
      game.state.authority?.night?.calls.map((call) => call.roleId),
    ).toEqual(['werewolf', 'seer'])
    expect(
      game.state.authority?.night?.calls.every(
        (call) => call.status === 'NOT_CALLED',
      ),
    ).toBe(true)
    expect(game.state.nightOne.activeStep).toBeNull()

    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-4',
    })
    expect(callNext(game)).toBe('seer')
    expect(game.state.authority?.night?.actionsByRole.seer).toBeUndefined()
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(
      game.state.authority?.night?.calls.find(
        (call) => call.roleId === 'seer',
      )?.status,
    ).toBe('COMPLETED')
  })

  it('uses the shared Witch checkpoint and durably consumes only the chosen potion', () => {
    const game = runner(
      readySession([
        'werewolf',
        'seer',
        'protector',
        'witch',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-5',
    })
    expect(callNext(game)).toBe('seer')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-1',
    })
    game.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' })
    expect(callNext(game)).toBe('protector')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-6',
    })
    expect(callNext(game)).toBe('witch')

    const witchAction = game.state.authority?.night?.actionsByRole.witch
    expect(witchAction?.witch?.resurrectionCandidateIds).toEqual([
      'offline-player-5',
    ])
    expect(witchAction?.witch?.poisonAvailable).toBe(false)
    game.dispatch({
      type: 'SET_OFFLINE_WITCH_RESURRECTION_TARGET',
      playerId: 'offline-player-5',
    })

    expectStorageRoundTrip(game.state)

    game.dispatch({ type: 'CONFIRM_OFFLINE_WITCH_DECISION' })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    expect(
      game.state.authority?.players.find(
        (player) => player.id === 'offline-player-5',
      )?.alive,
    ).toBe(true)
    expect(game.state.authority?.witchResources).toMatchObject({
      resurrectionAvailable: false,
      poisonAvailable: true,
    })
    expectStorageRoundTrip(game.state)
  })

  it('stabilizes Cupid heartbreak and Hunter pre-lock through the shared death fixpoint', () => {
    const game = runner(
      readySession([
        'werewolf',
        'cupid',
        'hunter',
        'serial-killer',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(callNext(game)).toBe('cupid')
    game.dispatch({
      type: 'TOGGLE_OFFLINE_CUPID_TARGET',
      playerId: 'offline-player-3',
    })
    game.dispatch({
      type: 'TOGGLE_OFFLINE_CUPID_TARGET',
      playerId: 'offline-player-5',
    })
    game.dispatch({ type: 'CONFIRM_OFFLINE_CUPID_PAIR' })
    game.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_LOVERS' })

    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-3',
    })
    expect(callNext(game)).toBe('serial-killer')
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    expect(callNext(game)).toBe('hunter')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-6',
    })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })

    const deadIds = game.state.authority?.players
      .filter((player) => !player.alive)
      .map((player) => player.id)
    expect(deadIds).toEqual(
      expect.arrayContaining([
        'offline-player-3',
        'offline-player-5',
        'offline-player-6',
      ]),
    )
    expect(game.state.authority?.witchCheckpoint?.finalDeaths).toHaveLength(3)
  })

  it('applies Mayor ×2, forbids self-vote and finishes immediately when Fool is hanged', () => {
    const game = runner(
      readySession([
        'werewolf',
        'mayor',
        'fool',
        'serial-killer',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-4',
    })
    expect(callNext(game)).toBe('serial-killer')
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    expect(callNext(game)).toBe('mayor')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(callNext(game)).toBe('fool')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    game.dispatch({ type: 'START_OFFLINE_DAY' })
    game.dispatch({ type: 'OPEN_OFFLINE_DAY_VOTE' })

    const revision = game.state.authority?.revision
    game.dispatch({
      type: 'CAST_OFFLINE_DAY_VOTE',
      voterId: 'offline-player-2',
      targetId: 'offline-player-2',
    })
    expect(game.state.blockingError).toContain('không hợp lệ')
    expect(game.state.authority?.revision).toBe(revision)
    game.dispatch({ type: 'CLEAR_ERROR' })

    const votes: Array<[string, string | null]> = [
      ['offline-player-1', 'offline-player-3'],
      ['offline-player-2', 'offline-player-3'],
      ['offline-player-3', null],
      ['offline-player-4', null],
      ['offline-player-5', null],
      ['offline-player-6', null],
      ['offline-player-7', null],
    ]
    for (const [voterId, targetId] of votes) {
      game.dispatch({ type: 'CAST_OFFLINE_DAY_VOTE', voterId, targetId })
    }
    const deadline = game.state.authority?.dayVote?.deadlineAt
    if (!deadline) throw new Error('Expected Day deadline')
    game.setNow(deadline)
    game.dispatch({ type: 'CLOSE_OFFLINE_DAY_VOTE' })

    expect(game.state.phase).toBe('FINISHED')
    expect(game.state.authority?.lifecycle).toBe('FINISHED')
    expect(game.state.authority?.matchResult).toMatchObject({
      outcome: 'FOOL',
      subjectPlayerIds: ['offline-player-3'],
    })
    expect(game.state.authority?.dayVote?.result?.counts['offline-player-3']).toBe(3)
  })

  it('transforms Half-Wolf and reconciles Traitor before the first Night-2 role call', () => {
    const game = runner(
      readySession([
        'werewolf',
        'traitor',
        'half-wolf',
        'serial-killer',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(callNext(game)).toBe('traitor')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-3',
    })
    expect(callNext(game)).toBe('half-wolf')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(callNext(game)).toBe('serial-killer')
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    expect(
      game.state.authority?.factionTransitions?.halfWolves['offline-player-3']
        ?.status,
    ).toBe('PENDING_TRANSFORMATION')

    game.dispatch({ type: 'START_OFFLINE_DAY' })
    game.dispatch({ type: 'OPEN_OFFLINE_DAY_VOTE' })
    recordAllAbstentions(game)
    const deadline = game.state.authority?.dayVote?.deadlineAt
    if (!deadline) throw new Error('Expected Day deadline')
    game.setNow(deadline)
    game.dispatch({ type: 'CLOSE_OFFLINE_DAY_VOTE' })
    game.dispatch({ type: 'START_OFFLINE_NEXT_NIGHT' })

    const room = game.state.authority
    if (!room) throw new Error('Expected authority room')
    expect(isHalfWolfTransformed(room.factionTransitions, 'offline-player-3')).toBe(true)
    expect(room.night?.calls.map((call) => call.roleId)).toEqual([
      'traitor',
      'werewolf',
      'half-wolf',
      'serial-killer',
    ])
    expect(callNext(game)).toBe('traitor')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(callNext(game)).toBe('werewolf')
    expect(
      game.state.authority?.night?.actionsByRole.werewolf?.eligibleActorIds,
    ).toEqual(
      expect.arrayContaining([
        'offline-player-1',
        'offline-player-2',
        'offline-player-3',
      ]),
    )
  })

  it('restores a pending and resolved Hunter Day-revenge chain without replay', () => {
    const game = runner(
      readySession([
        'werewolf',
        'hunter',
        'serial-killer',
        'villager',
        'villager',
        'villager',
        'villager',
      ]),
    )
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    expect(callNext(game)).toBe('werewolf')
    game.dispatch({
      type: 'SUBMIT_OFFLINE_NIGHT_TARGET',
      targetId: 'offline-player-3',
    })
    expect(callNext(game)).toBe('serial-killer')
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    expect(callNext(game)).toBe('hunter')
    game.dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    game.dispatch({ type: 'START_OFFLINE_DAY' })
    game.dispatch({ type: 'OPEN_OFFLINE_DAY_VOTE' })

    const room = game.state.authority
    if (!room) throw new Error('Expected authority room')
    for (const player of room.players) {
      game.dispatch({
        type: 'CAST_OFFLINE_DAY_VOTE',
        voterId: player.id,
        targetId: player.id === 'offline-player-2' ? null : 'offline-player-2',
      })
    }
    const deadline = game.state.authority?.dayVote?.deadlineAt
    if (!deadline) throw new Error('Expected Day deadline')
    game.setNow(deadline)
    game.dispatch({ type: 'CLOSE_OFFLINE_DAY_VOTE' })
    expect(game.state.authority?.dayVote?.hunterRevenge?.status).toBe('PENDING')
    expectStorageRoundTrip(game.state)

    game.dispatch({
      type: 'SUBMIT_OFFLINE_HUNTER_REVENGE',
      targetId: 'offline-player-4',
    })
    expect(game.state.authority?.dayVote?.hunterRevenge).toMatchObject({
      status: 'RESOLVED',
      targetPlayerId: 'offline-player-4',
    })
    expectStorageRoundTrip(game.state)
  })
})
