import { classicRoleById, type RoleId } from '../roles/classic-catalog'
import { createOfflineAuthorityInput } from './offline-authority'
import {
  offlineSessionSchemaVersion,
  type OfflineNightOneStep,
  type OfflinePhase,
  type OfflineSessionEvent,
  type OfflineSessionState,
} from './offline-session'

export const offlineSessionStorageKey =
  'masoi.offline-moderator.session.v4' as const
export const offlineSessionV3StorageKey =
  'masoi.offline-moderator.session.v3' as const
export const offlineSessionV2StorageKey =
  'masoi.offline-moderator.session.v2' as const
export const legacyOfflineSessionStorageKey =
  'masoi.offline-moderator.session.v1' as const

const offlineStorageKeys = [
  offlineSessionStorageKey,
  offlineSessionV3StorageKey,
  offlineSessionV2StorageKey,
  legacyOfflineSessionStorageKey,
] as const

export interface OfflineStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export type OfflineSessionStorageStatus =
  | 'NONE'
  | 'ACTIVE'
  | 'FINISHED'
  | 'CORRUPT'

export interface OfflineSessionInspection {
  status: OfflineSessionStorageStatus
  state: OfflineSessionState | null
  sourceVersion?: 1 | 2 | 3 | 4
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && value in classicRoleById
}

function isPhase(value: unknown): value is OfflinePhase {
  return (
    value === 'SETUP' ||
    value === 'PHYSICAL_DEAL' ||
    value === 'NIGHT_1_DISCOVERY' ||
    value === 'NIGHT_1_READY' ||
    value === 'MATCH' ||
    value === 'FINISHED'
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isRoomPlayer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.seat === 'number' &&
    Number.isInteger(value.seat) &&
    typeof value.alias === 'string' &&
    typeof value.alive === 'boolean'
  )
}

function isRoleAssignment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.playerId === 'string' &&
    isRoleId(value.roleId)
  )
}

function isRoomJournalEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.timestamp === 'number' &&
    typeof value.dayNumber === 'number' &&
    (value.phase === 'SETUP' ||
      value.phase === 'NIGHT' ||
      value.phase === 'DAY' ||
      value.phase === 'ENDED')
  )
}

function isNightAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRoleId(value.roleId) &&
    (value.kind === 'WOLF_VOTE' ||
      value.kind === 'SELECT_TARGET' ||
      value.kind === 'HUNTER_PRELOCK' ||
      value.kind === 'SERIAL_KILLER_ATTACK' ||
      value.kind === 'WITCH_DECISION' ||
      value.kind === 'CUPID_PAIRING') &&
    (value.status === 'OPEN' ||
      value.status === 'COMPLETED' ||
      value.status === 'CLOSED_BY_MODERATOR') &&
    isStringArray(value.eligibleActorIds) &&
    isStringArray(value.eligibleTargetIds) &&
    isRecord(value.selections) &&
    Object.values(value.selections).every(
      (targetId) => targetId === null || typeof targetId === 'string',
    ) &&
    isStringArray(value.confirmedActorIds) &&
    typeof value.openedAt === 'number'
  )
}

function isNightState(value: unknown): boolean {
  if (value === null) return true
  return (
    isRecord(value) &&
    typeof value.number === 'number' &&
    Array.isArray(value.calls) &&
    value.calls.every(
      (call) =>
        isRecord(call) &&
        isRoleId(call.roleId) &&
        (call.status === 'NOT_CALLED' ||
          call.status === 'CALLED' ||
          call.status === 'COMPLETED'),
    ) &&
    (value.activeRoleId === null || isRoleId(value.activeRoleId)) &&
    isRecord(value.actionsByRole) &&
    Object.entries(value.actionsByRole).every(
      ([roleId, action]) => isRoleId(roleId) && isNightAction(action),
    )
  )
}

function isDayVoteState(value: unknown): boolean {
  if (value === null) return true
  return (
    isRecord(value) &&
    (value.status === 'OPEN' || value.status === 'CLOSED') &&
    isRecord(value.votes) &&
    Object.values(value.votes).every(
      (targetId) => targetId === null || typeof targetId === 'string',
    ) &&
    typeof value.openedAt === 'number' &&
    typeof value.deadlineAt === 'number'
  )
}

function isHunterRevenge(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    typeof value.hunterPlayerId === 'string' &&
    (value.status === 'PENDING' || value.status === 'RESOLVED')
  )
}

function isDayVerdictState(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return (
    isRecord(value) &&
    value.status === 'RESOLVED' &&
    (value.outcome === 'NO_CANDIDATE' ||
      value.outcome === 'SPARED' ||
      value.outcome === 'EXECUTED') &&
    (value.candidatePlayerId === undefined ||
      typeof value.candidatePlayerId === 'string') &&
    typeof value.resolvedAt === 'number' &&
    isHunterRevenge(value.hunterRevenge)
  )
}

