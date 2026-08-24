import {
  applyRoomCommand,
  createProductRoom,
  defaultGameEnvironment,
  generateSixDigitRoomCode,
  type GameEnvironment,
} from '../../domain/game/room-engine'
import {
  getRoomJoinability,
  type RoomSetupInput,
} from '../../domain/game/room-setup'
import type { RoomCommand, RoomState } from '../../domain/game/types'
import {
  projectRoomSnapshot,
  type RoomAudience,
  type RoomSnapshot,
} from '../../state/room-projection'
import {
  roomTransportErrorCodes,
  type CreateRoomResult,
  type DispatchResult,
  type JoinRoomResult,
  type RoomTransport,
  type RoomTransportErrorCode,
} from '../room-transport'

const storageKey = 'masoi.ms0b.rooms.v1'
const channelName = 'masoi.ms0b.rooms.channel.v1'
const mutationLockName = 'masoi-ms0b-room-write'

export const localConcurrencyUnsupportedMessage =
  'Trình duyệt này không hỗ trợ đồng bộ phòng cục bộ an toàn. Vui lòng dùng Chrome hoặc Edge phiên bản mới, rồi thử lại.'

interface LocalMutationLockAuthority {
  request<T>(name: string, operation: () => T | PromiseLike<T>): Promise<T>
}

class LocalRoomTransportError extends Error {
  constructor(
    readonly code: RoomTransportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalRoomTransportError'
  }
}

export function runWithSafeLocalMutationAuthority<T>(
  authority: LocalMutationLockAuthority | null | undefined,
  operation: () => T,
): Promise<T> {
  if (!authority || typeof authority.request !== 'function') {
    return Promise.reject(
      new LocalRoomTransportError(
        roomTransportErrorCodes.localConcurrencyUnsupported,
        localConcurrencyUnsupportedMessage,
      ),
    )
  }
  return authority.request(mutationLockName, operation)
}

interface LocalRoomRegistry {
  schemaVersion: 1
  rooms: Record<string, RoomState>
}

interface Subscription {
  roomId: string
  audience: RoomAudience
  listener: (snapshot: RoomSnapshot) => void
}

export class LocalRoomTransport implements RoomTransport {
  private readonly subscriptions = new Set<Subscription>()
  private readonly channel: BroadcastChannel | null

  constructor(
    private readonly environment: GameEnvironment = defaultGameEnvironment,
  ) {
    this.channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(channelName)
    this.channel?.addEventListener('message', this.handleExternalChange)
    window.addEventListener('storage', this.handleStorage)
  }

  async createRoom(setup: RoomSetupInput): Promise<CreateRoomResult> {
    try {
      return await this.runExclusive(() => {
        const registry = this.readRegistry()
        const roomCode = generateSixDigitRoomCode(
          this.environment.random,
          new Set(Object.values(registry.rooms).map((room) => room.roomCode)),
        )
        const room = createProductRoom(setup, roomCode, this.environment)
        registry.rooms[room.roomId] = room
        this.writeRegistry(registry, room.roomId)
        return {
          ok: true,
          roomId: room.roomId,
          roomCode: room.roomCode,
        }
      })
    } catch (error) {
      return this.failure(error)
    }
  }

  async validateRoomCode(code: string) {
    const normalizedCode = code.replace(/\D/g, '')
    const room = Object.values(this.readRegistry().rooms).find(
      (candidate) => candidate.roomCode === normalizedCode,
    )
    return getRoomJoinability(room)
  }

