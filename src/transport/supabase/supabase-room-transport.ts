import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { getNightRoleIds } from '../../domain/roles/role-definitions'
import type { ResolvedNightEffect } from '../../domain/gameplay/night-resolution'
import {
  normalizeFactionTransitionState,
  type FactionTransitionState,
} from '../../domain/gameplay/faction-transitions'
import {
  cardAssetUrl,
  classicRoleById,
  type RoleId,
} from '../../domain/roles/classic-catalog'
import {
  expandRoleDeck,
  type RoleComposition,
  type RoomJoinability,
  type RoomSetupInput,
} from '../../domain/game/room-setup'
import type {
  DayEffect,
  DayVoteState,
  JournalEvent,
  NightAction,
  NightCall,
  PersistedNightResolution,
  PersistedWitchCheckpoint,
  NightState,
  Player,
  RoleAssignment,
  RoomCommand,
  RoomLifecycle,
  RoomState,
} from '../../domain/game/types'
import type {
  PlayerRoomSnapshot,
  RoomAudience,
  RoomSnapshot,
} from '../../state/room-projection'
import { createRequestId } from '../../lib/request-id'
import {
  roomTransportErrorCodes,
  type CreateRoomResult,
  type DispatchResult,
  type JoinRoomResult,
  type ResumeRoomResult,
  type RoomTransport,
  type RoomTransportErrorCode,
} from '../room-transport'

interface RemoteRoom {
  id: string
  code: string
  seatCount: number
  status: RoomLifecycle
  phase: RoomState['phase']
  dayNumber: number
  wolfPolicy?: RoomState['config']['wolfPolicy']
  revision: number
  createdAt: string
  updatedAt: string
  lockedAt?: string | null
  startedAt?: string | null
}

interface RemotePlayer {
  id: string
  seat: number
  displayName: string
  revealConfirmed: boolean
  joinedAt: string
  alive?: boolean
}

interface RemoteAssignment {
  playerId: string
  roleId: RoleId
  assignedAt: string
}

interface RemoteModeratorPayload {
  room: RemoteRoom
  roleConfig: RoleComposition
  players: RemotePlayer[]
  assignments: RemoteAssignment[]
}

interface RemoteLookupPayload {
  exists: boolean
  joinable: boolean
  reason: string | null
  roomId?: string
  roomCode?: string
}

interface Subscription {
  roomId: string
  audience: RoomAudience
  listener: (snapshot: RoomSnapshot) => void
}

const serverMessages: Record<string, string> = {
  BACKEND_UNAVAILABLE: 'Không thể kết nối máy chủ phòng. Vui lòng thử lại.',
  UNAUTHORIZED: 'Phiên thiết bị không có quyền truy cập phòng này.',
  ROOM_NOT_FOUND: 'Không tìm thấy phòng với mã này.',
  ROOM_FULL: 'Phòng đã đủ người.',
  ROOM_LOCKED: 'Phòng đã khóa hoặc ván chơi đã bắt đầu.',
  DUPLICATE_NAME: 'Tên này đã có người dùng trong phòng.',
  INVALID_NAME: 'Tên phải có từ 1 đến 20 ký tự sau khi chuẩn hóa.',
  INVALID_ROOM_CONFIG: 'Cấu hình số ghế hoặc bộ vai trò không hợp lệ.',
  INVALID_CREATE_REQUEST: 'Yêu cầu tạo phòng không hợp lệ.',
  NOT_MODERATOR: 'Chỉ Quản trò sở hữu phòng mới được thực hiện thao tác này.',
  ROOM_NOT_READY: 'Phòng chưa đủ điều kiện để thực hiện thao tác này.',
  INVALID_ASSIGNMENT: 'Bộ vai trò không khớp chính xác với người chơi trong phòng.',
  ALREADY_DEALT: 'Vai trò đã được chia; phòng sẽ không chia lại.',
  ROOM_CODE_EXHAUSTED: 'Chưa thể cấp mã phòng. Vui lòng thử lại.',
  SERVER_GAMEPLAY_UNAVAILABLE:
    'MS-1A chỉ đồng bộ vòng đời phòng; thao tác gameplay này chưa có authority máy chủ.',
  NOT_IN_GAME: 'Ván chơi chưa ở trạng thái đang chơi.',
  NOT_NIGHT: 'Thao tác này chỉ hợp lệ trong phase Đêm.',
  ROLE_NOT_CONFIGURED: 'Role này không có trong nghi thức đêm đã cấu hình.',
  CALL_ALREADY_ACTIVE: 'Hãy hoàn tất lượt gọi hiện tại trước.',
  CALL_NOT_ACTIVE: 'Không có lượt gọi phù hợp đang mở.',
  CALL_ALREADY_COMPLETED: 'Hành động này đã được hoàn tất.',
  CALL_HAS_ELIGIBLE_ACTOR: 'Đang có người chơi hợp lệ cần thực hiện hành động.',
  NOT_PLAYER: 'Thiết bị này không có ghế sống hợp lệ trong phòng.',
  WRONG_ROLE: 'Thiết bị này không thuộc lượt hành động hiện tại.',
  PLAYER_DEAD: 'Người chơi đã chết không thể thực hiện hành động.',
  INVALID_TARGET: 'Mục tiêu không hợp lệ cho hành động hiện tại.',
  SAME_PROTECTOR_TARGET: 'Bảo Vệ không thể chọn cùng mục tiêu hai đêm liên tiếp.',
  WOLF_NO_BITE_CAPABLE_MEMBER: 'Không còn Ma Sói sống để tạo mục tiêu tấn công.',
  WOLF_ROUND_NOT_READY: 'Chưa đủ phiếu Ma Sói đã xác nhận.',
  REVOTE_NOT_READY: 'Lượt chọn lại chưa thể phân giải.',
  REVOTE_EXPIRED: 'Lượt chọn lại đã hết thời gian.',
  NIGHT_RESOLUTION_NOT_READY:
    'Hãy hoàn tất lượt gọi Ma Sói và Bảo Vệ đã cấu hình trước khi phân giải.',
}