function isAuthorityState(value: unknown): boolean {
  if (value === null) return true
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    typeof value.revision === 'number' &&
    typeof value.dayNumber === 'number' &&
    Array.isArray(value.players) &&
    value.players.every(isRoomPlayer) &&
    Array.isArray(value.roleAssignments) &&
    value.roleAssignments.every(isRoleAssignment) &&
    Array.isArray(value.journal) &&
    value.journal.every(isRoomJournalEvent) &&
    isRecord(value.config) &&
    Array.isArray(value.config.nightRoleIds) &&
    value.config.nightRoleIds.every(isRoleId) &&
    isNightState(value.night) &&
    isDayVoteState(value.dayVote) &&
    isDayVerdictState(value.dayVerdict) &&
    (value.lifecycle === 'IN_GAME' || value.lifecycle === 'FINISHED') &&
    (value.phase === 'SETUP' ||
      value.phase === 'NIGHT' ||
      value.phase === 'DAY' ||
      value.phase === 'ENDED')
  )
}

function isAuthorityInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.cupidTargetIds) &&
    value.cupidTargetIds.every((playerId) => typeof playerId === 'string') &&
    (value.witchResurrectionTargetId === null ||
      typeof value.witchResurrectionTargetId === 'string') &&
    (value.witchPoisonTargetId === null ||
      typeof value.witchPoisonTargetId === 'string') &&
    isDayDecision(value.dayDecision)
  )
}

function isDayDecision(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.stage === 'CANDIDATE_DRAFT') {
    if (!isRecord(value.selection)) return false
    return value.selection.kind === 'UNSET' ||
      value.selection.kind === 'NO_CANDIDATE' ||
      (value.selection.kind === 'PLAYER' &&
        typeof value.selection.playerId === 'string')
  }
  if (value.stage === 'LAST_WORDS') {
    return typeof value.candidatePlayerId === 'string' &&
      (value.verdictDraft === null ||
        value.verdictDraft === 'SPARE' ||
        value.verdictDraft === 'EXECUTE')
  }
  return value.stage === 'VERDICT_CONFIRM' &&
    typeof value.candidatePlayerId === 'string' &&
    (value.verdict === 'SPARE' || value.verdict === 'EXECUTE')
}

function isNightStep(value: unknown): value is OfflineNightOneStep | null {
  if (value === null) return true
  if (!isRecord(value) || !isRoleId(value.roleId)) return false
  if (value.kind === 'HOLDER_DISCOVERY') {
    return (
      typeof value.requiredHolderCount === 'number' &&
      Number.isInteger(value.requiredHolderCount) &&
      value.requiredHolderCount > 0
    )
  }
  if (value.kind === 'ROLE_ACTION') {
    return (
      value.actionType === 'WOLF_VOTE' ||
      value.actionType === 'SELECT_TARGET' ||
      value.actionType === 'HUNTER_PRELOCK' ||
      value.actionType === 'SERIAL_KILLER_ATTACK' ||
      value.actionType === 'WITCH_DECISION' ||
      value.actionType === 'CUPID_PAIRING' ||
      value.actionType === 'NONE'
    )
  }
  return false
}

function isOfflineEvent(value: unknown): value is OfflineSessionEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.occurredAt !== 'number'
  ) return false
  if (value.type === 'ROLE_IDENTITY_DISCOVERED') {
    return isRoleId(value.roleId) &&
      value.roleId !== 'villager' &&
      Array.isArray(value.holderPlayerIds) &&
      value.holderPlayerIds.length > 0 &&
      value.holderPlayerIds.every((playerId) => typeof playerId === 'string') &&
      new Set(value.holderPlayerIds).size === value.holderPlayerIds.length
  }
  if (value.type === 'DAY_NO_CANDIDATE') {
    return typeof value.dayNumber === 'number'
  }
  return (
    (value.type === 'DAY_CANDIDATE_LOCKED' ||
      value.type === 'DAY_CANDIDATE_SPARED') &&
    typeof value.dayNumber === 'number' &&
    typeof value.candidatePlayerId === 'string'
  )
}

