import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { getNightRoleIds } from '../../domain/roles/role-definitions'
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
  JournalEvent,
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
}

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

function toPlayers(players: readonly RemotePlayer[]): Player[] {
  return players.map((player) => ({
    id: player.id,
    seat: player.seat,
    alias: player.displayName,
    alive: true,
  }))
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
  const players = readRemotePlayers(value.players)
  const assignments = readAssignments(value.assignments)
  const payload: RemoteModeratorPayload = {
    room,
    roleConfig: roleComposition,
    players,
    assignments,
  }
  const roleIds = expandRoleDeck(roleComposition)
  const state: RoomState = {
    schemaVersion: 2,
    roomId: room.id,
    roomCode: room.code,
    revision: room.revision,
    createdAt: parseTimestamp(room.createdAt),
    lifecycle: room.status,
    phase: room.phase,
    dayNumber: room.dayNumber,
    players: toPlayers(players),
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
        ? {
            number: room.dayNumber,
            calls: getNightRoleIds(roleIds).map((roleId) => ({
              roleId,
              status: 'NOT_CALLED',
            })),
            activeRoleId: null,
            actionsByRole: {},
          }
        : null,
    dayVote: null,
    journal: lifecycleJournal(payload),
  }
  return { audience: 'MODERATOR', state }
}

export function playerSnapshotFromPayload(value: unknown): PlayerRoomSnapshot {
  if (!isRecord(value)) throw new Error('BACKEND_UNAVAILABLE')
  const room = readRemoteRoom(value.room)
  if (!isRecord(value.self)) throw new Error('UNAUTHORIZED')
  const selfRemote = value.self as unknown as RemotePlayer
  const players = toPlayers(readRemotePlayers(value.players))
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
      } else {
        return failure(new Error('SERVER_GAMEPLAY_UNAVAILABLE'))
      }
      const { error } = await this.client.rpc(functionName, { p_room_id: roomId })
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