Object.assign(serverMessages, {
  WITCH_CHECKPOINT_NOT_READY:
    'Hãy hoàn tất các lượt gọi đầu Đêm và phân giải hiệu ứng trước khi mở/chốt Phù Thủy.',
  WITCH_CHECKPOINT_ALREADY_OPEN:
    'Checkpoint Phù Thủy đã mở; không thể mở lại role đầu Đêm.',
  WITCH_DECISION_REQUIRED: 'Phù Thủy còn sống chưa xác nhận quyết định.',
  WITCH_RESURRECTION_UNAVAILABLE: 'Bình cứu không còn khả dụng.',
  WITCH_ATTACKED_CANNOT_RESURRECT:
    'Phù Thủy bị tấn công trong Đêm này nên không thể dùng bình cứu.',
  WITCH_RESURRECTION_TARGET_INVALID:
    'Bình cứu chỉ áp dụng cho nạn nhân tạm thời của chính Đêm này.',
  WITCH_POISON_UNAVAILABLE: 'Bình độc không còn khả dụng.',
  WITCH_POISON_FORBIDDEN_NIGHT_ONE: 'Không được dùng bình độc trong Đêm 1.',
  WITCH_POISON_SELF_TARGET: 'Phù Thủy không thể dùng bình độc lên chính mình.',
  HUNTER_PRELOCK_REQUIRED:
    'Hãy chọn một mục tiêu hoặc Không ai trước khi khóa lựa chọn Thợ Săn.',
  HUNTER_PRELOCK_ALREADY_CONFIRMED:
    'Lựa chọn Thợ Săn của Đêm này đã được khóa.',
  MORNING_NOT_READY:
    'Chỉ có thể công bố buổi sáng sau khi tử vong Đêm đã được chốt ổn định.',
  NOT_DAY: 'Thao tác này chỉ hợp lệ trong phase Ngày.',
  DAY_VOTE_ALREADY_EXISTS: 'Lượt bỏ phiếu của Ngày hiện tại đã được mở hoặc hoàn tất.',
  DAY_VOTE_NOT_OPEN: 'Quản trò chưa mở lượt bỏ phiếu ban ngày.',
  DAY_VOTE_NOT_READY: 'Chưa hết đúng 30 giây bỏ phiếu; không thể chốt sớm.',
  DAY_VOTE_EXPIRED: 'Thời hạn bỏ phiếu ban ngày đã kết thúc.',
  HUNTER_REVENGE_NOT_PENDING: 'Chỉ Thợ Săn vừa bị treo cổ mới có phát bắn trả thù.',
  HUNTER_REVENGE_ALREADY_RESOLVED: 'Phát bắn trả thù đã được giải quyết.',
  DAY_CONSEQUENCE_NOT_READY: 'Phải hoàn tất kết quả treo cổ và phát bắn Thợ Săn trước khi bắt đầu Đêm tiếp theo.',
})

const machineCodes = new Set(Object.keys(serverMessages))

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseTimestamp(value: unknown): number {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function readRemoteRoom(value: unknown): RemoteRoom {
  if (!isRecord(value)) throw new Error('BACKEND_UNAVAILABLE')
  return value as unknown as RemoteRoom
}

function readRemotePlayers(value: unknown): RemotePlayer[] {
  if (!Array.isArray(value)) throw new Error('BACKEND_UNAVAILABLE')
  return value as RemotePlayer[]
}

function readRoleId(value: unknown): RoleId {
  if (typeof value !== 'string' || !(value in classicRoleById)) {
    throw new Error('INVALID_ASSIGNMENT')
  }
  return value as RoleId
}

function readAssignments(value: unknown): RemoteAssignment[] {
  if (!Array.isArray(value)) throw new Error('BACKEND_UNAVAILABLE')
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.playerId !== 'string') {
      throw new Error('INVALID_ASSIGNMENT')
    }
    return {
      playerId: entry.playerId,
      roleId: readRoleId(entry.roleId),
      assignedAt: String(entry.assignedAt ?? ''),
    }
  })
}

function toPlayers(
  players: readonly RemotePlayer[],
  alivePlayerIds?: ReadonlySet<string>,
): Player[] {
  return players.map((player) => ({
    id: player.id,
    seat: player.seat,
    alias: player.displayName,
    alive: alivePlayerIds ? alivePlayerIds.has(player.id) : player.alive ?? true,
  }))
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  return value
}

function readRemotePlayer(value: unknown): Player {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  return {
    id: value.id,
    seat: Number(value.seat),
    alias: String(value.displayName ?? ''),
    alive: value.alive !== false,
  }
}

function readNightAction(value: unknown): NightAction {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const roleId = readRoleId(value.roleId)
  const selections = isRecord(value.selections)
    ? Object.fromEntries(
        Object.entries(value.selections).map(([actorId, targetId]) => [
          actorId,
          typeof targetId === 'string' ? targetId : null,
        ]),
      )
    : {}
  const wolf = isRecord(value.wolf)
    ? {
        round: value.wolf.round === 'REVOTE' ? ('REVOTE' as const) : ('INITIAL' as const),
        initialTiedTargetIds: readStringArray(value.wolf.initialTiedTargetIds ?? []),
        deadlineAt:
          typeof value.wolf.deadlineAt === 'string'
            ? parseTimestamp(value.wolf.deadlineAt)
            : undefined,
      }
    : undefined
  const seer = isRecord(value.seer) && typeof value.seer.targetId === 'string'
    ? {
        targetId: value.seer.targetId,
        result: value.seer.result === 'WOLF' ? ('WOLF' as const) : ('NON_WOLF' as const),
        acknowledged: value.seer.acknowledged === true,
      }
    : undefined
  const witch = isRecord(value.witch)
    ? {
        resurrectionCandidateIds: readStringArray(
          value.witch.resurrectionCandidateIds ?? [],
        ),
        poisonCandidateIds: readStringArray(
          value.witch.poisonCandidateIds ?? [],
        ),
        resurrectionAvailable: value.witch.resurrectionAvailable === true,
        poisonAvailable: value.witch.poisonAvailable === true,
        attackedThisNight: value.witch.attackedThisNight === true,
        decision: isRecord(value.witch.decision)
          ? {
              resurrectionTargetId:
                typeof value.witch.decision.resurrectionTargetId === 'string'
                  ? value.witch.decision.resurrectionTargetId
                  : null,
              poisonTargetId:
                typeof value.witch.decision.poisonTargetId === 'string'
                  ? value.witch.decision.poisonTargetId
                  : null,
            }
          : undefined,
      }
    : undefined
  const result = isRecord(value.result)
    ? {
        targetId: typeof value.result.targetId === 'string' ? value.result.targetId : null,
        random: value.result.random === true,
        reason: String(value.result.reason) as NonNullable<NightAction['result']>['reason'],
      }
    : undefined
  return {
    id: value.id,
    roleId,
    kind:
      value.kind === 'WOLF_VOTE'
        ? 'WOLF_VOTE'
        : value.kind === 'HUNTER_PRELOCK'
          ? 'HUNTER_PRELOCK'
        : value.kind === 'WITCH_DECISION'
          ? 'WITCH_DECISION'
          : 'SELECT_TARGET',
    status:
      value.status === 'OPEN'
        ? 'OPEN'
        : value.status === 'CLOSED_BY_MODERATOR'
          ? 'CLOSED_BY_MODERATOR'
          : 'COMPLETED',
    eligibleActorIds: readStringArray(value.eligibleActorIds ?? []),
    eligibleTargetIds: readStringArray(value.eligibleTargetIds ?? []),
    selections,
    confirmedActorIds: readStringArray(value.confirmedActorIds ?? []),
    wolf,
    seer,
    witch,
    result,
    openedAt: parseTimestamp(value.openedAt),
    completedAt:
      typeof value.completedAt === 'string'
        ? parseTimestamp(value.completedAt)
        : undefined,
  }
}