export function isOfflineSessionState(
  value: unknown,
): value is OfflineSessionState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== offlineSessionSchemaVersion ||
    value.mode !== 'OFFLINE_MODERATOR' ||
    !isPhase(value.phase) ||
    typeof value.seatCount !== 'number' ||
    !Number.isInteger(value.seatCount) ||
    !Array.isArray(value.playerNames) ||
    !value.playerNames.every((name) => typeof name === 'string') ||
    !isRecord(value.roleComposition) ||
    !Array.isArray(value.roleAssignments) ||
    !Array.isArray(value.offlineEvents) ||
    !value.offlineEvents.every(isOfflineEvent) ||
    !isRecord(value.nightOne) ||
    !isAuthorityState(value.authority) ||
    !isAuthorityInput(value.authorityInput) ||
    (value.blockingError !== null && typeof value.blockingError !== 'string') ||
    typeof value.updatedAt !== 'number'
  ) {
    return false
  }
  if (
    !Object.entries(value.roleComposition).every(
      ([roleId, quantity]) =>
        isRoleId(roleId) &&
        typeof quantity === 'number' &&
        Number.isInteger(quantity) &&
        quantity >= 0,
    )
  ) {
    return false
  }
  if (
    !value.roleAssignments.every(
      (assignment) =>
        isRecord(assignment) &&
        typeof assignment.playerId === 'string' &&
        isRoleId(assignment.roleId),
    )
  ) {
    return false
  }
  return (
    Array.isArray(value.nightOne.callPlan) &&
    value.nightOne.callPlan.every(isRoleId) &&
    typeof value.nightOne.callIndex === 'number' &&
    Number.isInteger(value.nightOne.callIndex) &&
    value.nightOne.callIndex >= 0 &&
    isNightStep(value.nightOne.activeStep) &&
    Array.isArray(value.nightOne.draftHolderIds) &&
    value.nightOne.draftHolderIds.every(
      (playerId) => typeof playerId === 'string',
    )
  )
}

function synthesizedDiscoveryEvents(
  value: Record<string, unknown>,
): OfflineSessionEvent[] {
  if (!Array.isArray(value.roleAssignments) || !isRecord(value.nightOne)) {
    return []
  }
  const roleAssignments: unknown[] = value.roleAssignments
  const callPlan = Array.isArray(value.nightOne.callPlan)
    ? value.nightOne.callPlan.filter(isRoleId)
    : []
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0
  return callPlan.flatMap((roleId, index): OfflineSessionEvent[] => {
    const holderPlayerIds = roleAssignments
      .filter(
        (assignment: unknown) =>
          isRecord(assignment) && assignment.roleId === roleId,
      )
      .map((assignment: unknown) =>
        isRecord(assignment) ? assignment.playerId : undefined,
      )
      .filter((playerId: unknown): playerId is string => typeof playerId === 'string')
    if (holderPlayerIds.length === 0) return []
    return [{
      id: `offline-migrated-role-discovery-${roleId}`,
      type: 'ROLE_IDENTITY_DISCOVERED',
      occurredAt: updatedAt - callPlan.length + index,
      roleId,
      holderPlayerIds,
    }]
  })
}

const obsoleteOfflineDayJournalTypes = new Set([
  'DAY_VOTE_OPENED',
  'DAY_VOTE_CHANGED',
  'DAY_VOTE_CLOSED',
  'HANGING_RESULT',
])

function migrateAuthorityInput(value: unknown) {
  const fresh = createOfflineAuthorityInput()
  if (!isRecord(value)) return fresh
  return {
    cupidTargetIds: Array.isArray(value.cupidTargetIds)
      ? value.cupidTargetIds
      : fresh.cupidTargetIds,
    witchResurrectionTargetId:
      value.witchResurrectionTargetId === null ||
      typeof value.witchResurrectionTargetId === 'string'
        ? value.witchResurrectionTargetId
        : null,
    witchPoisonTargetId:
      value.witchPoisonTargetId === null ||
      typeof value.witchPoisonTargetId === 'string'
        ? value.witchPoisonTargetId
        : null,
    dayDecision: fresh.dayDecision,
  }
}

