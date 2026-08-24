import type { DispatchResult, RoomCommand } from '../domain/game/types'
import type {
  RoomJoinability,
  RoomSetupInput,
} from '../domain/game/room-setup'
import type { RoomAudience, RoomSnapshot } from '../state/room-projection'

export interface CreateRoomResult extends DispatchResult {
  roomId?: string
  roomCode?: string
}

export interface JoinRoomResult extends DispatchResult {
  roomId?: string
  roomCode?: string
  playerId?: string
}

export interface RoomTransport {
  createRoom(setup: RoomSetupInput): Promise<CreateRoomResult>
  validateRoomCode(code: string): Promise<RoomJoinability>
  joinRoom(code: string, name: string): Promise<JoinRoomResult>
  getSnapshot(roomId: string, audience: RoomAudience): Promise<RoomSnapshot>
  subscribe(
    roomId: string,
    audience: RoomAudience,
    listener: (snapshot: RoomSnapshot) => void,
  ): () => void
  dispatch(roomId: string, command: RoomCommand): Promise<DispatchResult>
  dispose(): void
}