function readRemoteNight(value: unknown): { night: NightState; events: JournalEvent[] } {
  if (!isRecord(value) || !Array.isArray(value.calls) || !isRecord(value.actionsByRole)) {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const calls: NightCall[] = value.calls.map((entry) => {
    if (!isRecord(entry)) throw new Error('BACKEND_UNAVAILABLE')
    return {
      roleId: readRoleId(entry.roleId),
      status:
        entry.status === 'COMPLETED'
          ? 'COMPLETED'
          : entry.status === 'CALLED'
            ? 'CALLED'
            : 'NOT_CALLED',
      calledAt:
        typeof entry.calledAt === 'string' ? parseTimestamp(entry.calledAt) : undefined,
      completedAt:
        typeof entry.completedAt === 'string'
          ? parseTimestamp(entry.completedAt)
          : undefined,
    }
  })
  const actionsByRole: NightState['actionsByRole'] = {}
  for (const [roleIdValue, actionValue] of Object.entries(value.actionsByRole)) {
    const roleId = readRoleId(roleIdValue)
    if (actionValue !== null) actionsByRole[roleId] = readNightAction(actionValue)
  }
  const events: JournalEvent[] = Array.isArray(value.events)
    ? value.events.map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== 'string') {
          throw new Error('BACKEND_UNAVAILABLE')
        }
        return {
          id: entry.id,
          type: String(entry.type) as JournalEvent['type'],
          timestamp: parseTimestamp(entry.timestamp),
          dayNumber: Number(entry.dayNumber),
          phase: 'NIGHT',
          actorPlayerId:
            typeof entry.actorPlayerId === 'string' ? entry.actorPlayerId : undefined,
          actorRoleId:
            typeof entry.actorRoleId === 'string'
              ? readRoleId(entry.actorRoleId)
              : undefined,
          targetPlayerId:
            typeof entry.targetPlayerId === 'string' ? entry.targetPlayerId : undefined,
          resolution:
            typeof entry.resolution === 'string' ? entry.resolution : undefined,
          metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
        }
      })
    : []
  return {
    night: {
      number: Number(value.number),
      calls,
      activeRoleId:
        typeof value.activeRoleId === 'string'
          ? readRoleId(value.activeRoleId)
          : null,
      actionsByRole,
    },
    events,
  }
}

function readNightResolution(value: unknown): PersistedNightResolution | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Array.isArray(value.effects)
  ) {
    throw new Error('BACKEND_UNAVAILABLE')
  }

  const effects = value.effects.map((entry): ResolvedNightEffect => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.sourceType !== 'string' ||
      typeof entry.targetPlayerId !== 'string' ||
      (entry.category !== 'HOSTILE_VILLAIN_ATTACK' &&
        entry.category !== 'NON_VILLAIN_LETHAL_EFFECT') ||
      (entry.outcome !== 'BLOCKED_BY_PROTECTOR' &&
        entry.outcome !== 'UNBLOCKED' &&
        entry.outcome !== 'HALF_WOLF_BITE_SCHEDULED')
    ) {
      throw new Error('BACKEND_UNAVAILABLE')
    }
    return {
      id: entry.id,
      sourceType: entry.sourceType,
      sourceRoleId:
        typeof entry.sourceRoleId === 'string'
          ? readRoleId(entry.sourceRoleId)
          : undefined,
      category: entry.category,
      targetPlayerId: entry.targetPlayerId,
      lethal: entry.lethal === true,
      protectorBlockable: entry.protectorBlockable === true,
      outcome: entry.outcome,
      conversion:
        isRecord(entry.conversion) &&
        entry.conversion.kind === 'HALF_WOLF_TRANSFORMATION' &&
        Number.isInteger(entry.conversion.dueNightNumber)
          ? {
              kind: 'HALF_WOLF_TRANSFORMATION' as const,
              dueNightNumber: Number(entry.conversion.dueNightNumber),
            }
          : undefined,
      blockSourceType:
        entry.blockSourceType === 'PROTECTOR_SHIELD'
          ? ('PROTECTOR_SHIELD' as const)
          : undefined,
      blockSourceRoleId:
        entry.blockSourceRoleId === 'protector'
          ? ('protector' as const)
          : undefined,
      activationCondition:
        isRecord(entry.activationCondition) &&
        entry.activationCondition.kind ===
          'SOURCE_PLAYER_FINAL_NIGHT_DEATH' &&
        typeof entry.activationCondition.sourcePlayerId === 'string'
          ? {
              kind: 'SOURCE_PLAYER_FINAL_NIGHT_DEATH' as const,
              sourcePlayerId: entry.activationCondition.sourcePlayerId,
            }
          : undefined,
      activationStatus:
        entry.activationStatus === 'CONDITIONAL' ||
        entry.activationStatus === 'ACTIVATED' ||
        entry.activationStatus === 'CANCELED_SOURCE_SURVIVED'
          ? entry.activationStatus
          : undefined,
    }
  })
  const outcome =
    value.outcome === 'NO_ATTACK' ||
    value.outcome === 'BLOCKED' ||
    value.outcome === 'UNBLOCKED' ||
    value.outcome === 'BITE_SCHEDULED'
      ? value.outcome
      : null
  if (!outcome) throw new Error('BACKEND_UNAVAILABLE')

  return {
    id: value.id,
    nightNumber: Number(value.nightNumber),
    outcome,
    effects,
    provisionalDeathCandidateIds: readStringArray(
      value.provisionalDeathCandidateIds ?? [],
    ),
    resolvedAt: parseTimestamp(value.resolvedAt),
  }
}

