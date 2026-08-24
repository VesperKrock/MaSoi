import type { RoomSnapshot } from '../state/room-projection'
import {
  roomTransportErrorCodes,
  type CreateRoomResult,
  type DispatchResult,
  type JoinRoomResult,
  type RoomTransport,
} from './room-transport'

export class UnavailableRoomTransport implements RoomTransport {
  readonly kind = 'UNAVAILABLE' as const

  constructor(private readonly message: string) {}

  async createRoom(): Promise<CreateRoomResult> {
    return this.failure()
  }

  async validateRoomCode() {
    return {
      joinable: false as const,
      reason: 'BACKEND_UNAVAILABLE' as const,
      message: this.message,
    }
  }

  async joinRoom(): Promise<JoinRoomResult> {
    return this.failure()
  }

  async getSnapshot(): Promise<RoomSnapshot> {
    throw new Error(this.message)
  }

  subscribe(): () => void {
    return () => undefined
  }

  async dispatch(): Promise<DispatchResult> {
    return this.failure()
  }

  dispose(): void {}

  private failure(): DispatchResult & { ok: false } {
    return {
      ok: false,
      error: this.message,
      errorCode: roomTransportErrorCodes.backendUnavailable,
    }
  }
}