  async joinRoom(code: string, name: string): Promise<JoinRoomResult> {
    try {
      return await this.runExclusive(() => {
        const registry = this.readRegistry()
        const normalizedCode = code.replace(/\D/g, '')
        const room = Object.values(registry.rooms).find(
          (candidate) => candidate.roomCode === normalizedCode,
        )
        const joinability = getRoomJoinability(room)
        if (!joinability.joinable) throw new Error(joinability.message)
        if (!room) throw new Error('Không tìm thấy phòng với mã này.')

        const playerId = this.environment.nextId()
        const nextRoom = applyRoomCommand(
          room,
          { type: 'JOIN_PLAYER', playerId, name },
          this.environment,
        )
        registry.rooms[room.roomId] = nextRoom
        this.writeRegistry(registry, room.roomId)
        return {
          ok: true,
          roomId: room.roomId,
          roomCode: room.roomCode,
          playerId,
        }
      })
    } catch (error) {
      return this.failure(error)
    }
  }

  async getSnapshot(
    roomId: string,
    audience: RoomAudience,
  ): Promise<RoomSnapshot> {
    const room = this.readRegistry().rooms[roomId]
    if (!room) throw new Error('Phòng local này không còn tồn tại.')
    return projectRoomSnapshot(room, audience)
  }

  subscribe(
    roomId: string,
    audience: RoomAudience,
    listener: (snapshot: RoomSnapshot) => void,
  ): () => void {
    const subscription = { roomId, audience, listener }
    this.subscriptions.add(subscription)
    const room = this.readRegistry().rooms[roomId]
    if (room) listener(projectRoomSnapshot(room, audience))

    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  async dispatch(
    roomId: string,
    command: RoomCommand,
  ): Promise<DispatchResult> {
    try {
      await this.runExclusive(() => {
        const registry = this.readRegistry()
        const room = registry.rooms[roomId]
        if (!room) throw new Error('Phòng local này không còn tồn tại.')
        registry.rooms[roomId] = applyRoomCommand(
          room,
          command,
          this.environment,
        )
        this.writeRegistry(registry, roomId)
      })
      return { ok: true }
    } catch (error) {
      return this.failure(error)
    }
  }

  dispose(): void {
    this.channel?.removeEventListener('message', this.handleExternalChange)
    this.channel?.close()
    window.removeEventListener('storage', this.handleStorage)
    this.subscriptions.clear()
  }

  private readonly handleExternalChange = (event: MessageEvent): void => {
    const roomId = (event.data as { roomId?: string } | null)?.roomId
    this.emit(roomId)
  }

  private readonly handleStorage = (event: StorageEvent): void => {
    if (event.key === storageKey) this.emit()
  }

  private readRegistry(): LocalRoomRegistry {
    const serialized = localStorage.getItem(storageKey)
    if (serialized) {
      try {
        const parsed = JSON.parse(serialized) as LocalRoomRegistry
        if (parsed.schemaVersion === 1 && parsed.rooms) return parsed
      } catch {
        // Corrupt development storage is replaced by an empty registry.
      }
    }
    return { schemaVersion: 1, rooms: {} }
  }

  private writeRegistry(registry: LocalRoomRegistry, roomId: string): void {
    localStorage.setItem(storageKey, JSON.stringify(registry))
    this.channel?.postMessage({ roomId })
    this.emit(roomId, registry.rooms[roomId])
  }

  private emit(roomId?: string, knownRoom?: RoomState): void {
    const registry = knownRoom ? null : this.readRegistry()
    for (const subscription of this.subscriptions) {
      if (roomId && subscription.roomId !== roomId) continue
      const room =
        knownRoom && subscription.roomId === roomId
          ? knownRoom
          : registry?.rooms[subscription.roomId]
      if (room) {
        subscription.listener(
          projectRoomSnapshot(room, subscription.audience),
        )
      }
    }
  }

  private async runExclusive<T>(operation: () => T): Promise<T> {
    const authority =
      typeof navigator === 'undefined'
        ? undefined
        : (navigator.locks as LocalMutationLockAuthority | undefined)
    return runWithSafeLocalMutationAuthority(authority, operation)
  }

  private failure(error: unknown): DispatchResult & { ok: false } {
    if (error instanceof LocalRoomTransportError) {
      return {
        ok: false,
        error: error.message,
        errorCode: error.code,
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Lệnh không thành công.',
    }
  }
}