function readFactionTransitions(
  value: unknown,
  assignments: readonly RoleAssignment[],
): FactionTransitionState {
  const normalized = normalizeFactionTransitionState(assignments)
  if (value === null || value === undefined) return normalized
  if (!isRecord(value)) throw new Error('BACKEND_UNAVAILABLE')

  if (isRecord(value.halfWolves)) {
    for (const [playerId, raw] of Object.entries(value.halfWolves)) {
      if (!isRecord(raw) || raw.playerId !== playerId) {
        throw new Error('BACKEND_UNAVAILABLE')
      }
      const status = raw.status
      if (
        status !== 'VILLAGE' &&
        status !== 'PENDING_TRANSFORMATION' &&
        status !== 'TRANSFORMED' &&
        status !== 'CANCELED'
      ) {
        throw new Error('BACKEND_UNAVAILABLE')
      }
      normalized.halfWolves[playerId] = {
        playerId,
        status,
        bittenNightNumber:
          typeof raw.bittenNightNumber === 'number'
            ? raw.bittenNightNumber
            : undefined,
        transformDueNightNumber:
          typeof raw.transformDueNightNumber === 'number'
            ? raw.transformDueNightNumber
            : undefined,
        bittenAt: raw.bittenAt ? parseTimestamp(raw.bittenAt) : undefined,
        transformedAt: raw.transformedAt
          ? parseTimestamp(raw.transformedAt)
          : undefined,
        canceledAt: raw.canceledAt
          ? parseTimestamp(raw.canceledAt)
          : undefined,
        cancellationReason:
          raw.cancellationReason === 'DIED_BEFORE_TRANSFORMATION'
            ? 'DIED_BEFORE_TRANSFORMATION'
            : undefined,
      }
    }
  }

  if (isRecord(value.traitors)) {
    for (const [playerId, raw] of Object.entries(value.traitors)) {
      if (!isRecord(raw) || raw.playerId !== playerId) {
        throw new Error('BACKEND_UNAVAILABLE')
      }
      if (
        raw.status !== 'WOLF_ALIGNED' &&
        raw.status !== 'CONVERTED_VILLAGE'
      ) {
        throw new Error('BACKEND_UNAVAILABLE')
      }
      normalized.traitors[playerId] = {
        playerId,
        status: raw.status,
        convertedAt: raw.convertedAt
          ? parseTimestamp(raw.convertedAt)
          : undefined,
        conversionReason:
          raw.conversionReason === 'NO_LIVING_BITE_CAPABLE_WOLF'
            ? 'NO_LIVING_BITE_CAPABLE_WOLF'
            : undefined,
      }
    }
  }
  return normalized
}

function readWitchCheckpoint(value: unknown): PersistedWitchCheckpoint | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Array.isArray(value.rescuedPlayerIds) ||
    !Array.isArray(value.finalDeaths)
  ) {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const decision = isRecord(value.decision)
    ? {
        resurrectionTargetId:
          typeof value.decision.resurrectionTargetId === 'string'
            ? value.decision.resurrectionTargetId
            : null,
        poisonTargetId:
          typeof value.decision.poisonTargetId === 'string'
            ? value.decision.poisonTargetId
            : null,
      }
    : { resurrectionTargetId: null, poisonTargetId: null }
  const poisonEffectValue = value.poisonEffect
  let poisonEffect: PersistedWitchCheckpoint['poisonEffect'] = null
  if (isRecord(poisonEffectValue)) {
    if (
      typeof poisonEffectValue.id !== 'string' ||
      poisonEffectValue.sourceType !== 'WITCH_POISON' ||
      poisonEffectValue.sourceRoleId !== 'witch' ||
      poisonEffectValue.category !== 'NON_VILLAIN_LETHAL_EFFECT' ||
      typeof poisonEffectValue.targetPlayerId !== 'string' ||
      poisonEffectValue.lethal !== true ||
      poisonEffectValue.protectorBlockable !== false ||
      poisonEffectValue.outcome !== 'UNBLOCKED'
    ) {
      throw new Error('BACKEND_UNAVAILABLE')
    }
    poisonEffect = {
        id: String(poisonEffectValue.id),
        sourceType: 'WITCH_POISON',
        sourceRoleId: 'witch' as const,
        category: 'NON_VILLAIN_LETHAL_EFFECT' as const,
        targetPlayerId: String(poisonEffectValue.targetPlayerId),
        lethal: true,
        protectorBlockable: false,
        outcome: 'UNBLOCKED' as const,
      }
  }
  const resourcesValue = value.resourcesAfter
  const resourcesAfter = isRecord(resourcesValue)
    ? {
        witchPlayerId: String(resourcesValue.witchPlayerId),
        resurrectionAvailable:
          resourcesValue.resurrectionAvailable === true,
        poisonAvailable: resourcesValue.poisonAvailable === true,
      }
    : null

  return {
    id: value.id,
    nightNumber: Number(value.nightNumber),
    finalizedAt: parseTimestamp(value.finalizedAt),
    decision,
    rescuedPlayerIds: readStringArray(value.rescuedPlayerIds),
    poisonEffect,
    conditionalEffectStates: Array.isArray(value.conditionalEffectStates)
      ? value.conditionalEffectStates.map((entry) => {
          if (
            !isRecord(entry) ||
            typeof entry.effectId !== 'string' ||
            (entry.status !== 'ACTIVATED' &&
              entry.status !== 'CANCELED_SOURCE_SURVIVED')
          ) {
            throw new Error('BACKEND_UNAVAILABLE')
          }
          return { effectId: entry.effectId, status: entry.status }
        })
      : [],
    finalDeaths: value.finalDeaths.map((death) => {
      if (!isRecord(death) || typeof death.playerId !== 'string') {
        throw new Error('BACKEND_UNAVAILABLE')
      }
      return {
        playerId: death.playerId,
        sourceEffectIds: readStringArray(death.sourceEffectIds ?? []),
      }
    }),
    resourcesAfter,
  }
}

