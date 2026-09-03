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
  classicRoleById,
  classicRoleCatalog,
  type RoleId,
} from '../roles/classic-catalog'
import {
  roleDefinitions,
  type RoleActionType,
} from '../roles/role-definitions'
import {
  normalizeFactionTransitionState,
} from '../gameplay/faction-transitions'
import { createInitialCupidLoverState } from '../gameplay/lovers'
import {
  createOfflineAuthorityInput,
  reduceOfflineAuthority,
  type OfflineAuthorityCommand,
  type OfflineAuthorityInput,
} from './offline-authority'

export const offlineSessionSchemaVersion = 5 as const
export const offlinePlayerIdPrefix = 'offline-player-'

export type OfflinePhase =
  | 'SETUP'
  | 'PHYSICAL_DEAL'
  | 'MATCH'
  | 'FINISHED'

export interface OfflineHolderDiscoveryStep {
  kind: 'HOLDER_DISCOVERY'
  roleId: RoleId
}

export interface OfflineRoleActionStep {
  kind: 'ROLE_ACTION'
  roleId: RoleId
  actionType: RoleActionType
}

export interface OfflineCallCompleteStep {
  kind: 'CALL_COMPLETE'
  roleId: RoleId
}

export type OfflineNightRitualStep =
  | OfflineHolderDiscoveryStep
  | OfflineRoleActionStep
  | OfflineCallCompleteStep

