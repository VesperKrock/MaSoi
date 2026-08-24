import {
  classicRoleById,
  classicRoleCatalog,
  type RoleId,
} from '../roles/classic-catalog'
import type { RoomState, WolfPolicy } from './types'

export const minimumSeatCount = 7
export const maximumSeatCount = 16

export type RoleComposition = Partial<Record<RoleId, number>>

export interface RoomSetupInput {
  seatCount: number
  roleComposition: RoleComposition
  wolfPolicy: WolfPolicy
}

export interface RoomSetupValidation {
  valid: boolean
  roleCount: number
  errors: string[]
}

export function countSelectedRoles(composition: RoleComposition): number {
  return Object.values(composition).reduce(
    (total, quantity) => total + (quantity ?? 0),
    0,
  )
}

export function validateRoomSetup(input: RoomSetupInput): RoomSetupValidation {
  const errors: string[] = []
  if (
    !Number.isInteger(input.seatCount) ||
    input.seatCount < minimumSeatCount ||
    input.seatCount > maximumSeatCount
  ) {
    errors.push(
      `Số ghế phải là số nguyên từ ${minimumSeatCount} đến ${maximumSeatCount}.`,
    )
  }

  for (const [roleId, rawQuantity] of Object.entries(input.roleComposition)) {
    if (!(roleId in classicRoleById)) {
      errors.push(`Role không tồn tại trong Classic catalog: ${roleId}.`)
      continue
    }
    const quantity = rawQuantity ?? 0
    if (!Number.isInteger(quantity) || quantity < 0) {
      errors.push(`Số lượng ${roleId} phải là số nguyên không âm.`)
      continue
    }
    const role = classicRoleById[roleId as RoleId]
    if (role.quantityMode === 'SINGLE' && quantity > 1) {
      errors.push(`${role.displayName} chỉ được chọn tối đa một lần.`)
    }
  }

  const roleCount = countSelectedRoles(input.roleComposition)
  if (roleCount !== input.seatCount) {
    errors.push(
      roleCount < input.seatCount
        ? `Còn thiếu ${input.seatCount - roleCount} vai trò.`
        : `Đang dư ${roleCount - input.seatCount} vai trò.`,
    )
  }

  return { valid: errors.length === 0, roleCount, errors }
}

export function defaultRoleComposition(seatCount: number): RoleComposition {
  const wolfCount = seatCount >= 13 ? 3 : 2
  return {
    villager: seatCount - wolfCount - 1,
    werewolf: wolfCount,
    seer: 1,
  }
}

export function expandRoleDeck(composition: RoleComposition): RoleId[] {
  const deck: RoleId[] = []
  for (const role of classicRoleCatalog) {
    const quantity = composition[role.id] ?? 0
    for (let index = 0; index < quantity; index += 1) {
      deck.push(role.id)
    }
  }
  return deck
}

export type RoomJoinability =
  | { joinable: true; roomId: string; roomCode: string }
  | {
      joinable: false
      reason:
        | 'NOT_FOUND'
        | 'ROOM_FULL'
        | 'ROOM_STARTED'
        | 'BACKEND_UNAVAILABLE'
      message: string
    }

export function getRoomJoinability(
  room: RoomState | undefined,
): RoomJoinability {
  if (!room) {
    return {
      joinable: false,
      reason: 'NOT_FOUND',
      message: 'Không tìm thấy phòng với mã này.',
    }
  }
  if (room.lifecycle !== 'LOBBY') {
    return {
      joinable: false,
      reason: 'ROOM_STARTED',
      message: 'Phòng đã khóa hoặc ván chơi đã bắt đầu.',
    }
  }
  if (room.players.length >= room.config.seatCount) {
    return {
      joinable: false,
      reason: 'ROOM_FULL',
      message: 'Phòng đã đủ người.',
    }
  }
  return { joinable: true, roomId: room.roomId, roomCode: room.roomCode }
}

export function normalizePlayerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

export function validatePlayerName(room: RoomState, name: string): string {
  const normalized = normalizePlayerName(name)
  if (!normalized) return 'Tên không được để trống.'
  if ([...normalized].length > 20) return 'Tên được dài tối đa 20 ký tự.'
  const comparable = normalized.toLocaleLowerCase('vi')
  if (
    room.players.some(
      (player) => player.alias.toLocaleLowerCase('vi') === comparable,
    )
  ) {
    return 'Tên này đã có người dùng trong phòng.'
  }
  return ''
}
