import { getEligibleRoleTargets } from '../actions/target-rules'
import type { RoomState } from '../game/types'
import {
  defaultRoleComposition,
  maximumSeatCount,
  minimumSeatCount,
  normalizePlayerName,
  validateOrderedPlayerNames,
  validateRoomSetup,
  type RoleComposition,
} from '../game/room-setup'
import type { Player, PlayerId, RoleAssignment } from '../game/types'
import {
  classicRoleCatalog,
  type RoleId,
} from '../roles/classic-catalog'
import {
  roleDefinitions,
  type RoleActionType,
} from '../roles/role-definitions'
import {
  createOfflineAuthorityInput,
  reduceOfflineAuthority,
  type OfflineAuthorityCommand,
  type OfflineAuthorityInput,
} from './offline-authority'

export const offlineSessionSchemaVersion = 4 as const
export const offlinePlayerIdPrefix = 'offline-player-'

export type OfflinePhase =
  | 'SETUP'
  | 'PHYSICAL_DEAL'
  | 'NIGHT_1_DISCOVERY'
  | 'NIGHT_1_READY'
  | 'MATCH'
  | 'FINISHED'

export interface OfflineHolderDiscoveryStep {
  kind: 'HOLDER_DISCOVERY'
  roleId: RoleId
  requiredHolderCount: number
}

export interface OfflineRoleActionStep {
  kind: 'ROLE_ACTION'
  roleId: RoleId
  actionType: RoleActionType
}

export type OfflineNightOneStep =
  | OfflineHolderDiscoveryStep
  | OfflineRoleActionStep

export interface OfflineRoleIdentityDiscoveredEvent {
  id: string
  type: 'ROLE_IDENTITY_DISCOVERED'
  occurredAt: number
  roleId: RoleId
  holderPlayerIds: PlayerId[]
}

export interface OfflineDayCandidateLockedEvent {
  id: string
  type: 'DAY_CANDIDATE_LOCKED'
  occurredAt: number
  dayNumber: number
  candidatePlayerId: PlayerId
}

export interface OfflineDayCandidateSparedEvent {
  id: string
  type: 'DAY_CANDIDATE_SPARED'
  occurredAt: number
  dayNumber: number
  candidatePlayerId: PlayerId
}

export interface OfflineDayNoCandidateEvent {
  id: string
  type: 'DAY_NO_CANDIDATE'
  occurredAt: number
  dayNumber: number
}

export type OfflineSessionEvent =
  | OfflineRoleIdentityDiscoveredEvent
  | OfflineDayCandidateLockedEvent
  | OfflineDayCandidateSparedEvent
  | OfflineDayNoCandidateEvent

export interface OfflineSessionState {
  schemaVersion: typeof offlineSessionSchemaVersion
  mode: 'OFFLINE_MODERATOR'
  phase: OfflinePhase
  seatCount: number
  playerNames: string[]
  roleComposition: RoleComposition
  roleAssignments: RoleAssignment[]
  offlineEvents: OfflineSessionEvent[]
  nightOne: {
    callPlan: RoleId[]
    callIndex: number
    activeStep: OfflineNightOneStep | null
    draftHolderIds: PlayerId[]
  }
  authority: RoomState | null
  authorityInput: OfflineAuthorityInput
  blockingError: string | null
  updatedAt: number
}

export interface OfflineSetupValidation {
  valid: boolean
  errors: string[]
  nameErrors: string[]
}

export type OfflineSessionCommand =
  | OfflineAuthorityCommand
  | { type: 'SET_SEAT_COUNT'; seatCount: number }
  | { type: 'SET_PLAYER_NAME'; index: number; name: string }
  | { type: 'SET_ROLE_QUANTITY'; roleId: RoleId; quantity: number }
  | { type: 'CONTINUE_TO_PHYSICAL_DEAL' }
  | { type: 'BEGIN_NIGHT_ONE_DISCOVERY' }
  | { type: 'TOGGLE_HOLDER'; playerId: PlayerId }
  | { type: 'CONFIRM_HOLDERS' }
  | { type: 'ADVANCE_FROM_ROLE_ACTION' }
  | { type: 'CLEAR_ERROR' }

