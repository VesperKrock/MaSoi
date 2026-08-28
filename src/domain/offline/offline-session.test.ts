import { describe, expect, it } from 'vitest'
import type { RoleComposition } from '../game/room-setup'
import { classicRoleCatalog } from '../roles/classic-catalog'
import {
  createOfflineSessionState,
  getOfflineEligibleActionTargetIds,
  getOfflineNightOneCallPlan,
  getOfflineRoleHolderIds,
  getUnassignedOfflinePlayerIds,
  reduceOfflineSession,
  validateOfflineSetup,
  type OfflineSessionCommand,
  type OfflineSessionState,
} from './offline-session'

function commandRunner(initial = createOfflineSessionState(1)) {
  let state = initial
  let now = 2
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

function fillNames(
  runner: ReturnType<typeof commandRunner>,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    runner.dispatch({
      type: 'SET_PLAYER_NAME',
      index,
      name: `  Người   ${index + 1}  `,
    })
  }
}

function setComposition(
  runner: ReturnType<typeof commandRunner>,
  composition: RoleComposition,
) {
  for (const role of classicRoleCatalog) {
    runner.dispatch({
      type: 'SET_ROLE_QUANTITY',
      roleId: role.id,
      quantity: composition[role.id] ?? 0,
    })
  }
}

describe('MS-O1 offline setup', () => {
  it('accepts complete ordered names and an exact deck at 7 and 16 players', () => {
    const seven = commandRunner()
    fillNames(seven, 7)
    expect(validateOfflineSetup(seven.state)).toMatchObject({ valid: true })

    const sixteen = commandRunner()
    sixteen.dispatch({ type: 'SET_SEAT_COUNT', seatCount: 16 })
    fillNames(sixteen, 16)
    expect(validateOfflineSetup(sixteen.state)).toMatchObject({ valid: true })
  })

  it('reuses normalized name validation for blanks, length and duplicates', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'SET_PLAYER_NAME', index: 1, name: ' người 1 ' })
    expect(validateOfflineSetup(runner.state).nameErrors[1]).toContain(
      'người chơi số 1',
    )

    runner.dispatch({ type: 'SET_PLAYER_NAME', index: 1, name: '   ' })
    expect(validateOfflineSetup(runner.state).nameErrors[1]).toContain(
      'không được để trống',
    )

    runner.dispatch({
      type: 'SET_PLAYER_NAME',
      index: 1,
      name: '123456789012345678901',
    })
    expect(validateOfflineSetup(runner.state).nameErrors[1]).toContain('20')
  })

  it('clamps singleton roles to one and permits multiple Villagers/Werewolves', () => {
    const runner = commandRunner()
    runner.dispatch({ type: 'SET_ROLE_QUANTITY', roleId: 'seer', quantity: 2 })
    runner.dispatch({
      type: 'SET_ROLE_QUANTITY',
      roleId: 'werewolf',
      quantity: 4,
    })
    runner.dispatch({
      type: 'SET_ROLE_QUANTITY',
      roleId: 'villager',
      quantity: 5,
    })
    expect(runner.state.roleComposition.seer).toBe(1)
    expect(runner.state.roleComposition.werewolf).toBe(4)
    expect(runner.state.roleComposition.villager).toBe(5)
  })

  it('enters a physical-deal checkpoint with no automatic assignment', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    expect(runner.state.phase).toBe('PHYSICAL_DEAL')
    expect(runner.state.playerNames[0]).toBe('Người 1')
    expect(runner.state.roleAssignments).toEqual([])
    expect(runner.state.nightOne.callPlan).toEqual(['werewolf', 'seer'])
  })
})