function readPlayerNightAction(value: unknown): PlayerRoomSnapshot['nightAction'] {
  if (value === null || value === undefined) return undefined
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(readRemotePlayer)
    : []
  return {
    id: value.id,
    kind:
      value.kind === 'WOLF_VOTE'
        ? 'WOLF_VOTE'
        : value.kind === 'HUNTER_PRELOCK'
          ? 'HUNTER_PRELOCK'
        : value.kind === 'WITCH_DECISION'
          ? 'WITCH_DECISION'
          : 'SELECT_TARGET',
    roleId: readRoleId(value.roleId),
    roleName: String(value.roleName ?? ''),
    instructions: String(value.instructions ?? ''),
    round: value.round === 'REVOTE' ? 'REVOTE' : value.round === 'INITIAL' ? 'INITIAL' : undefined,
    deadlineAt:
      typeof value.deadlineAt === 'string' ? parseTimestamp(value.deadlineAt) : undefined,
    candidates,
    currentTargetId:
      typeof value.currentTargetId === 'string' ? value.currentTargetId : null,
    hasSelected: value.hasSelected === true,
    mode:
      value.mode === 'WOLF_REVOTE' ||
      value.mode === 'SEER_SELECT' ||
      value.mode === 'SEER_RESULT' ||
      value.mode === 'PROTECTOR_SELECT' ||
      value.mode === 'HUNTER_PRELOCK' ||
      value.mode === 'WITCH_DECISION'
        ? value.mode
        : 'WOLF_BALLOT',
    inspectedTarget: isRecord(value.inspectedTarget)
      ? readRemotePlayer(value.inspectedTarget)
      : undefined,
    seerResult:
      value.seerResult === 'WOLF'
        ? 'WOLF'
        : value.seerResult === 'NON_WOLF'
          ? 'NON_WOLF'
          : undefined,
    resurrectionCandidates: Array.isArray(value.resurrectionCandidates)
      ? value.resurrectionCandidates.map(readRemotePlayer)
      : undefined,
    poisonCandidates: Array.isArray(value.poisonCandidates)
      ? value.poisonCandidates.map(readRemotePlayer)
      : undefined,
    resurrectionAvailable: value.resurrectionAvailable === true,
    poisonAvailable: value.poisonAvailable === true,
    witchAttackedThisNight: value.witchAttackedThisNight === true,
  }
}

function readDayEffect(value: unknown): DayEffect | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.targetPlayerId !== 'string' ||
    (value.sourceType !== 'DAY_HANGING' &&
      value.sourceType !== 'HUNTER_REVENGE_SHOT')
  ) {
    return undefined
  }
  return {
    id: value.id,
    sourceType: value.sourceType,
    sourceRoleId:
      value.sourceType === 'HUNTER_REVENGE_SHOT' ? 'hunter' : undefined,
    actorPlayerId:
      typeof value.actorPlayerId === 'string' ? value.actorPlayerId : undefined,
    category:
      value.sourceType === 'DAY_HANGING'
        ? 'DAY_LETHAL_EFFECT'
        : 'NON_VILLAIN_LETHAL_EFFECT',
    targetPlayerId: value.targetPlayerId,
    lethal: true,
    protectorBlockable: false,
    finalized: true,
  }
}

function readModeratorDayVote(value: unknown): DayVoteState | null {
  if (value === null || value === undefined) return null
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.status !== 'OPEN' && value.status !== 'RESOLVED')
  ) {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const totals = isRecord(value.totals)
    ? Object.fromEntries(
        Object.entries(value.totals).map(([playerId, count]) => [
          playerId,
          Number(count),
        ]),
      )
    : {}
  const resultValue = isRecord(value.result) ? value.result : undefined
  const hangedPlayerId =
    resultValue && typeof resultValue.hangedPlayerId === 'string'
      ? resultValue.hangedPlayerId
      : undefined
  const kind =
    resultValue?.kind === 'UNIQUE'
      ? ('UNIQUE' as const)
      : resultValue?.kind === 'TIE'
        ? ('TIE' as const)
        : ('NO_VOTES' as const)
  const revengeValue = isRecord(value.hunterRevenge)
    ? value.hunterRevenge
    : undefined
  return {
    status: value.status === 'OPEN' ? 'OPEN' : 'CLOSED',
    votes: {},
    openedAt: parseTimestamp(value.openedAt),
    deadlineAt: parseTimestamp(value.deadlineAt),
    closedAt:
      typeof value.resolvedAt === 'string'
        ? parseTimestamp(value.resolvedAt)
        : undefined,
    totals,
    result:
      value.status === 'RESOLVED'
        ? {
            kind,
            targetIds: hangedPlayerId ? [hangedPlayerId] : [],
            counts: totals,
          }
        : undefined,
    hangingEffect: readDayEffect(value.hangingEffect),
    hunterRevenge:
      revengeValue && typeof revengeValue.hunterPlayerId === 'string'
        ? {
            hunterPlayerId: revengeValue.hunterPlayerId,
            status:
              revengeValue.status === 'RESOLVED' ? 'RESOLVED' : 'PENDING',
            targetPlayerId:
              revengeValue.status === 'RESOLVED'
                ? typeof revengeValue.targetPlayerId === 'string'
                  ? revengeValue.targetPlayerId
                  : null
                : undefined,
            resolvedAt:
              typeof revengeValue.resolvedAt === 'string'
                ? parseTimestamp(revengeValue.resolvedAt)
                : undefined,
            effect: readDayEffect(revengeValue.effect),
          }
        : undefined,
  }
}

function readPlayerDayVote(value: unknown): PlayerRoomSnapshot['dayVote'] {
  if (value === null || value === undefined) return undefined
  if (
    !isRecord(value) ||
    (value.status !== 'OPEN' && value.status !== 'RESOLVED')
  ) {
    throw new Error('BACKEND_UNAVAILABLE')
  }
  const totals = isRecord(value.totals)
    ? Object.fromEntries(
        Object.entries(value.totals).map(([playerId, count]) => [
          playerId,
          Number(count),
        ]),
      )
    : {}
  const resultValue = isRecord(value.result) ? value.result : undefined
  const revengeAction = isRecord(value.hunterRevengeAction)
    ? value.hunterRevengeAction
    : undefined
  return {
    status: value.status === 'OPEN' ? 'OPEN' : 'CLOSED',
    candidates: Array.isArray(value.candidates)
      ? value.candidates.map(readRemotePlayer)
      : [],
    currentTargetId:
      typeof value.currentTargetId === 'string' ? value.currentTargetId : null,
    openedAt: parseTimestamp(value.openedAt),
    deadlineAt: parseTimestamp(value.deadlineAt),
    totals,
    result: resultValue
      ? {
          kind:
            resultValue.kind === 'UNIQUE'
              ? 'UNIQUE'
              : resultValue.kind === 'TIE'
                ? 'TIE'
                : 'NO_VOTES',
          hangedPlayer: isRecord(resultValue.hangedPlayer)
            ? readRemotePlayer(resultValue.hangedPlayer)
            : undefined,
          hunterRevealed: resultValue.hunterRevealed === true,
          hunterRevengeStatus:
            resultValue.hunterRevengeStatus === 'PENDING' ||
            resultValue.hunterRevengeStatus === 'RESOLVED'
              ? resultValue.hunterRevengeStatus
              : undefined,
          hunterRevengeTarget: isRecord(resultValue.hunterRevengeTarget)
            ? readRemotePlayer(resultValue.hunterRevengeTarget)
            : resultValue.hunterRevengeStatus === 'RESOLVED'
              ? null
              : undefined,
        }
      : undefined,
    hunterRevengeAction: revengeAction
      ? {
          candidates: Array.isArray(revengeAction.candidates)
            ? revengeAction.candidates.map(readRemotePlayer)
            : [],
        }
      : undefined,
  }
}