const offlineNightOneRoleOrder: readonly RoleId[] = [
  'cupid',
  'traitor',
  'werewolf',
  'seer',
  'protector',
  'half-wolf',
  'serial-killer',
  'hunter',
  'witch',
  'mayor',
  'fool',
]

export function createOfflineSessionState(
  now: number = Date.now(),
): OfflineSessionState {
  const seatCount = minimumSeatCount
  return {
    schemaVersion: offlineSessionSchemaVersion,
    mode: 'OFFLINE_MODERATOR',
    phase: 'SETUP',
    seatCount,
    playerNames: Array.from({ length: seatCount }, () => ''),
    roleComposition: defaultRoleComposition(seatCount),
    roleAssignments: [],
    offlineEvents: [],
    nightOne: {
      callPlan: [],
      callIndex: 0,
      activeStep: null,
      draftHolderIds: [],
    },
    authority: null,
    authorityInput: createOfflineAuthorityInput(),
    blockingError: null,
    updatedAt: now,
  }
}

export function getOfflinePlayers(state: OfflineSessionState): Player[] {
  return state.playerNames.map((alias, index) => ({
    id: `${offlinePlayerIdPrefix}${index + 1}`,
    seat: index + 1,
    alias,
    alive: true,
  }))
}

export function validateOfflineSetup(
  state: OfflineSessionState,
): OfflineSetupValidation {
  const nameErrors = validateOrderedPlayerNames(state.playerNames)
  const setup = validateRoomSetup({
    seatCount: state.seatCount,
    roleComposition: state.roleComposition,
    wolfPolicy: 'RANDOM_ON_TIE',
  })
  const errors = [
    ...setup.errors,
    ...nameErrors.flatMap((error, index) =>
      error ? [`Người chơi ${index + 1}: ${error}`] : [],
    ),
  ]
  if (state.playerNames.length !== state.seatCount) {
    errors.push('Danh sách tên phải khớp đúng số người chơi.')
  }
  return { valid: errors.length === 0, errors, nameErrors }
}

export function getOfflineNightOneCallPlan(
  composition: RoleComposition,
): RoleId[] {
  const configuredNonVillagers = new Set(
    classicRoleCatalog
      .filter(
        (role) => role.id !== 'villager' && (composition[role.id] ?? 0) > 0,
      )
      .map((role) => role.id),
  )
  return offlineNightOneRoleOrder.filter((roleId) =>
    configuredNonVillagers.has(roleId),
  )
}

export function getUnassignedOfflinePlayerIds(
  state: OfflineSessionState,
): PlayerId[] {
  const assignedIds = new Set(
    state.roleAssignments.map((assignment) => assignment.playerId),
  )
  return getOfflinePlayers(state)
    .filter((player) => !assignedIds.has(player.id))
    .map((player) => player.id)
}

export function getOfflineRoleHolderIds(
  state: OfflineSessionState,
  roleId: RoleId,
): PlayerId[] {
  return state.roleAssignments
    .filter((assignment) => assignment.roleId === roleId)
    .map((assignment) => assignment.playerId)
}

export function getOfflineEligibleActionTargetIds(
  state: OfflineSessionState,
): PlayerId[] {
  const step = state.nightOne.activeStep
  if (!step || step.kind !== 'ROLE_ACTION' || step.actionType === 'NONE') {
    return []
  }
  const actorId = getOfflineRoleHolderIds(state, step.roleId)[0]
  return getEligibleRoleTargets(
    {
      players: getOfflinePlayers(state),
      roleAssignments: state.roleAssignments,
      journal: [],
      dayNumber: 1,
    },
    step.roleId,
    actorId,
  )
}

