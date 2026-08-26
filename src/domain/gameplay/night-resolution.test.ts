import { describe, expect, it } from 'vitest'
import {
  createHalfWolfBiteEffect,
  createWolfAttackEffect,
  getNightResolutionReadiness,
  resolveNightEffects,
  type NightEffectInput,
} from './night-resolution'

const wolfAttack = (targetPlayerId: string) =>
  createWolfAttackEffect('effect-wolf', targetPlayerId)

describe('MS-1B2 source-aware Night effect resolution', () => {
  it('turns an unprotected Half-Wolf attack into a nonlethal scheduled bite', () => {
    const result = resolveNightEffects(
      [createHalfWolfBiteEffect('bite', 'half', 1)],
      'someone-else',
    )
    expect(result).toMatchObject({
      outcome: 'BITE_SCHEDULED',
      provisionalDeathCandidateIds: [],
      effects: [
        {
          sourceType: 'WOLF_ATTACK',
          targetPlayerId: 'half',
          lethal: false,
          protectorBlockable: true,
          outcome: 'HALF_WOLF_BITE_SCHEDULED',
          conversion: {
            kind: 'HALF_WOLF_TRANSFORMATION',
            dueNightNumber: 2,
          },
        },
      ],
    })
  })

  it('lets Protector block a Half-Wolf bite before conversion is scheduled', () => {
    const result = resolveNightEffects(
      [createHalfWolfBiteEffect('bite', 'half', 1)],
      'half',
    )
    expect(result.outcome).toBe('BLOCKED')
    expect(result.effects[0].outcome).toBe('BLOCKED_BY_PROTECTOR')
    expect(result.provisionalDeathCandidateIds).toEqual([])
  })
  it('blocks a Wolf attack matching the Protector intent', () => {
    const result = resolveNightEffects([wolfAttack('chau')], 'chau')

    expect(result.outcome).toBe('BLOCKED')
    expect(result.effects[0]).toMatchObject({
      sourceType: 'WOLF_ATTACK',
      category: 'HOSTILE_VILLAIN_ATTACK',
      lethal: true,
      protectorBlockable: true,
      outcome: 'BLOCKED_BY_PROTECTOR',
      blockSourceType: 'PROTECTOR_SHIELD',
      blockSourceRoleId: 'protector',
    })
    expect(result.provisionalDeathCandidateIds).toEqual([])
  })

  it('leaves a Wolf target provisional when Protector targets someone else', () => {
    const result = resolveNightEffects([wolfAttack('chau')], 'minh')

    expect(result.outcome).toBe('UNBLOCKED')
    expect(result.effects[0].outcome).toBe('UNBLOCKED')
    expect(result.provisionalDeathCandidateIds).toEqual(['chau'])
  })

  it('leaves a Wolf target provisional when there is no Protector intent', () => {
    const result = resolveNightEffects([wolfAttack('chau')])

    expect(result.outcome).toBe('UNBLOCKED')
    expect(result.provisionalDeathCandidateIds).toEqual(['chau'])
  })

  it('returns NO_ATTACK when no authoritative hostile effect exists', () => {
    const result = resolveNightEffects([], 'chau')

    expect(result).toEqual({
      outcome: 'NO_ATTACK',
      effects: [],
      provisionalDeathCandidateIds: [],
    })
  })

  it('blocks multiple future Protector-blockable hostile effects independently', () => {
    const effects: NightEffectInput[] = [
      wolfAttack('chau'),
      {
        id: 'effect-future-villain',
        sourceType: 'FUTURE_VILLAIN_ATTACK',
        category: 'HOSTILE_VILLAIN_ATTACK',
        targetPlayerId: 'chau',
        lethal: true,
        protectorBlockable: true,
      },
    ]

    const result = resolveNightEffects(effects, 'chau')

    expect(result.effects.map((effect) => effect.outcome)).toEqual([
      'BLOCKED_BY_PROTECTOR',
      'BLOCKED_BY_PROTECTOR',
    ])
    expect(result.provisionalDeathCandidateIds).toEqual([])
  })

  it('does not turn Protector into a universal lethal-effect shield', () => {
    const effects: NightEffectInput[] = [
      wolfAttack('chau'),
      {
        id: 'effect-synthetic-non-blockable',
        sourceType: 'SYNTHETIC_NON_BLOCKABLE_EFFECT',
        category: 'NON_VILLAIN_LETHAL_EFFECT',
        targetPlayerId: 'chau',
        lethal: true,
        protectorBlockable: false,
      },
    ]

    const result = resolveNightEffects(effects, 'chau')

    expect(result.effects.map((effect) => effect.outcome)).toEqual([
      'BLOCKED_BY_PROTECTOR',
      'UNBLOCKED',
    ])
    expect(result.provisionalDeathCandidateIds).toEqual(['chau'])
  })

  it('deduplicates a candidate while preserving every source effect', () => {
    const result = resolveNightEffects(
      [
        wolfAttack('chau'),
        {
          ...wolfAttack('chau'),
          id: 'effect-second-source',
          sourceType: 'FUTURE_SECOND_ATTACK',
        },
      ],
      null,
    )

    expect(result.effects).toHaveLength(2)
    expect(result.provisionalDeathCandidateIds).toEqual(['chau'])
  })
})

describe('MS-1B2 contributing-call readiness', () => {
  it('does not require Seer completion', () => {
    expect(
      getNightResolutionReadiness({
        configuredRoleIds: ['werewolf', 'seer'],
        calls: [
          { roleId: 'werewolf', status: 'COMPLETED' },
          { roleId: 'seer', status: 'NOT_CALLED' },
        ],
      }),
    ).toEqual({ ready: true, incompleteRoleIds: [] })
  })

  it('requires a configured Protector call to complete', () => {
    expect(
      getNightResolutionReadiness({
        configuredRoleIds: ['werewolf', 'protector'],
        calls: [
          { roleId: 'werewolf', status: 'COMPLETED' },
          { roleId: 'protector', status: 'NOT_CALLED' },
        ],
      }),
    ).toEqual({ ready: false, incompleteRoleIds: ['protector'] })
  })

  it('requires a configured Wolf call to complete', () => {
    expect(
      getNightResolutionReadiness({
        configuredRoleIds: ['werewolf', 'protector'],
        calls: [
          { roleId: 'protector', status: 'COMPLETED' },
          { roleId: 'werewolf', status: 'CALLED' },
        ],
      }),
    ).toEqual({ ready: false, incompleteRoleIds: ['werewolf'] })
  })

  it('is ready without a configured Protector', () => {
    expect(
      getNightResolutionReadiness({
        configuredRoleIds: ['werewolf'],
        calls: [{ roleId: 'werewolf', status: 'COMPLETED' }],
      }),
    ).toEqual({ ready: true, incompleteRoleIds: [] })
  })

  it('is independent of contributing-role call order', () => {
    expect(
      getNightResolutionReadiness({
        configuredRoleIds: ['protector', 'werewolf'],
        calls: [
          { roleId: 'protector', status: 'COMPLETED' },
          { roleId: 'werewolf', status: 'COMPLETED' },
        ],
      }),
    ).toEqual({ ready: true, incompleteRoleIds: [] })
  })
})
