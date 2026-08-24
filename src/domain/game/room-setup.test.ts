import { describe, expect, it } from 'vitest'
import { classicRoleCatalog } from '../roles/classic-catalog'
import {
  defaultRoleComposition,
  validateRoomSetup,
} from './room-setup'

describe('role market validation', () => {
  it('accepts only 7–16 player seats', () => {
    expect(
      validateRoomSetup({
        seatCount: 6,
        roleComposition: defaultRoleComposition(6),
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(false)
    expect(
      validateRoomSetup({
        seatCount: 7,
        roleComposition: defaultRoleComposition(7),
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(true)
    expect(
      validateRoomSetup({
        seatCount: 16,
        roleComposition: defaultRoleComposition(16),
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(true)
    expect(
      validateRoomSetup({
        seatCount: 17,
        roleComposition: defaultRoleComposition(17),
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(false)
  })

  it('allows quantities greater than one only for Villager and Werewolf', () => {
    expect(
      validateRoomSetup({
        seatCount: 7,
        roleComposition: { villager: 4, werewolf: 3 },
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(true)

    for (const role of classicRoleCatalog.filter(
      (entry) => entry.quantityMode === 'SINGLE',
    )) {
      const result = validateRoomSetup({
        seatCount: 7,
        roleComposition: { villager: 5, [role.id]: 2 },
        wolfPolicy: 'RANDOM_ON_TIE',
      })
      expect(result.errors.some((error) => error.includes('tối đa một'))).toBe(
        true,
      )
    }
  })

  it('rejects role totals below or above seats and accepts an exact total', () => {
    const below = validateRoomSetup({
      seatCount: 7,
      roleComposition: { villager: 4, werewolf: 2 },
      wolfPolicy: 'RANDOM_ON_TIE',
    })
    expect(below.valid).toBe(false)
    expect(below.errors).toContain('Còn thiếu 1 vai trò.')

    const above = validateRoomSetup({
      seatCount: 7,
      roleComposition: { villager: 5, werewolf: 2, seer: 1 },
      wolfPolicy: 'RANDOM_ON_TIE',
    })
    expect(above.valid).toBe(false)
    expect(above.errors).toContain('Đang dư 1 vai trò.')

    expect(
      validateRoomSetup({
        seatCount: 7,
        roleComposition: { villager: 4, werewolf: 2, seer: 1 },
        wolfPolicy: 'RANDOM_ON_TIE',
      }).valid,
    ).toBe(true)
  })
})