function migrateV3Authority(
  authority: unknown,
  updatedAt: number,
): { authority: unknown; events: OfflineSessionEvent[] } {
  if (authority === null) return { authority: null, events: [] }
  if (!isRecord(authority)) return { authority, events: [] }
  const journal = Array.isArray(authority.journal)
    ? authority.journal.filter(
        (event) =>
          !isRecord(event) ||
          typeof event.type !== 'string' ||
          !obsoleteOfflineDayJournalTypes.has(event.type),
      )
    : authority.journal
  const dayVote = authority.dayVote
  let dayVerdict: Record<string, unknown> | null = null
  const events: OfflineSessionEvent[] = []
  if (isRecord(dayVote) && dayVote.status === 'CLOSED') {
    const resolvedAt = typeof dayVote.closedAt === 'number'
      ? dayVote.closedAt
      : updatedAt
    const result = isRecord(dayVote.result) ? dayVote.result : null
    const candidatePlayerId =
      result?.kind === 'UNIQUE' &&
      Array.isArray(result.targetIds) &&
      typeof result.targetIds[0] === 'string'
        ? result.targetIds[0]
        : null
    if (candidatePlayerId) {
      dayVerdict = {
        status: 'RESOLVED',
        outcome: 'EXECUTED',
        candidatePlayerId,
        resolvedAt,
        hangingEffect: dayVote.hangingEffect,
        consequenceEffects: dayVote.consequenceEffects,
        hunterRevenge: dayVote.hunterRevenge,
      }
      events.push({
        id: `offline-migrated-day-candidate-${authority.dayNumber ?? 1}`,
        type: 'DAY_CANDIDATE_LOCKED',
        occurredAt: resolvedAt - 1,
        dayNumber: typeof authority.dayNumber === 'number' ? authority.dayNumber : 1,
        candidatePlayerId,
      })
    } else {
      dayVerdict = {
        status: 'RESOLVED',
        outcome: 'NO_CANDIDATE',
        resolvedAt,
      }
      events.push({
        id: `offline-migrated-day-no-candidate-${authority.dayNumber ?? 1}`,
        type: 'DAY_NO_CANDIDATE',
        occurredAt: resolvedAt,
        dayNumber: typeof authority.dayNumber === 'number' ? authority.dayNumber : 1,
      })
    }
  }
  return {
    authority: {
      ...authority,
      dayVote: null,
      dayVerdict,
      journal,
    },
    events,
  }
}

function migrateV3OfflineSession(value: unknown): OfflineSessionState | null {
  if (!isRecord(value) || value.schemaVersion !== 3) return null
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0
  const authorityMigration = migrateV3Authority(value.authority, updatedAt)
  const existingEvents = Array.isArray(value.offlineEvents)
    ? value.offlineEvents
    : []
  const migrated = {
    ...value,
    schemaVersion: offlineSessionSchemaVersion,
    authority: authorityMigration.authority,
    authorityInput: migrateAuthorityInput(value.authorityInput),
    offlineEvents: [...existingEvents, ...authorityMigration.events],
  }
  return isOfflineSessionState(migrated) ? migrated : null
}

function migrateV2OfflineSession(value: unknown): OfflineSessionState | null {
  if (!isRecord(value) || value.schemaVersion !== 2) return null
  return migrateV3OfflineSession({
    ...value,
    schemaVersion: 3,
    offlineEvents: synthesizedDiscoveryEvents(value),
  })
}

function migrateV1OfflineSession(value: unknown): OfflineSessionState | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  return migrateV2OfflineSession({
    ...value,
    schemaVersion: 2,
    authority: null,
    authorityInput: createOfflineAuthorityInput(),
  })
}

function parseStoredSession(
  serialized: string,
  sourceVersion: 1 | 2 | 3 | 4,
): OfflineSessionState | null {
  const parsed: unknown = JSON.parse(serialized)
  if (sourceVersion === 4) {
    return isOfflineSessionState(parsed) ? parsed : null
  }
  if (sourceVersion === 3) return migrateV3OfflineSession(parsed)
  return sourceVersion === 2
    ? migrateV2OfflineSession(parsed)
    : migrateV1OfflineSession(parsed)
}

export function inspectOfflineSession(
  storage: OfflineStorage,
): OfflineSessionInspection {
  for (const [index, key] of offlineStorageKeys.entries()) {
    let serialized: string | null
    try {
      serialized = storage.getItem(key)
    } catch {
      return { status: 'CORRUPT', state: null }
    }
    if (!serialized) continue
    const sourceVersion = (4 - index) as 1 | 2 | 3 | 4
    try {
      const state = parseStoredSession(serialized, sourceVersion)
      if (!state) return { status: 'CORRUPT', state: null, sourceVersion }
      return {
        status: state.phase === 'FINISHED' ? 'FINISHED' : 'ACTIVE',
        state,
        sourceVersion,
      }
    } catch {
      return { status: 'CORRUPT', state: null, sourceVersion }
    }
  }
  return { status: 'NONE', state: null }
}

export function loadOfflineSession(
  storage: OfflineStorage,
): OfflineSessionState | null {
  return inspectOfflineSession(storage).state
}

export function saveOfflineSession(
  storage: OfflineStorage,
  state: OfflineSessionState,
): boolean {
  try {
    storage.setItem(offlineSessionStorageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function clearOfflineSession(storage: OfflineStorage): boolean {
  try {
    for (const key of offlineStorageKeys) {
      if (storage.removeItem) storage.removeItem(key)
      else storage.setItem(key, '')
    }
    return true
  } catch {
    return false
  }
}
