import { describe, expect, it } from 'vitest'
import type { RoleComposition } from '../game/room-setup'
import type { RoleId } from '../game/types'
import {
  createOfflineSessionState,
  getOfflineNightOneCallPlan,
  getOfflineRoleHolderIds,
  getUnassignedOfflinePlayerIds,
  reduceOfflineSession,
  type OfflineSessionCommand,
  type OfflineSessionState,
} from './offline-session'

function physicalSession(roleIds: readonly RoleId[]): OfflineSessionState {
  const roleComposition = roleIds.reduce<RoleComposition>((result, roleId) => {
    result[roleId] = (result[roleId] ?? 0) + 1
    return result
  }, {})
  return {
    ...createOfflineSessionState(1),
    phase: 'PHYSICAL_DEAL',
    seatCount: roleIds.length,
    playerNames: roleIds.map((_, index) => `Người ${index + 1}`),
    roleComposition,
    nightRitual: {
      callPlan: getOfflineNightOneCallPlan(roleComposition),
      callIndex: 0,
      activeStep: null,
      draftHolderIdsByRole: {},
    },
  }
}

function runner(initial: OfflineSessionState) {
  let state = initial
  let now = 100
  return {
    get state() {
      return state
    },
    dispatch(command: OfflineSessionCommand) {
      state = reduceOfflineSession(state, command, now)
      now += 1
      return state
    },
  }
}

function discover(
  game: ReturnType<typeof runner>,
  roleId: RoleId,
  playerIds: readonly string[],
) {
  game.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
  expect(game.state.nightRitual.activeStep).toMatchObject({
    kind: 'HOLDER_DISCOVERY',
  })
  for (const playerId of playerIds) {
    game.dispatch({ type: 'TOGGLE_HOLDER', roleId, playerId })
  }
  game.dispatch({ type: 'CONFIRM_HOLDERS' })
}

function confirmTarget(
  game: ReturnType<typeof runner>,
  targetId: string | null,
) {
  game.dispatch({ type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT', targetId })
  game.dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })
}

function sleepAndContinue(game: ReturnType<typeof runner>) {
  expect(game.state.nightRitual.activeStep?.kind).toBe('CALL_COMPLETE')
  game.dispatch({ type: 'ADVANCE_FROM_COMPLETED_RITUAL' })
}

describe('MS-HF4 dependency-preserving ritual pipeline', () => {
  it('runs Cupid, Wolves, Seer, Protector and Witch as sequential discover/action calls', () => {
    const game = runner(physicalSession([
      'werewolf',
      'werewolf',
      'cupid',
      'seer',
      'protector',
      'witch',
      'villager',
      'villager',
    ]))
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })

    discover(game, 'cupid', ['offline-player-3'])
    expect(game.state.authority?.night?.activeRoleId).toBe('cupid')
    game.dispatch({ type: 'TOGGLE_OFFLINE_CUPID_TARGET', playerId: 'offline-player-7' })
    game.dispatch({ type: 'TOGGLE_OFFLINE_CUPID_TARGET', playerId: 'offline-player-8' })
    game.dispatch({ type: 'CONFIRM_OFFLINE_CUPID_PAIR' })
    expect(game.state.authority?.cupidLovers?.couple?.loverPlayerIds).toEqual([
      'offline-player-7',
      'offline-player-8',
    ])
    game.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_LOVERS' })
    sleepAndContinue(game)

    discover(game, 'werewolf', ['offline-player-1', 'offline-player-2'])
    confirmTarget(game, 'offline-player-7')
    sleepAndContinue(game)

    discover(game, 'seer', ['offline-player-4'])
    expect(getUnassignedOfflinePlayerIds(game.state)).toContain('offline-player-8')
    confirmTarget(game, 'offline-player-8')
    expect(game.state.authority?.night?.actionsByRole.seer?.seer?.result)
      .toBe('NON_WOLF')
    game.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' })
    sleepAndContinue(game)

    discover(game, 'protector', ['offline-player-5'])
    confirmTarget(game, 'offline-player-8')
    sleepAndContinue(game)

    discover(game, 'witch', ['offline-player-6'])
    expect(game.state.authority?.nightResolution?.provisionalDeathCandidateIds)
      .toEqual(['offline-player-7'])
    expect(game.state.authority?.night?.actionsByRole.witch?.kind)
      .toBe('WITCH_DECISION')
    expect(getOfflineRoleHolderIds(game.state, 'villager')).toHaveLength(2)
    game.dispatch({ type: 'CONFIRM_OFFLINE_WITCH_DECISION' })
    sleepAndContinue(game)
    expect(game.state.authority?.night?.calls.every(
      (call) => call.status === 'COMPLETED',
    )).toBe(true)
  })

  it('persists a passive role as a real call and never rediscovers it on Night 2', () => {
    const game = runner(physicalSession([
      'werewolf',
      'werewolf',
      'mayor',
      'villager',
      'villager',
      'villager',
      'villager',
    ]))
    game.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    discover(game, 'werewolf', ['offline-player-1', 'offline-player-2'])
    confirmTarget(game, 'offline-player-4')
    sleepAndContinue(game)

    discover(game, 'mayor', ['offline-player-3'])
    expect(game.state.authority?.night?.actionsByRole.mayor).toBeUndefined()
    expect(game.state.authority?.night?.activeRoleId).toBe('mayor')
    game.dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })
    expect(game.state.nightRitual.activeStep).toBeNull()
    expect(getOfflineRoleHolderIds(game.state, 'villager')).toHaveLength(4)

    game.dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })
    game.dispatch({ type: 'START_OFFLINE_DAY' })
    game.dispatch({ type: 'SET_OFFLINE_DAY_NO_CANDIDATE_DRAFT' })
    game.dispatch({ type: 'CONFIRM_OFFLINE_NO_CANDIDATE' })
    game.dispatch({ type: 'START_OFFLINE_NEXT_NIGHT' })
    game.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    expect(game.state.nightRitual.activeStep?.kind).toBe('ROLE_ACTION')
    expect(game.state.authority?.night?.activeRoleId).toBe('werewolf')
    expect(game.state.offlineEvents.filter(
      (event) => event.type === 'ROLE_IDENTITY_DISCOVERED',
    )).toHaveLength(2)
  })
})
