import { describe, expect, it } from 'vitest'
import {
  canProtectorTarget,
  detectForSeer,
  getWolfGroupVoterIds,
  type NightRoleHolder,
} from './night-rules'

const holder = (
  playerId: string,
  roleId: NightRoleHolder['roleId'],
  alive = true,
): NightRoleHolder => ({ playerId, roleId, alive })

describe('MS-1B1 Wolf-group eligibility', () => {
  it('includes living Werewolves and the living Traitor while an actual Wolf lives', () => {
    expect(
      getWolfGroupVoterIds([
        holder('wolf-a', 'werewolf'),
        holder('wolf-b', 'werewolf'),
        holder('traitor', 'traitor'),
        holder('villager', 'villager'),
      ]),
    ).toEqual(['wolf-a', 'wolf-b', 'traitor'])
  })

  it('does not wake a Traitor when no living actual Werewolf exists', () => {
    expect(
      getWolfGroupVoterIds([
        holder('dead-wolf', 'werewolf', false),
        holder('traitor', 'traitor'),
      ]),
    ).toEqual([])
  })

  it('keeps a living Wolf eligible when the Traitor is dead', () => {
    expect(
      getWolfGroupVoterIds([
        holder('wolf', 'werewolf'),
        holder('traitor', 'traitor', false),
      ]),
    ).toEqual(['wolf'])
  })

  it('uses transformed Half-Wolf as bite-capable and excludes converted Traitor', () => {
    expect(
      getWolfGroupVoterIds([
        { ...holder('half', 'half-wolf'), halfWolfTransformed: true },
        { ...holder('traitor', 'traitor'), traitorConverted: true },
      ]),
    ).toEqual(['half'])
  })

  it('keeps untransformed Half-Wolf out of the Wolf group', () => {
    expect(
      getWolfGroupVoterIds([
        holder('wolf', 'werewolf'),
        holder('half', 'half-wolf'),
        holder('traitor', 'traitor'),
      ]),
    ).toEqual(['wolf', 'traitor'])
  })
})

describe('MS-1B1 Seer detection', () => {
  it.each([
    ['werewolf', 'WOLF'],
    ['traitor', 'NON_WOLF'],
    ['half-wolf', 'NON_WOLF'],
    ['serial-killer', 'NON_WOLF'],
    ['fool', 'NON_WOLF'],
    ['villager', 'NON_WOLF'],
  ] as const)('maps %s to %s', (roleId, expected) => {
    expect(detectForSeer(roleId)).toBe(expected)
  })

  it('keeps the future transformed Half-Wolf extension explicit', () => {
    expect(detectForSeer('half-wolf', { halfWolfTransformed: true })).toBe(
      'WOLF',
    )
  })
})

describe('MS-1B1 Protector targeting', () => {
  it('allows self-target and any living target on Night 1', () => {
    expect(
      canProtectorTarget({
        nightNumber: 1,
        targetId: 'protector',
        targetAlive: true,
        previousNightTargetId: 'protector',
      }),
    ).toBe(true)
  })

  it('rejects only the immediately previous Night target', () => {
    expect(
      canProtectorTarget({
        nightNumber: 2,
        targetId: 'chau',
        targetAlive: true,
        previousNightTargetId: 'chau',
      }),
    ).toBe(false)
    expect(
      canProtectorTarget({
        nightNumber: 2,
        targetId: 'minh',
        targetAlive: true,
        previousNightTargetId: 'chau',
      }),
    ).toBe(true)
    expect(
      canProtectorTarget({
        nightNumber: 3,
        targetId: 'chau',
        targetAlive: true,
        previousNightTargetId: 'minh',
      }),
    ).toBe(true)
  })

  it('never permits a dead target', () => {
    expect(
      canProtectorTarget({
        nightNumber: 1,
        targetId: 'dead-player',
        targetAlive: false,
      }),
    ).toBe(false)
  })
})
