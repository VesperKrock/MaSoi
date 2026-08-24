import { describe, expect, it } from 'vitest'
import { fixedRandom } from '../voting/random'
import {
  applyRoomCommand,
  createProductRoom,
  generateSixDigitRoomCode,
  type GameEnvironment,
} from './room-engine'
import { getRoomJoinability, validatePlayerName } from './room-setup'
import { joinFlowAfterValidation } from './join-flow'
import type { RoomCommand, RoomState } from './types'

function environment(): GameEnvironment {
  let id = 0
  return {
    now: () => 10_000,
    nextId: () => `internal-${++id}`,
    random: fixedRandom(0),
  }
}

const setup = {
  seatCount: 7,
  roleComposition: { villager: 4, werewolf: 2, seer: 1 },
  wolfPolicy: 'RANDOM_ON_TIE' as const,
}

function run(
  state: RoomState,
  command: RoomCommand,
  context: GameEnvironment,
) {
  return applyRoomCommand(state, command, context)
}

function joinPlayers(
  state: RoomState,
  count: number,
  context: GameEnvironment,
) {
  let next = state
  for (let index = 1; index <= count; index += 1) {
    next = run(
      next,
      { type: 'JOIN_PLAYER', playerId: `player-${index}`, name: `Bạn ${index}` },
      context,
    )
  }
  return next
}

describe('room lifecycle', () => {
  it('creates a separate internal ID and six-digit display code in Lobby', () => {
    const context = environment()
    const code = generateSixDigitRoomCode(context.random)
    const room = createProductRoom(setup, code, context)

    expect(code).toMatch(/^\d{6}$/)
    expect(room.roomCode).toBe('000000')
    expect(room.roomId).not.toBe(room.roomCode)
    expect(room.lifecycle).toBe('LOBBY')
    expect(room.players).toEqual([])
    expect(room.roleAssignments).toEqual([])
  })

  it('avoids a six-digit code already reserved by another active local room', () => {
    let calls = 0
    const random = {
      pick<T>(values: readonly T[]): T {
        const digitIndex = calls++ < 6 ? 1 : 2
        return values[digitIndex]
      },
    }
    expect(generateSixDigitRoomCode(random, new Set(['111111']))).toBe('222222')
  })

  it('assigns roles only when a full Lobby is explicitly locked', () => {
    const context = environment()
    let room = createProductRoom(setup, '381624', context)
    room = joinPlayers(room, 7, context)
    expect(room.roleAssignments).toEqual([])

    room = run(room, { type: 'LOCK_AND_ASSIGN_ROLES' }, context)
    expect(room.lifecycle).toBe('ROLE_REVEAL')
    expect(room.roleAssignments).toHaveLength(7)
    expect(new Set(room.roleAssignments.map((item) => item.playerId)).size).toBe(7)
    expect(() =>
      run(room, { type: 'LOCK_AND_ASSIGN_ROLES' }, context),
    ).toThrow('Lobby')
  })

  it('rejects lock with missing players, full-room joins, and started-room joins', () => {
    const context = environment()
    let room = createProductRoom(setup, '381624', context)
    room = joinPlayers(room, 6, context)
    expect(() =>
      run(room, { type: 'LOCK_AND_ASSIGN_ROLES' }, context),
    ).toThrow('Cần đủ 7 người')

    room = run(
      room,
      { type: 'JOIN_PLAYER', playerId: 'player-7', name: 'Bạn 7' },
      context,
    )
    expect(getRoomJoinability(room)).toMatchObject({
      joinable: false,
      reason: 'ROOM_FULL',
    })
    expect(() =>
      run(
        room,
        { type: 'JOIN_PLAYER', playerId: 'player-8', name: 'Bạn 8' },
        context,
      ),
    ).toThrow('đủ người')

    room = run(room, { type: 'LOCK_AND_ASSIGN_ROLES' }, context)
    expect(getRoomJoinability(room)).toMatchObject({
      joinable: false,
      reason: 'ROOM_STARTED',
    })
    expect(() =>
      run(
        room,
        { type: 'JOIN_PLAYER', playerId: 'late', name: 'Người đến muộn' },
        context,
      ),
    ).toThrow('đã khóa')
  })
})

describe('join validation ordering and names', () => {
  it('keeps invalid/nonexistent/full/started rooms on code step', () => {
    const nonexistent = getRoomJoinability(undefined)
    expect(joinFlowAfterValidation('111111', nonexistent).step).toBe('CODE')

    const context = environment()
    let full = createProductRoom(setup, '381624', context)
    full = joinPlayers(full, 7, context)
    expect(joinFlowAfterValidation('381624', getRoomJoinability(full)).step).toBe(
      'CODE',
    )
    const started = run(full, { type: 'LOCK_AND_ASSIGN_ROLES' }, context)
    expect(
      joinFlowAfterValidation('381624', getRoomJoinability(started)).step,
    ).toBe('CODE')
  })

  it('opens the name step only after a valid open-room result', () => {
    const context = environment()
    const room = createProductRoom(setup, '381624', context)
    expect(joinFlowAfterValidation('381624', getRoomJoinability(room))).toEqual({
      step: 'NAME',
      code: '381624',
      roomId: room.roomId,
      roomCode: '381624',
    })
  })

  it('rejects empty, overlong, and duplicate normalized names', () => {
    const context = environment()
    let room = createProductRoom(setup, '381624', context)
    expect(validatePlayerName(room, '   ')).toBe('Tên không được để trống.')
    expect(validatePlayerName(room, '123456789012345678901')).toContain('20')
    room = run(
      room,
      { type: 'JOIN_PLAYER', playerId: 'player-1', name: '  Bảo   Châu  ' },
      context,
    )
    expect(room.players[0].alias).toBe('Bảo Châu')
    expect(validatePlayerName(room, 'bảo châu')).toBe(
      'Tên này đã có người dùng trong phòng.',
    )
  })
})