describe('MS-O1 Night-1 role discovery', () => {
  it('calls every configured non-Villager once, including no-action roles', () => {
    const composition = Object.fromEntries(
      classicRoleCatalog.map((role) => [
        role.id,
        role.id === 'villager' ? 5 : 1,
      ]),
    ) as RoleComposition
    const plan = getOfflineNightOneCallPlan(composition)
    expect(plan).toHaveLength(11)
    expect(new Set(plan).size).toBe(11)
    expect(plan).not.toContain('villager')
    for (const role of classicRoleCatalog.filter(
      (entry) => entry.id !== 'villager',
    )) {
      expect(plan).toContain(role.id)
    }
    expect(plan).toEqual(
      expect.arrayContaining(['mayor', 'traitor', 'fool', 'half-wolf']),
    )
  })

  it('requires exactly two Wolf holders and removes them from later holder selectors', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_NIGHT_ONE_DISCOVERY' })
    expect(runner.state.nightOne.activeStep).toMatchObject({
      kind: 'HOLDER_DISCOVERY',
      roleId: 'werewolf',
      requiredHolderCount: 2,
    })

    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-1' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(runner.state.roleAssignments).toEqual([])
    expect(runner.state.blockingError).toContain('đúng 2')

    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-2' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(getOfflineRoleHolderIds(runner.state, 'werewolf')).toEqual([
      'offline-player-1',
      'offline-player-2',
    ])
    expect(runner.state.offlineEvents).toMatchObject([{
      type: 'ROLE_IDENTITY_DISCOVERED',
      roleId: 'werewolf',
      holderPlayerIds: ['offline-player-1', 'offline-player-2'],
    }])
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(runner.state.offlineEvents).toHaveLength(1)
    expect(runner.state.nightOne.activeStep).toMatchObject({
      kind: 'ROLE_ACTION',
      roleId: 'werewolf',
      actionType: 'WOLF_VOTE',
    })
    expect(getOfflineEligibleActionTargetIds(runner.state)).not.toContain(
      'offline-player-1',
    )

    runner.dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })
    expect(getUnassignedOfflinePlayerIds(runner.state)).not.toContain(
      'offline-player-1',
    )
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-1' })
    expect(runner.state.nightOne.draftHolderIds).toEqual([])
  })

  it('keeps assigned holders in action targets whenever shared target rules permit', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_NIGHT_ONE_DISCOVERY' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-1' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-2' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    runner.dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-3' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })

    expect(runner.state.nightOne.activeStep).toMatchObject({
      kind: 'ROLE_ACTION',
      roleId: 'seer',
      actionType: 'SELECT_TARGET',
    })
    expect(getOfflineEligibleActionTargetIds(runner.state)).toContain(
      'offline-player-1',
    )
    expect(getOfflineEligibleActionTargetIds(runner.state)).not.toContain(
      'offline-player-3',
    )
  })

  it('auto-assigns the exact remaining Villager count after singleton discovery', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_NIGHT_ONE_DISCOVERY' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-1' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-2' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    runner.dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-3' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    runner.dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })

    expect(runner.state.phase).toBe('NIGHT_1_READY')
    expect(getOfflineRoleHolderIds(runner.state, 'villager')).toHaveLength(4)
    expect(runner.state.offlineEvents.map((event) => event.roleId)).toEqual([
      'werewolf',
      'seer',
    ])
    expect(runner.state.roleAssignments).toHaveLength(7)
    expect(new Set(runner.state.roleAssignments.map((entry) => entry.playerId)).size).toBe(7)
  })

  it('represents a no-action role as a typed ritual step', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    setComposition(runner, { villager: 6, mayor: 1 })
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_NIGHT_ONE_DISCOVERY' })
    runner.dispatch({ type: 'TOGGLE_HOLDER', playerId: 'offline-player-1' })
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(runner.state.nightOne.activeStep).toEqual({
      kind: 'ROLE_ACTION',
      roleId: 'mayor',
      actionType: 'NONE',
    })
    runner.dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })
    expect(runner.state.phase).toBe('NIGHT_1_READY')
    expect(getOfflineRoleHolderIds(runner.state, 'villager')).toHaveLength(6)
  })

  it('blocks completion when the remaining Villager invariant is broken', () => {
    const state: OfflineSessionState = {
      ...createOfflineSessionState(1),
      phase: 'NIGHT_1_DISCOVERY',
      playerNames: Array.from({ length: 7 }, (_, index) => `Người ${index + 1}`),
      roleComposition: { villager: 5, werewolf: 2 },
      roleAssignments: [
        { playerId: 'offline-player-1', roleId: 'werewolf' },
        { playerId: 'offline-player-2', roleId: 'werewolf' },
      ],
      nightOne: {
        callPlan: ['werewolf'],
        callIndex: 0,
        activeStep: {
          kind: 'ROLE_ACTION',
          roleId: 'werewolf',
          actionType: 'WOLF_VOTE',
        },
        draftHolderIds: [],
      },
      blockingError: null,
    }
    const broken = {
      ...state,
      roleComposition: { villager: 4, werewolf: 2 },
    }
    const next = reduceOfflineSession(
      broken,
      { type: 'ADVANCE_FROM_ROLE_ACTION' },
      2,
    )
    expect(next.phase).toBe('NIGHT_1_DISCOVERY')
    expect(next.blockingError).toContain('cần đúng 4 Dân Làng')
    expect(getOfflineRoleHolderIds(next, 'villager')).toEqual([])
  })
})