function actionTypeForRole(roleId: RoleId): RoleActionType {
  return roleDefinitions[roleId]?.actionType ?? 'NONE'
}

function holderStep(
  state: OfflineSessionState,
  roleId: RoleId,
): OfflineHolderDiscoveryStep {
  return {
    kind: 'HOLDER_DISCOVERY',
    roleId,
    requiredHolderCount: state.roleComposition[roleId] ?? 0,
  }
}

function withError(
  state: OfflineSessionState,
  blockingError: string,
  now: number,
): OfflineSessionState {
  return { ...state, blockingError, updatedAt: now }
}

function finishVillagerAssignment(
  state: OfflineSessionState,
  now: number,
): OfflineSessionState {
  const unassignedIds = getUnassignedOfflinePlayerIds(state)
  const expectedVillagers = state.roleComposition.villager ?? 0
  const assignedIds = state.roleAssignments.map(
    (assignment) => assignment.playerId,
  )
  if (new Set(assignedIds).size !== assignedIds.length) {
    return withError(
      state,
      'Không thể hoàn tất: một người đang giữ nhiều hơn một vai.',
      now,
    )
  }
  if (unassignedIds.length !== expectedVillagers) {
    return withError(
      state,
      `Không thể hoàn tất: còn ${unassignedIds.length} người chưa gán nhưng bộ bài cần đúng ${expectedVillagers} Dân Làng.`,
      now,
    )
  }

  return {
    ...state,
    phase: 'NIGHT_1_READY',
    roleAssignments: [
      ...state.roleAssignments,
      ...unassignedIds.map((playerId) => ({
        playerId,
        roleId: 'villager' as const,
      })),
    ],
    nightOne: {
      ...state.nightOne,
      callIndex: state.nightOne.callPlan.length,
      activeStep: null,
      draftHolderIds: [],
    },
    blockingError: null,
    updatedAt: now,
  }
}

