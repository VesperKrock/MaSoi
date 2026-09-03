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
    expect(runner.state.nightRitual.callPlan).toEqual(['werewolf', 'seer'])
  })
})

describe('MS-HF4 interleaved Night-1 rituals', () => {
  function startDefaultNight() {
    const runner = commandRunner()
    fillNames(runner, 7)
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    return runner
  }

  function selectHolder(
    runner: ReturnType<typeof commandRunner>,
    roleId: 'werewolf' | 'traitor' | 'seer',
    playerId: string,
  ) {
    runner.dispatch({ type: 'TOGGLE_HOLDER', roleId, playerId })
  }

  it('groups Traitor with the Wolf call and starts Night 1 before any holder is known', () => {
    const composition = Object.fromEntries(
      classicRoleCatalog.map((role) => [
        role.id,
        role.id === 'villager' ? 1 : 1,
      ]),
    ) as RoleComposition
    const plan = getOfflineNightOneCallPlan(composition)
    expect(plan).not.toContain('traitor')
    expect(plan[0]).toBe('cupid')
    expect(plan.indexOf('werewolf')).toBeLessThan(plan.indexOf('seer'))

    const runner = startDefaultNight()
    expect(runner.state.phase).toBe('MATCH')
    expect(runner.state.roleAssignments).toEqual([])
    expect(runner.state.authority?.phase).toBe('NIGHT')
    expect(runner.state.authority?.night?.activeRoleId).toBeNull()
  })

  it('discovers the exact Wolf group then opens one immediate shared attack', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    setComposition(runner, {
      villager: 3,
      werewolf: 2,
      traitor: 1,
      seer: 1,
    })
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    runner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    expect(runner.state.nightRitual.activeStep).toEqual({
      kind: 'HOLDER_DISCOVERY',
      roleId: 'werewolf',
    })

    selectHolder(runner, 'werewolf', 'offline-player-1')
    selectHolder(runner, 'traitor', 'offline-player-3')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(runner.state.blockingError).toContain('đúng 2')
    selectHolder(runner, 'werewolf', 'offline-player-2')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })

    expect(getOfflineRoleHolderIds(runner.state, 'werewolf')).toEqual([
      'offline-player-1',
      'offline-player-2',
    ])
    expect(getOfflineRoleHolderIds(runner.state, 'traitor')).toEqual([
      'offline-player-3',
    ])
    const wolfAction = runner.state.authority?.night?.actionsByRole.werewolf
    expect(wolfAction?.kind).toBe('WOLF_VOTE')
    expect(wolfAction?.eligibleActorIds).toEqual([
      'offline-player-1',
      'offline-player-2',
      'offline-player-3',
    ])
    expect(wolfAction?.eligibleTargetIds).toContain('offline-player-4')
    expect(getOfflineRoleHolderIds(runner.state, 'villager')).toEqual([])

    runner.dispatch({
      type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT',
      targetId: 'offline-player-4',
    })
    expect(runner.state.authorityInput.nightTargetDraft).toEqual({
      kind: 'PLAYER',
      playerId: 'offline-player-4',
    })
    runner.dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })
    expect(runner.state.nightRitual.activeStep).toEqual({
      kind: 'CALL_COMPLETE',
      roleId: 'werewolf',
    })
    expect(runner.state.authority?.night?.actionsByRole.werewolf?.result)
      .toMatchObject({ targetId: 'offline-player-4' })
  })

  it('discovers Seer after Wolves and classifies an UNKNOWN-role target immediately', () => {
    const runner = commandRunner()
    fillNames(runner, 7)
    setComposition(runner, {
      villager: 3,
      werewolf: 2,
      seer: 1,
      protector: 1,
    })
    runner.dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })
    runner.dispatch({ type: 'BEGIN_OFFLINE_MATCH' })
    runner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    selectHolder(runner, 'werewolf', 'offline-player-1')
    selectHolder(runner, 'werewolf', 'offline-player-2')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    runner.dispatch({
      type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT',
      targetId: 'offline-player-4',
    })
    runner.dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })
    runner.dispatch({ type: 'ADVANCE_FROM_COMPLETED_RITUAL' })
    runner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    selectHolder(runner, 'seer', 'offline-player-3')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })

    expect(getUnassignedOfflinePlayerIds(runner.state)).toContain('offline-player-4')
    expect(getOfflineEligibleActionTargetIds(runner.state)).toContain('offline-player-4')
    runner.dispatch({
      type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT',
      targetId: 'offline-player-4',
    })
    runner.dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })
    expect(runner.state.authority?.night?.actionsByRole.seer?.seer).toMatchObject({
      targetId: 'offline-player-4',
      result: 'NON_WOLF',
      acknowledged: false,
    })
    runner.dispatch({ type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' })
    expect(runner.state.nightRitual.activeStep?.kind).toBe('CALL_COMPLETE')
  })

  it('auto-assigns Villagers only when the final non-Villager is discovered', () => {
    const runner = startDefaultNight()
    runner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    selectHolder(runner, 'werewolf', 'offline-player-1')
    selectHolder(runner, 'werewolf', 'offline-player-2')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(getOfflineRoleHolderIds(runner.state, 'villager')).toHaveLength(0)
    runner.dispatch({
      type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT',
      targetId: 'offline-player-4',
    })
    runner.dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })
    runner.dispatch({ type: 'ADVANCE_FROM_COMPLETED_RITUAL' })
    runner.dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })
    selectHolder(runner, 'seer', 'offline-player-3')
    runner.dispatch({ type: 'CONFIRM_HOLDERS' })
    expect(getOfflineRoleHolderIds(runner.state, 'villager')).toHaveLength(4)
    expect(runner.state.roleAssignments).toHaveLength(7)
  })
})
