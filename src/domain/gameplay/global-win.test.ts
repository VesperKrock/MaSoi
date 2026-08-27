import { describe, expect, it } from 'vitest'
import {
  resolveFoolHanging,
  resolveGlobalWin,
  type GlobalWinContext,
} from './global-win'
import type { RoleId } from '../game/types'

function context(
  roles: readonly (readonly [string, RoleId, boolean])[],
  overrides: Partial<GlobalWinContext> = {},
): GlobalWinContext {
  return {
    players: roles.map(([id, , alive], index) => ({
      id,
      alias: id,
      seat: index + 1,
      alive,
    })),
    assignments: roles.map(([playerId, roleId]) => ({ playerId, roleId })),
    factionTransitions: { halfWolves: {}, traitors: {} },
    cupidLovers: null,
    ...overrides,
  }
}

describe('authoritative global win resolver', () => {
  it('awards Fool only for the authoritative hanged Fool', () => {
    const state = context([
      ['fool', 'fool', false],
      ['villager', 'villager', true],
    ])
    expect(resolveFoolHanging(state, 'fool')).toEqual({
      outcome: 'FOOL',
      subjectPlayerIds: ['fool'],
    })
    expect(resolveFoolHanging(state, 'villager').outcome).toBeNull()
    expect(resolveGlobalWin(state).outcome).toBe('VILLAGE')
  })

  it.each([
    'WOLF_ATTACK',
    'SERIAL_KILLER_ATTACK',
    'WITCH_POISON',
    'HUNTER_SHOT',
    'HUNTER_REVENGE_SHOT',
    'LOVER_HEARTBREAK',
  ])('does not award Fool for a %s death', () => {
    const state = context([
      ['fool', 'fool', false],
      ['survivor', 'villager', true],
    ])
    expect(resolveGlobalWin(state).outcome).toBe('VILLAGE')
    expect(resolveFoolHanging(state, 'survivor').outcome).toBeNull()
  })

  it('uses bite-capable Wolf parity and excludes Wolf-aligned Traitor from both sides', () => {
    const state = context(
      [
        ['wolf', 'werewolf', true],
        ['traitor', 'traitor', true],
        ['villager', 'villager', true],
      ],
      {
        factionTransitions: {
          halfWolves: {},
          traitors: {
            traitor: { playerId: 'traitor', status: 'WOLF_ALIGNED' },
          },
        },
      },
    )
    expect(resolveGlobalWin(state).outcome).toBe('WOLF')
  })

  it('does not count Traitor as bite-capable and lets living SK block Wolf', () => {
    const traitorOnly = context(
      [
        ['traitor', 'traitor', true],
        ['villager', 'villager', true],
      ],
      {
        factionTransitions: {
          halfWolves: {},
          traitors: {
            traitor: {
              playerId: 'traitor',
              status: 'CONVERTED_VILLAGE',
            },
          },
        },
      },
    )
    expect(resolveGlobalWin(traitorOnly).outcome).toBe('VILLAGE')

    const wolfAndSk = context([
      ['wolf', 'werewolf', true],
      ['sk', 'serial-killer', true],
    ])
    expect(resolveGlobalWin(wolfAndSk).outcome).toBeNull()
  })

  it('counts transformed Half-Wolf but not untransformed or pending Half-Wolf', () => {
    const roles = [
      ['half', 'half-wolf', true],
      ['villager', 'villager', true],
    ] as const
    const transformed = context(roles, {
      factionTransitions: {
        traitors: {},
        halfWolves: {
          half: { playerId: 'half', status: 'TRANSFORMED' },
        },
      },
    })
    expect(resolveGlobalWin(transformed).outcome).toBe('WOLF')

    const village = context(roles, {
      factionTransitions: {
        traitors: {},
        halfWolves: { half: { playerId: 'half', status: 'VILLAGE' } },
      },
    })
    expect(resolveGlobalWin(village).outcome).toBe('VILLAGE')

    const pending = context(roles, {
      factionTransitions: {
        traitors: {},
        halfWolves: {
          half: {
            playerId: 'half',
            status: 'PENDING_TRANSFORMATION',
            bittenNightNumber: 1,
            transformDueNightNumber: 2,
          },
        },
      },
    })
    expect(resolveGlobalWin(pending).outcome).toBeNull()

    const canceledByDeath = context(
      [
        ['half', 'half-wolf', false],
        ['villager', 'villager', true],
      ],
      { factionTransitions: pending.factionTransitions },
    )
    expect(resolveGlobalWin(canceledByDeath).outcome).toBe('VILLAGE')
  })

  it('awards exactly the active Cupid/Lovers trio and rejects a fourth survivor', () => {
    const trioRoles = [
      ['cupid', 'cupid', true],
      ['a', 'villager', true],
      ['b', 'serial-killer', true],
    ] as const
    const cupidLovers = {
      couple: {
        id: 'couple',
        cupidPlayerId: 'cupid',
        loverPlayerIds: ['a', 'b'] as [string, string],
        pairedNightNumber: 1 as const,
        pairedAt: 1,
      },
      loverRevealAcknowledgedPlayerIds: [],
      objective: {
        cupidPlayerId: 'cupid',
        status: 'ACTIVE' as const,
        changedAt: 1,
      },
    }
    expect(resolveGlobalWin(context(trioRoles, { cupidLovers })).outcome).toBe(
      'COUPLE',
    )
    expect(
      resolveGlobalWin(
        context([...trioRoles, ['fourth', 'villager', true]], { cupidLovers }),
      ).outcome,
    ).toBeNull()
  })

  it('requires Cupid and both Lovers alive and keeps mixed factions intact', () => {
    const cupidLovers = {
      couple: {
        id: 'couple',
        cupidPlayerId: 'cupid',
        loverPlayerIds: ['wolf', 'villager'] as [string, string],
        pairedNightNumber: 1 as const,
        pairedAt: 1,
      },
      loverRevealAcknowledgedPlayerIds: [],
      objective: {
        cupidPlayerId: 'cupid',
        status: 'ACTIVE' as const,
        changedAt: 1,
      },
    }
    const mixed = context(
      [
        ['cupid', 'cupid', true],
        ['wolf', 'werewolf', true],
        ['villager', 'villager', true],
      ],
      { cupidLovers },
    )
    // Wolf 1 < Village 2, so Couple wins without faction rewriting.
    expect(resolveGlobalWin(mixed).outcome).toBe('COUPLE')
    const deadCupid = context(
      [
        ['cupid', 'cupid', false],
        ['wolf', 'werewolf', true],
        ['villager', 'villager', true],
      ],
      { cupidLovers },
    )
    expect(resolveGlobalWin(deadCupid).outcome).toBe('WOLF')
  })

  it('gives Wolf precedence over an otherwise valid Couple trio', () => {
    const cupidLovers = {
      couple: {
        id: 'couple',
        cupidPlayerId: 'cupid',
        loverPlayerIds: ['wolf', 'traitor'] as [string, string],
        pairedNightNumber: 1 as const,
        pairedAt: 1,
      },
      loverRevealAcknowledgedPlayerIds: [],
      objective: {
        cupidPlayerId: 'cupid',
        status: 'ACTIVE' as const,
        changedAt: 1,
      },
    }
    const state = context(
      [
        ['cupid', 'cupid', true],
        ['wolf', 'werewolf', true],
        ['traitor', 'traitor', true],
      ],
      {
        cupidLovers,
        factionTransitions: {
          halfWolves: {},
          traitors: {
            traitor: { playerId: 'traitor', status: 'WOLF_ALIGNED' },
          },
        },
      },
    )
    expect(resolveGlobalWin(state).outcome).toBe('WOLF')
  })

  it('requires Serial Killer to be the sole survivor', () => {
    expect(
      resolveGlobalWin(context([['sk', 'serial-killer', true]])).outcome,
    ).toBe('SERIAL_KILLER')
    expect(
      resolveGlobalWin(
        context([
          ['sk', 'serial-killer', true],
          ['villager', 'villager', true],
        ]),
      ).outcome,
    ).toBeNull()
  })

  it('returns Draw for total elimination before Village', () => {
    expect(
      resolveGlobalWin(
        context([
          ['wolf', 'werewolf', false],
          ['villager', 'villager', false],
        ]),
      ).outcome,
    ).toBe('DRAW')
  })

  it('returns Village only with survivors and no Wolf, SK, or valid pending Half-Wolf', () => {
    expect(
      resolveGlobalWin(
        context([
          ['seer', 'seer', true],
          ['fool', 'fool', true],
          ['wolf', 'werewolf', false],
        ]),
      ).outcome,
    ).toBe('VILLAGE')
  })
})