function lifecycleJournal(payload: RemoteModeratorPayload): JournalEvent[] {
  const events: JournalEvent[] = [
    {
      id: `server-room-${payload.room.id}`,
      type: 'ROOM_CREATED',
      timestamp: parseTimestamp(payload.room.createdAt),
      dayNumber: 1,
      phase: 'SETUP',
      metadata: {
        roomCode: payload.room.code,
        seatCount: payload.room.seatCount,
        serverAuthority: true,
      },
    },
  ]
  for (const player of payload.players) {
    events.push({
      id: `server-player-${player.id}`,
      type: 'PLAYER_JOINED',
      timestamp: parseTimestamp(player.joinedAt),
      dayNumber: 1,
      phase: 'SETUP',
      actorPlayerId: player.id,
      metadata: { seat: player.seat, displayName: player.displayName },
    })
  }
  if (payload.room.lockedAt) {
    events.push({
      id: `server-lock-${payload.room.id}`,
      type: 'ROOM_LOCKED',
      timestamp: parseTimestamp(payload.room.lockedAt),
      dayNumber: 1,
      phase: 'SETUP',
      metadata: { assignedCount: payload.assignments.length },
    })
  }
  for (const assignment of payload.assignments) {
    events.push({
      id: `server-assignment-${assignment.playerId}`,
      type: 'ROLE_ASSIGNED',
      timestamp: parseTimestamp(assignment.assignedAt),
      dayNumber: 1,
      phase: 'SETUP',
      actorPlayerId: assignment.playerId,
      actorRoleId: assignment.roleId,
    })
  }
  if (payload.room.startedAt) {
    events.push({
      id: `server-start-${payload.room.id}`,
      type: 'PHASE_CHANGED',
      timestamp: parseTimestamp(payload.room.startedAt),
      dayNumber: 1,
      phase: 'NIGHT',
      resolution: 'NIGHT',
      metadata: { from: 'SETUP', to: 'NIGHT', serverAuthority: true },
    })
  }
  return events.sort((left, right) => left.timestamp - right.timestamp)
}

export function moderatorSnapshotFromPayload(value: unknown): RoomSnapshot {
  if (!isRecord(value)) throw new Error('BACKEND_UNAVAILABLE')
  const room = readRemoteRoom(value.room)
  if (!isRecord(value.roleConfig)) throw new Error('INVALID_ROOM_CONFIG')
  const roleComposition = value.roleConfig as RoleComposition
  for (const roleId of Object.keys(roleComposition)) readRoleId(roleId)
  const alivePlayerIds = Array.isArray(value.alivePlayerIds)
    ? new Set(readStringArray(value.alivePlayerIds))
    : undefined
  const players = readRemotePlayers(value.players)
  const assignments = readAssignments(value.assignments)
  const payload: RemoteModeratorPayload = {
    room,
    roleConfig: roleComposition,
    players,
    assignments,
  }
  const roleIds = expandRoleDeck(roleComposition)
  const witchCheckpoint = readWitchCheckpoint(value.witchCheckpoint)
  const state: RoomState = {
    schemaVersion: 2,
    roomId: room.id,
    roomCode: room.code,
    revision: room.revision,
    createdAt: parseTimestamp(room.createdAt),
    lifecycle: room.status,
    phase: room.phase,
    dayNumber: room.dayNumber,
    players: toPlayers(players, alivePlayerIds),
    roleAssignments: assignments.map(
      (assignment): RoleAssignment => ({
        playerId: assignment.playerId,
        roleId: assignment.roleId,
      }),
    ),
    roleRevealConfirmedPlayerIds: players
      .filter((player) => player.revealConfirmed)
      .map((player) => player.id),
    config: {
      seatCount: room.seatCount,
      roleComposition,
      wolfPolicy: room.wolfPolicy ?? 'RANDOM_ON_TIE',
      nightRoleIds: getNightRoleIds(roleIds),
      revoteDurationMs: 10_000,
    },
    night:
      room.phase === 'NIGHT'
        ? value.night
          ? readRemoteNight(value.night).night
          : {
              number: room.dayNumber,
              calls: getNightRoleIds(roleIds).map((roleId) => ({
                roleId,
                status: 'NOT_CALLED',
              })),
              activeRoleId: null,
              actionsByRole: {},
            }
        : null,
    nightResolution: readNightResolution(value.nightResolution),
    witchResources: witchCheckpoint?.resourcesAfter ?? null,
    witchCheckpoint,
    dayVote: readModeratorDayVote(value.dayVote),
    factionTransitions: readFactionTransitions(
      value.factionTransitions,
      assignments.map(
        (assignment): RoleAssignment => ({
          playerId: assignment.playerId,
          roleId: assignment.roleId,
        }),
      ),
    ),
    journal: [
      ...lifecycleJournal(payload),
      ...(value.night ? readRemoteNight(value.night).events : []),
    ],
  }
  return { audience: 'MODERATOR', state }
}