export function reduceOfflineSession(
  state: OfflineSessionState,
  command: OfflineSessionCommand,
  now: number = Date.now(),
): OfflineSessionState {
  if (command.type === 'CLEAR_ERROR') {
    return { ...state, blockingError: null, updatedAt: now }
  }

  if (command.type === 'SET_SEAT_COUNT') {
    if (state.phase !== 'SETUP') return state
    const seatCount = Math.max(
      minimumSeatCount,
      Math.min(maximumSeatCount, Math.trunc(command.seatCount)),
    )
    const playerNames = Array.from(
      { length: seatCount },
      (_, index) => state.playerNames[index] ?? '',
    )
    return {
      ...state,
      seatCount,
      playerNames,
      roleComposition: defaultRoleComposition(seatCount),
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'SET_PLAYER_NAME') {
    if (
      state.phase !== 'SETUP' ||
      command.index < 0 ||
      command.index >= state.seatCount
    ) {
      return state
    }
    const playerNames = [...state.playerNames]
    playerNames[command.index] = command.name
    return { ...state, playerNames, blockingError: null, updatedAt: now }
  }

  if (command.type === 'SET_ROLE_QUANTITY') {
    if (state.phase !== 'SETUP') return state
    const role = classicRoleCatalog.find((entry) => entry.id === command.roleId)
    if (!role) return state
    const maximum = role.quantityMode === 'MULTIPLE' ? state.seatCount : 1
    const quantity = Math.max(0, Math.min(maximum, Math.trunc(command.quantity)))
    return {
      ...state,
      roleComposition: { ...state.roleComposition, [command.roleId]: quantity },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'CONTINUE_TO_PHYSICAL_DEAL') {
    if (state.phase !== 'SETUP') return state
    const validation = validateOfflineSetup(state)
    if (!validation.valid) {
      return withError(state, validation.errors[0], now)
    }
    return {
      ...state,
      phase: 'PHYSICAL_DEAL',
      playerNames: state.playerNames.map(normalizePlayerName),
      roleAssignments: [],
      offlineEvents: [],
      authority: null,
      authorityInput: createOfflineAuthorityInput(),
      nightOne: {
        callPlan: getOfflineNightOneCallPlan(state.roleComposition),
        callIndex: 0,
        activeStep: null,
        draftHolderIds: [],
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'BEGIN_NIGHT_ONE_DISCOVERY') {
    if (state.phase !== 'PHYSICAL_DEAL') return state
    const roleId = state.nightOne.callPlan[0]
    if (!roleId) return finishVillagerAssignment(state, now)
    return {
      ...state,
      phase: 'NIGHT_1_DISCOVERY',
      nightOne: {
        ...state.nightOne,
        activeStep: holderStep(state, roleId),
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'TOGGLE_HOLDER') {
    const step = state.nightOne.activeStep
    if (state.phase !== 'NIGHT_1_DISCOVERY' || step?.kind !== 'HOLDER_DISCOVERY') {
      return state
    }
    const availableIds = new Set(getUnassignedOfflinePlayerIds(state))
    if (!availableIds.has(command.playerId)) return state
    const selected = state.nightOne.draftHolderIds.includes(command.playerId)
    const draftHolderIds = selected
      ? state.nightOne.draftHolderIds.filter(
          (playerId) => playerId !== command.playerId,
        )
      : state.nightOne.draftHolderIds.length < step.requiredHolderCount
        ? [...state.nightOne.draftHolderIds, command.playerId]
        : state.nightOne.draftHolderIds
    return {
      ...state,
      nightOne: { ...state.nightOne, draftHolderIds },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'CONFIRM_HOLDERS') {
    const step = state.nightOne.activeStep
    if (state.phase !== 'NIGHT_1_DISCOVERY' || step?.kind !== 'HOLDER_DISCOVERY') {
      return state
    }
    const selectedIds = state.nightOne.draftHolderIds
    if (selectedIds.length !== step.requiredHolderCount) {
      return withError(
        state,
        `Phải chọn đúng ${step.requiredHolderCount} người giữ vai.`,
        now,
      )
    }
    if (new Set(selectedIds).size !== selectedIds.length) {
      return withError(state, 'Không thể chọn trùng người giữ vai.', now)
    }
    const unassignedIds = new Set(getUnassignedOfflinePlayerIds(state))
    if (selectedIds.some((playerId) => !unassignedIds.has(playerId))) {
      return withError(
        state,
        'Người đã có vai không thể được chọn làm người giữ vai khác.',
        now,
      )
    }
    return {
      ...state,
      roleAssignments: [
        ...state.roleAssignments,
        ...selectedIds.map((playerId) => ({
          playerId,
          roleId: step.roleId,
        })),
      ],
      offlineEvents: [
        ...state.offlineEvents,
        {
          id: `offline-role-discovery-${step.roleId}-${now}`,
          type: 'ROLE_IDENTITY_DISCOVERED',
          occurredAt: now,
          roleId: step.roleId,
          holderPlayerIds: [...selectedIds],
        },
      ],
      nightOne: {
        ...state.nightOne,
        activeStep: {
          kind: 'ROLE_ACTION',
          roleId: step.roleId,
          actionType: actionTypeForRole(step.roleId),
        },
        draftHolderIds: [],
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'ADVANCE_FROM_ROLE_ACTION') {
    const step = state.nightOne.activeStep
    if (state.phase !== 'NIGHT_1_DISCOVERY' || step?.kind !== 'ROLE_ACTION') {
      return state
    }
    const callIndex = state.nightOne.callIndex + 1
    const nextRoleId = state.nightOne.callPlan[callIndex]
    if (!nextRoleId) {
      return finishVillagerAssignment(
        {
          ...state,
          nightOne: { ...state.nightOne, callIndex },
        },
        now,
      )
    }
    return {
      ...state,
      nightOne: {
        ...state.nightOne,
        callIndex,
        activeStep: holderStep(state, nextRoleId),
        draftHolderIds: [],
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  return reduceOfflineAuthority(state, command, now)
}
