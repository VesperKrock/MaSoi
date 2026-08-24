import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRoomCommand,
  createProductRoom,
  type GameEnvironment,
} from '../../domain/game/room-engine'
import { fixedRandom } from '../../domain/voting/random'
import type { RoomState } from '../../domain/game/types'
import { roomTransportErrorCodes } from '../room-transport'
import {
  LocalRoomTransport,
  localConcurrencyUnsupportedMessage,
  runWithSafeLocalMutationAuthority,
} from './local-room-transport'

const storageKey = 'masoi.ms0b.rooms.v1'
const setup = {
  seatCount: 7,
  roleComposition: { villager: 4, werewolf: 2, seer: 1 },
  wolfPolicy: 'RANDOM_ON_TIE' as const,
}

class MemoryStorage {
  private readonly values = new Map<string, string>()
  writes = 0

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes += 1
    this.values.set(key, value)
  }

  seed(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function environment(): GameEnvironment {
  let id = 0
  return {
    now: () => 42_000,
    nextId: () => `local-${++id}`,
    random: fixedRandom(0),
  }
}

function roomWithPlayers(
  count: number,
  context: GameEnvironment,
): RoomState {
  let room = createProductRoom(setup, '381624', context)
  for (let index = 1; index <= count; index += 1) {
    room = applyRoomCommand(
      room,
      {
        type: 'JOIN_PLAYER',
        playerId: `player-${index}`,
        name: `Bạn ${index}`,
      },
      context,
    )
  }
  return room
}

function seedRoom(storage: MemoryStorage, room: RoomState): string {
  const serialized = JSON.stringify({
    schemaVersion: 1,
    rooms: { [room.roomId]: room },
  })
  storage.seed(storageKey, serialized)
  return serialized
}

describe('LocalRoomTransport safe mutation authority', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects before invoking a mutation when Web Locks is unavailable', async () => {
    const operation = vi.fn(() => 'mutated')

    await expect(
      runWithSafeLocalMutationAuthority(undefined, operation),
    ).rejects.toMatchObject({
      code: roomTransportErrorCodes.localConcurrencyUnsupported,
      message: localConcurrencyUnsupportedMessage,
    })
    expect(operation).not.toHaveBeenCalled()
  })

  it('uses the named Web Lock authority when available', async () => {
    const requestedNames: string[] = []
    const authority = {
      async request<T>(
        name: string,
        operation: () => T | PromiseLike<T>,
      ): Promise<T> {
        requestedNames.push(name)
        return operation()
      },
    }
    const operation = vi.fn(() => 'safe-result')

    await expect(
      runWithSafeLocalMutationAuthority(authority, operation),
    ).resolves.toBe('safe-result')
    expect(requestedNames).toEqual(['masoi-ms0b-room-write'])
    expect(operation).toHaveBeenCalledOnce()
  })

  it('fails create, join, and dispatch before any registry write', async () => {
    const context = environment()
    const transport = new LocalRoomTransport(context)

    const createResult = await transport.createRoom(setup)
    expect(createResult).toMatchObject({
      ok: false,
      errorCode: roomTransportErrorCodes.localConcurrencyUnsupported,
      error: localConcurrencyUnsupportedMessage,
    })
    expect(createResult.roomId).toBeUndefined()
    expect(storage.writes).toBe(0)
    expect(storage.getItem(storageKey)).toBeNull()

    const joinableRoom = roomWithPlayers(6, context)
    const beforeJoin = seedRoom(storage, joinableRoom)
    const joinResult = await transport.joinRoom(joinableRoom.roomCode, 'Ghế cuối')
    expect(joinResult).toMatchObject({
      ok: false,
      errorCode: roomTransportErrorCodes.localConcurrencyUnsupported,
      error: localConcurrencyUnsupportedMessage,
    })
    expect(joinResult.playerId).toBeUndefined()
    expect(storage.getItem(storageKey)).toBe(beforeJoin)
    expect(storage.writes).toBe(0)

    const fullRoom = roomWithPlayers(7, context)
    const beforeLock = seedRoom(storage, fullRoom)
    const lockResult = await transport.dispatch(fullRoom.roomId, {
      type: 'LOCK_AND_ASSIGN_ROLES',
    })
    expect(lockResult).toMatchObject({
      ok: false,
      errorCode: roomTransportErrorCodes.localConcurrencyUnsupported,
      error: localConcurrencyUnsupportedMessage,
    })
    expect(storage.getItem(storageKey)).toBe(beforeLock)
    expect(storage.writes).toBe(0)

    transport.dispose()
  })
})