export function playerSnapshotFromPayload(value: unknown): PlayerRoomSnapshot {
  if (!isRecord(value)) throw new Error('BACKEND_UNAVAILABLE')
  const room = readRemoteRoom(value.room)
  if (!isRecord(value.self)) throw new Error('UNAUTHORIZED')
  const selfRemote = value.self as unknown as RemotePlayer
  const alivePlayerIds = Array.isArray(value.alivePlayerIds)
    ? new Set(readStringArray(value.alivePlayerIds))
    : undefined
  const players = toPlayers(readRemotePlayers(value.players), alivePlayerIds)
  const self = players.find((player) => player.id === selfRemote.id)
  if (!self) throw new Error('UNAUTHORIZED')
  const assignment = value.assignment
  const roleId =
    assignment === null || assignment === undefined
      ? undefined
      : readRoleId(isRecord(assignment) ? assignment.roleId : undefined)
  const role = roleId ? classicRoleById[roleId] : undefined
  return {
    audience: 'PLAYER',
    revision: room.revision,
    roomId: room.id,
    roomCode: room.code,
    lifecycle: room.status,
    seatCount: room.seatCount,
    phase: room.phase,
    dayNumber: room.dayNumber,
    self,
    players,
    roleIdentity: role
      ? {
          roleId: role.id,
          displayName: role.displayName,
          factionMeaning: role.factionMeaning,
          rulesText: role.rulesText,
          cardAsset: cardAssetUrl(role.assetFiles[0]),
        }
      : undefined,
    roleRevealPending:
      room.status === 'ROLE_REVEAL' && Boolean(role) && !selfRemote.revealConfirmed,
    nightAction: readPlayerNightAction(value.nightAction),
    dayVote: readPlayerDayVote(value.dayVote),
  }
}

function errorMachineCode(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === 'string'
        ? error.message
        : ''
  return machineCodes.has(message) ? message : 'BACKEND_UNAVAILABLE'
}

function errorCode(machineCode: string): RoomTransportErrorCode {
  const matching = Object.values(roomTransportErrorCodes).find(
    (code) => code === machineCode,
  )
  return matching ?? roomTransportErrorCodes.backendUnavailable
}

function failure(error: unknown): DispatchResult & { ok: false } {
  const machineCode = errorMachineCode(error)
  return {
    ok: false,
    errorCode: errorCode(machineCode),
    error: serverMessages[machineCode] ?? serverMessages.BACKEND_UNAVAILABLE,
  }
}

export class SupabaseRoomTransport implements RoomTransport {
  readonly kind = 'SUPABASE' as const
  private authPromise: Promise<string> | null = null
  private readonly subscriptions = new Set<Subscription>()
  private readonly channels = new Set<RealtimeChannel>()

  constructor(private readonly client: SupabaseClient) {}

  async createRoom(
    setup: RoomSetupInput,
    requestId?: string,
  ): Promise<CreateRoomResult> {
    try {
      const resolvedRequestId = requestId ?? createRequestId()
      await this.ensureAnonymousIdentity()
      const { data, error } = await this.client.rpc('ms1a_create_room', {
        p_request_id: resolvedRequestId,
        p_seat_count: setup.seatCount,
        p_role_config: setup.roleComposition,
        p_wolf_policy: setup.wolfPolicy,
      })
      if (error) throw error
      const snapshot = moderatorSnapshotFromPayload(data)
      if (snapshot.audience !== 'MODERATOR') throw new Error('BACKEND_UNAVAILABLE')
      return {
        ok: true,
        roomId: snapshot.state.roomId,
        roomCode: snapshot.state.roomCode,
      }
    } catch (error) {
      return failure(error)
    }
  }

  async validateRoomCode(code: string): Promise<RoomJoinability> {
    try {
      await this.ensureAnonymousIdentity()
      const { data, error } = await this.client.rpc('ms1a_lookup_room', {
        p_code: code.trim(),
      })
      if (error) throw error
      if (!isRecord(data)) throw new Error('BACKEND_UNAVAILABLE')
      const lookup = data as unknown as RemoteLookupPayload
      if (lookup.joinable && lookup.roomId && lookup.roomCode) {
        return {
          joinable: true,
          roomId: lookup.roomId,
          roomCode: lookup.roomCode,
        }
      }
      const reason = lookup.reason
      if (reason === 'ROOM_FULL') {
        return { joinable: false, reason: 'ROOM_FULL', message: serverMessages.ROOM_FULL }
      }
      if (reason === 'ROOM_LOCKED') {
        return {
          joinable: false,
          reason: 'ROOM_STARTED',
          message: serverMessages.ROOM_LOCKED,
        }
      }
      return {
        joinable: false,
        reason: 'NOT_FOUND',
        message: serverMessages.ROOM_NOT_FOUND,
      }
    } catch (error) {
      const result = failure(error)
      return {
        joinable: false,
        reason: 'BACKEND_UNAVAILABLE',
        message: result.error ?? serverMessages.BACKEND_UNAVAILABLE,
      }
    }
  }

  async joinRoom(code: string, name: string): Promise<JoinRoomResult> {
    try {
      await this.ensureAnonymousIdentity()
      const { data, error } = await this.client.rpc('ms1a_join_room', {
        p_code: code.trim(),
        p_display_name: name,
      })
      if (error) throw error
      const snapshot = playerSnapshotFromPayload(data)
      return {
        ok: true,
        roomId: snapshot.roomId,
        roomCode: snapshot.roomCode,
        playerId: snapshot.self.id,
      }
    } catch (error) {
      return failure(error)
    }
  }

  async resumeCurrentRoom(): Promise<ResumeRoomResult | null> {
    await this.ensureAnonymousIdentity()
    const { data, error } = await this.client.rpc('ms1a_resume_current_room')
    if (error) throw new Error(errorMachineCode(error))
    if (data === null) return null
    if (!isRecord(data)) throw new Error('BACKEND_UNAVAILABLE')
    return data as unknown as ResumeRoomResult
  }

  async getSnapshot(
    roomId: string,
    audience: RoomAudience,
  ): Promise<RoomSnapshot> {
    await this.ensureAnonymousIdentity()
    const functionName =
      audience.kind === 'MODERATOR'
        ? 'ms1a_get_moderator_room'
        : 'ms1a_get_player_room'
    const { data, error } = await this.client.rpc(functionName, {
      p_room_id: roomId,
    })
    if (error) {
      const result = failure(error)
      throw new Error(result.error)
    }
    if (audience.kind === 'MODERATOR') return moderatorSnapshotFromPayload(data)
    const snapshot = playerSnapshotFromPayload(data)
    if (snapshot.self.id !== audience.playerId) {
      throw new Error(serverMessages.UNAUTHORIZED)
    }
    return snapshot
  }

