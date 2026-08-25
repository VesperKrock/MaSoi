import type { RoomCommand } from '../domain/game/types'
import type {
  RoomJoinability,
  RoomSetupInput,
} from '../domain/game/room-setup'
import type { RoomAudience, RoomSnapshot } from '../state/room-projection'

export interface CreateRoomResult extends DispatchResult {
  roomId?: string
  roomCode?: string
}

export const roomTransportErrorCodes = {
  localConcurrencyUnsupported: 'LOCAL_CONCURRENCY_UNSUPPORTED',
  backendUnavailable: 'BACKEND_UNAVAILABLE',
  unauthorized: 'UNAUTHORIZED',
  roomNotFound: 'ROOM_NOT_FOUND',
  roomFull: 'ROOM_FULL',
  roomLocked: 'ROOM_LOCKED',
  duplicateName: 'DUPLICATE_NAME',
  invalidName: 'INVALID_NAME',
  invalidRoomConfig: 'INVALID_ROOM_CONFIG',
  invalidCreateRequest: 'INVALID_CREATE_REQUEST',
  notModerator: 'NOT_MODERATOR',
  roomNotReady: 'ROOM_NOT_READY',
  invalidAssignment: 'INVALID_ASSIGNMENT',
  alreadyDealt: 'ALREADY_DEALT',
  serverGameplayUnavailable: 'SERVER_GAMEPLAY_UNAVAILABLE',
  notInGame: 'NOT_IN_GAME',
  notNight: 'NOT_NIGHT',
  roleNotConfigured: 'ROLE_NOT_CONFIGURED',
  callAlreadyActive: 'CALL_ALREADY_ACTIVE',
  callNotActive: 'CALL_NOT_ACTIVE',
  callAlreadyCompleted: 'CALL_ALREADY_COMPLETED',
  callHasEligibleActor: 'CALL_HAS_ELIGIBLE_ACTOR',
  notPlayer: 'NOT_PLAYER',
  wrongRole: 'WRONG_ROLE',
  playerDead: 'PLAYER_DEAD',
  invalidTarget: 'INVALID_TARGET',
  sameProtectorTarget: 'SAME_PROTECTOR_TARGET',
  wolfNoBiteCapableMember: 'WOLF_NO_BITE_CAPABLE_MEMBER',
  wolfRoundNotReady: 'WOLF_ROUND_NOT_READY',
  revoteNotReady: 'REVOTE_NOT_READY',
  revoteExpired: 'REVOTE_EXPIRED',
  nightResolutionNotReady: 'NIGHT_RESOLUTION_NOT_READY',
} as const

export type RoomTransportErrorCode =
  (typeof roomTransportErrorCodes)[keyof typeof roomTransportErrorCodes]

export interface DispatchResult {
  ok: boolean
  error?: string
  errorCode?: RoomTransportErrorCode
}

export interface JoinRoomResult extends DispatchResult {
  roomId?: string
  roomCode?: string
  playerId?: string
}

export type RoomTransportKind = 'LOCAL' | 'SUPABASE' | 'UNAVAILABLE'

export interface ResumeRoomResult {
  kind: 'MODERATOR' | 'PLAYER'
  roomId: string
  roomCode: string
  playerId?: string
}

export interface RoomTransport {
  readonly kind: RoomTransportKind
  createRoom(
    setup: RoomSetupInput,
    requestId?: string,
  ): Promise<CreateRoomResult>
  validateRoomCode(code: string): Promise<RoomJoinability>
  joinRoom(code: string, name: string): Promise<JoinRoomResult>
  resumeCurrentRoom?(): Promise<ResumeRoomResult | null>
  getSnapshot(roomId: string, audience: RoomAudience): Promise<RoomSnapshot>
  subscribe(
    roomId: string,
    audience: RoomAudience,
    listener: (snapshot: RoomSnapshot) => void,
  ): () => void
  dispatch(roomId: string, command: RoomCommand): Promise<DispatchResult>
  dispose(): void
}