export type OfflineHolderDrafts = Partial<Record<RoleId, PlayerId[]>>

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
  nightRitual: {
    callPlan: RoleId[]
    callIndex: number
    activeStep: OfflineNightRitualStep | null
    draftHolderIdsByRole: OfflineHolderDrafts
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
  | { type: 'TOGGLE_HOLDER'; roleId: RoleId; playerId: PlayerId }
  | { type: 'CONFIRM_HOLDERS' }
  | { type: 'ADVANCE_FROM_COMPLETED_RITUAL' }
  | { type: 'CLEAR_ERROR' }

const offlineNightOneRoleOrder: readonly RoleId[] = [
  'cupid',
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
    nightRitual: {
      callPlan: [],
      callIndex: 0,
      activeStep: null,
      draftHolderIdsByRole: {},
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
  // Traitor wakes inside the Werewolf-faction ritual. It remains a distinct
  // shared role assignment and never creates its own bite/action.
  if (configuredNonVillagers.has('traitor')) {
    configuredNonVillagers.add('werewolf')
  }
  configuredNonVillagers.delete('traitor')
  return offlineNightOneRoleOrder.filter((roleId) => configuredNonVillagers.has(roleId))
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
  const roleId = state.authority?.night?.activeRoleId
  if (roleId) {
    return state.authority?.night?.actionsByRole[roleId]?.eligibleTargetIds ?? []
  }
  return []
}

function actionTypeForRole(roleId: RoleId): RoleActionType {
  return roleDefinitions[roleId]?.actionType ?? 'NONE'
}

function holderStep(roleId: RoleId): OfflineHolderDiscoveryStep {
  return {
    kind: 'HOLDER_DISCOVERY',
    roleId,
  }
}

function withError(
  state: OfflineSessionState,
  blockingError: string,
  now: number,
): OfflineSessionState {
  return { ...state, blockingError, updatedAt: now }
}

function configuredDiscoveryRoleIds(
  state: OfflineSessionState,
  ritualRoleId: RoleId,
): RoleId[] {
  const roleIds = ritualRoleId === 'werewolf'
    ? (['werewolf', 'traitor'] as const)
    : [ritualRoleId]
  return roleIds.filter((roleId) => (state.roleComposition[roleId] ?? 0) > 0)
}

export function getOfflineDiscoveryRoleIds(
  state: OfflineSessionState,
  ritualRoleId: RoleId,
): RoleId[] {
  return configuredDiscoveryRoleIds(state, ritualRoleId)
}

function hasCompleteHolderDiscovery(
  state: OfflineSessionState,
  ritualRoleId: RoleId,
): boolean {
  return configuredDiscoveryRoleIds(state, ritualRoleId).every(
    (roleId) =>
      getOfflineRoleHolderIds(state, roleId).length ===
      (state.roleComposition[roleId] ?? 0),
  )
}

function projectAuthorityAssignments(
  state: Pick<OfflineSessionState, 'playerNames' | 'roleAssignments'>,
): RoleAssignment[] {
  const knownByPlayerId = new Map(
    state.roleAssignments.map((assignment) => [assignment.playerId, assignment.roleId]),
  )
  return state.playerNames.map((_, index) => {
    const playerId = `${offlinePlayerIdPrefix}${index + 1}`
    return {
      playerId,
      // Once every Werewolf is discovered, every remaining UNKNOWN player is
      // safely non-Wolf for the shared Night-1 Seer classifier. The Offline
      // session remains the source of truth for whether that physical role is
      // actually known; this projection is never shown as a discovered role.
      roleId: knownByPlayerId.get(playerId) ?? 'villager',
    }
  })
}

function syncAuthorityAssignments(
  state: OfflineSessionState,
  now: number,
): OfflineSessionState {
  if (!state.authority) return state
  const roleAssignments = projectAuthorityAssignments(state)
  const cupidWasUnknown = state.authority.cupidLovers?.objective === null
  return {
    ...state,
    authority: {
      ...state.authority,
      roleAssignments,
      factionTransitions: normalizeFactionTransitionState(
        roleAssignments,
        state.authority.factionTransitions,
      ),
      cupidLovers: cupidWasUnknown && roleAssignments.some(
        (assignment) => assignment.roleId === 'cupid',
      )
        ? createInitialCupidLoverState(roleAssignments, now)
        : state.authority.cupidLovers,
    },
  }
}

function maybeAssignVillagers(
  state: OfflineSessionState,
  now: number,
): OfflineSessionState {
  const allNonVillagersKnown = classicRoleCatalog
    .filter((role) => role.id !== 'villager')
    .every(
      (role) =>
        getOfflineRoleHolderIds(state, role.id).length ===
        (state.roleComposition[role.id] ?? 0),
    )
  if (!allNonVillagersKnown) return state

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
    roleAssignments: [
      ...state.roleAssignments,
      ...unassignedIds.map((playerId) => ({
        playerId,
        roleId: 'villager' as const,
      })),
    ],
    blockingError: null,
    updatedAt: now,
  }
}

function currentAuthorityCallIndex(state: OfflineSessionState, roleId: RoleId): number {
  const calls = state.authority?.night?.calls ?? []
  const index = calls.findIndex((call) => call.roleId === roleId)
  return index >= 0 ? index : state.nightRitual.callIndex
}

function openSharedRoleAction(
  state: OfflineSessionState,
  roleId: RoleId,
  now: number,
): OfflineSessionState {
  const staged: OfflineSessionState = {
    ...state,
    nightRitual: {
      ...state.nightRitual,
      callIndex: currentAuthorityCallIndex(state, roleId),
      activeStep: {
        kind: 'ROLE_ACTION',
        roleId,
        actionType: actionTypeForRole(roleId),
      },
      draftHolderIdsByRole: {},
    },
  }
  return reduceOfflineAuthority(
    staged,
    { type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' },
    now,
  )
}

function completedRitualStep(
  state: OfflineSessionState,
  roleId: RoleId,
  now: number,
): OfflineSessionState {
  const call = state.authority?.night?.calls.find((entry) => entry.roleId === roleId)
  if (state.blockingError || call?.status !== 'COMPLETED') return state
  return {
    ...state,
    nightRitual: {
      ...state.nightRitual,
      activeStep: { kind: 'CALL_COMPLETE', roleId },
    },
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
      nightRitual: {
        callPlan: getOfflineNightOneCallPlan(state.roleComposition),
        callIndex: 0,
        activeStep: null,
        draftHolderIdsByRole: {},
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'BEGIN_OFFLINE_MATCH') {
    if (state.phase !== 'PHYSICAL_DEAL') return state
    return reduceOfflineAuthority(maybeAssignVillagers(state, now), command, now)
  }

  if (command.type === 'CALL_NEXT_OFFLINE_NIGHT_ROLE') {
    if (
      state.phase !== 'MATCH' ||
      !state.authority?.night ||
      state.nightRitual.activeStep
    ) {
      return state
    }
    const nextCall = state.authority.night.calls.find(
      (call) => call.status === 'NOT_CALLED',
    )
    if (!nextCall) return reduceOfflineAuthority(state, command, now)
    const callIndex = currentAuthorityCallIndex(state, nextCall.roleId)
    if (
      state.authority.dayNumber === 1 &&
      !hasCompleteHolderDiscovery(state, nextCall.roleId)
    ) {
      return {
        ...state,
        nightRitual: {
          ...state.nightRitual,
          callIndex,
          activeStep: holderStep(nextCall.roleId),
          draftHolderIdsByRole: {},
        },
        blockingError: null,
        updatedAt: now,
      }
    }
    return openSharedRoleAction(state, nextCall.roleId, now)
  }

  if (command.type === 'TOGGLE_HOLDER') {
    const step = state.nightRitual.activeStep
    if (
      state.phase !== 'MATCH' ||
      state.authority?.dayNumber !== 1 ||
      step?.kind !== 'HOLDER_DISCOVERY' ||
      !configuredDiscoveryRoleIds(state, step.roleId).includes(command.roleId)
    ) {
      return state
    }
    const availableIds = new Set(getUnassignedOfflinePlayerIds(state))
    if (!availableIds.has(command.playerId)) return state
    const drafts = state.nightRitual.draftHolderIdsByRole
    const current = drafts[command.roleId] ?? []
    const selected = current.includes(command.playerId)
    const selectedElsewhere = Object.entries(drafts).some(
      ([roleId, playerIds]) =>
        roleId !== command.roleId && playerIds?.includes(command.playerId),
    )
    if (!selected && selectedElsewhere) return state
    const knownCount = getOfflineRoleHolderIds(state, command.roleId).length
    const requiredCount = state.roleComposition[command.roleId] ?? 0
    const nextDraft = selected
      ? current.filter((playerId) => playerId !== command.playerId)
      : knownCount + current.length < requiredCount
        ? [...current, command.playerId]
        : current
    return {
      ...state,
      nightRitual: {
        ...state.nightRitual,
        draftHolderIdsByRole: {
          ...drafts,
          [command.roleId]: nextDraft,
        },
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  if (command.type === 'CONFIRM_HOLDERS') {
    const step = state.nightRitual.activeStep
    if (
      state.phase !== 'MATCH' ||
      state.authority?.dayNumber !== 1 ||
      step?.kind !== 'HOLDER_DISCOVERY'
    ) {
      return state
    }
    const discoveryRoleIds = configuredDiscoveryRoleIds(state, step.roleId)
    const selectedAssignments = discoveryRoleIds.flatMap((roleId) =>
      (state.nightRitual.draftHolderIdsByRole[roleId] ?? []).map(
        (playerId) => ({ playerId, roleId }),
      ),
    )
    for (const roleId of discoveryRoleIds) {
      const knownCount = getOfflineRoleHolderIds(state, roleId).length
      const selectedCount = state.nightRitual.draftHolderIdsByRole[roleId]?.length ?? 0
      const requiredCount = state.roleComposition[roleId] ?? 0
      if (knownCount + selectedCount !== requiredCount) {
      return withError(
        state,
          `Phải chọn đúng ${requiredCount} người giữ vai ${classicRoleById[roleId].displayName}.`,
        now,
      )
      }
    }
    const selectedIds = selectedAssignments.map((assignment) => assignment.playerId)
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
    let next: OfflineSessionState = {
      ...state,
      roleAssignments: [
        ...state.roleAssignments,
        ...selectedAssignments,
      ],
      offlineEvents: [
        ...state.offlineEvents,
        ...discoveryRoleIds.flatMap((roleId, index) => {
          const selectedForRole = selectedAssignments
            .filter((assignment) => assignment.roleId === roleId)
            .map((assignment) => assignment.playerId)
          if (selectedForRole.length === 0) return []
          return [{
            id: `offline-role-discovery-${roleId}-${now}-${index}`,
            type: 'ROLE_IDENTITY_DISCOVERED' as const,
            occurredAt: now,
            roleId,
            holderPlayerIds: [
              ...getOfflineRoleHolderIds(state, roleId),
              ...selectedForRole,
            ],
          }]
        }),
      ],
      nightRitual: {
        ...state.nightRitual,
        activeStep: {
          kind: 'ROLE_ACTION',
          roleId: step.roleId,
          actionType: actionTypeForRole(step.roleId),
        },
        draftHolderIdsByRole: {},
      },
      blockingError: null,
      updatedAt: now,
    }
    next = maybeAssignVillagers(next, now)
    next = syncAuthorityAssignments(next, now)
    return openSharedRoleAction(next, step.roleId, now)
  }

  if (command.type === 'ADVANCE_FROM_COMPLETED_RITUAL') {
    const step = state.nightRitual.activeStep
    if (state.phase !== 'MATCH' || step?.kind !== 'CALL_COMPLETE') {
      return state
    }
    return {
      ...state,
      nightRitual: {
        ...state.nightRitual,
        callIndex: state.nightRitual.callIndex + 1,
        activeStep: null,
        draftHolderIdsByRole: {},
      },
      blockingError: null,
      updatedAt: now,
    }
  }

  const activeRoleId = state.nightRitual.activeStep?.roleId ??
    state.authority?.night?.activeRoleId
  const next = reduceOfflineAuthority(state, command, now)
  if (command.type === 'START_OFFLINE_NEXT_NIGHT' && next !== state) {
    return {
      ...next,
      nightRitual: {
        ...next.nightRitual,
        callIndex: 0,
        activeStep: null,
        draftHolderIdsByRole: {},
      },
    }
  }
  if (!activeRoleId) {
    return next
  }
  if (command.type === 'COMPLETE_ACTIVE_OFFLINE_RITUAL') {
    const call = next.authority?.night?.calls.find(
      (entry) => entry.roleId === activeRoleId,
    )
    return call?.status === 'COMPLETED' && !next.blockingError
      ? {
          ...next,
          nightRitual: {
            ...next.nightRitual,
            callIndex: next.nightRitual.callIndex + 1,
            activeStep: null,
            draftHolderIdsByRole: {},
          },
        }
      : next
  }
  if (
    command.type === 'SUBMIT_OFFLINE_NIGHT_TARGET' ||
    command.type === 'CONFIRM_OFFLINE_NIGHT_TARGET' ||
    command.type === 'ACKNOWLEDGE_OFFLINE_LOVERS' ||
    command.type === 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' ||
    command.type === 'CONFIRM_OFFLINE_WITCH_DECISION'
  ) {
    return completedRitualStep(next, activeRoleId, now)
  }
  return next
}