  subscribe(
    roomId: string,
    audience: RoomAudience,
    listener: (snapshot: RoomSnapshot) => void,
  ): () => void {
    const subscription = { roomId, audience, listener }
    this.subscriptions.add(subscription)
    let active = true
    let channel: RealtimeChannel | null = null
    void this.ensureAnonymousIdentity().then(() => {
      if (!active) return
      const refresh = () => void this.refreshSubscription(subscription)
      channel = this.client
        .channel(`room:${roomId}`, { config: { private: true } })
        .on(
          'broadcast',
          { event: 'room_changed' },
          refresh,
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') refresh()
        })
      this.channels.add(channel)
    })

    return () => {
      active = false
      this.subscriptions.delete(subscription)
      if (channel) {
        this.channels.delete(channel)
        void this.client.removeChannel(channel)
      }
    }
  }

  async dispatch(roomId: string, command: RoomCommand): Promise<DispatchResult> {
    try {
      await this.ensureAnonymousIdentity()
      let functionName: string
      if (command.type === 'LOCK_AND_ASSIGN_ROLES') {
        functionName = 'ms1a_lock_and_assign_roles'
      } else if (command.type === 'CONFIRM_ROLE_REVEAL') {
        functionName = 'ms1a_confirm_role_reveal'
      } else if (command.type === 'START_NIGHT') {
        functionName = 'ms1a_start_room'
      } else if (command.type === 'CALL_NIGHT_ROLE') {
        functionName =
          command.roleId === 'witch'
            ? 'ms1c_open_witch_call'
            : command.roleId === 'hunter'
              ? 'ms1d1_open_hunter_call'
            : 'ms1b1_open_night_role_call'
      } else if (command.type === 'CAST_WOLF_VOTE') {
        functionName = 'ms1b1_submit_wolf_ballot'
      } else if (command.type === 'CONFIRM_NIGHT_ACTION') {
        functionName = 'ms1b1_confirm_wolf_ballot'
      } else if (command.type === 'RESOLVE_WOLF_VOTE') {
        functionName = 'ms1b1_finalize_wolf_round'
      } else if (command.type === 'COMPLETE_NIGHT_CALL') {
        functionName = 'ms1b1_complete_empty_night_role_call'
      } else if (command.type === 'SUBMIT_SEER_INSPECTION') {
        functionName = 'ms1b1_submit_seer_inspection'
      } else if (command.type === 'ACKNOWLEDGE_SEER_RESULT') {
        functionName = 'ms1b1_acknowledge_seer_result'
      } else if (command.type === 'SUBMIT_PROTECTOR_TARGET') {
        functionName = 'ms1b1_submit_protector_target'
      } else if (command.type === 'CAST_HUNTER_PRELOCK') {
        functionName = 'ms1d1_submit_hunter_prelock'
      } else if (command.type === 'CONFIRM_HUNTER_PRELOCK') {
        functionName = 'ms1d1_confirm_hunter_prelock'
      } else if (command.type === 'RESOLVE_NIGHT_EFFECTS') {
        functionName = 'ms1b2_resolve_night_effects'
      } else if (command.type === 'SUBMIT_WITCH_DECISION') {
        functionName = 'ms1c_submit_witch_decision'
      } else if (command.type === 'FINALIZE_NIGHT_CHECKPOINT') {
        functionName = 'ms1c_finalize_night_checkpoint'
      } else if (command.type === 'START_DAY') {
        functionName = 'ms1d1_start_morning'
      } else if (command.type === 'OPEN_DAY_VOTE') {
        functionName = 'ms1d2_start_day_vote'
      } else if (command.type === 'CAST_DAY_VOTE') {
        functionName = 'ms1d2_cast_day_vote'
      } else if (command.type === 'CLOSE_DAY_VOTE') {
        functionName = 'ms1d2_resolve_day_vote'
      } else if (command.type === 'SUBMIT_HUNTER_REVENGE') {
        functionName = 'ms1d2_submit_hunter_revenge'
      } else if (command.type === 'START_NEXT_NIGHT') {
        functionName = 'ms1d2_start_next_night'
      } else {
        return failure(new Error('SERVER_GAMEPLAY_UNAVAILABLE'))
      }
      const args: Record<string, unknown> = { p_room_id: roomId }
      if (
        (command.type === 'CALL_NIGHT_ROLE' &&
          command.roleId !== 'witch' &&
          command.roleId !== 'hunter') ||
        command.type === 'COMPLETE_NIGHT_CALL'
      ) {
        args.p_role_id = command.roleId
      }
      if (command.type === 'SUBMIT_WITCH_DECISION') {
        args.p_resurrection_target_id = command.resurrectionTargetId
        args.p_poison_target_id = command.poisonTargetId
      }
      if (
        command.type === 'CAST_WOLF_VOTE' ||
        command.type === 'SUBMIT_SEER_INSPECTION' ||
        command.type === 'SUBMIT_PROTECTOR_TARGET' ||
        command.type === 'CAST_HUNTER_PRELOCK' ||
        command.type === 'CAST_DAY_VOTE' ||
        command.type === 'SUBMIT_HUNTER_REVENGE'
      ) {
        args.p_target_player_id = command.targetId
      }
      const { error } = await this.client.rpc(functionName, args)
      if (error) throw error
      await this.refreshRoom(roomId)
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  }

  dispose(): void {
    this.subscriptions.clear()
    for (const channel of this.channels) void this.client.removeChannel(channel)
    this.channels.clear()
  }

  private async ensureAnonymousIdentity(): Promise<string> {
    if (this.authPromise) return this.authPromise
    this.authPromise = (async () => {
      const { data, error } = await this.client.auth.getSession()
      if (error) throw error
      if (data.session?.user.id) return data.session.user.id
      const signIn = await this.client.auth.signInAnonymously()
      if (signIn.error || !signIn.data.user?.id) {
        throw signIn.error ?? new Error('BACKEND_UNAVAILABLE')
      }
      return signIn.data.user.id
    })()
    try {
      return await this.authPromise
    } catch (error) {
      this.authPromise = null
      throw error
    }
  }

  private async refreshSubscription(subscription: Subscription): Promise<void> {
    if (!this.subscriptions.has(subscription)) return
    try {
      const snapshot = await this.getSnapshot(
        subscription.roomId,
        subscription.audience,
      )
      if (this.subscriptions.has(subscription)) subscription.listener(snapshot)
    } catch {
      // useRoom owns visible fetch/mutation failures. Realtime is only a refresh hint.
    }
  }

  private async refreshRoom(roomId: string): Promise<void> {
    await Promise.all(
      [...this.subscriptions]
        .filter((subscription) => subscription.roomId === roomId)
        .map((subscription) => this.refreshSubscription(subscription)),
    )
  }
}
