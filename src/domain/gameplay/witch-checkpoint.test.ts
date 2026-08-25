import { describe, expect, it } from 'vitest'
import { createWolfAttackEffect, resolveNightEffects } from './night-resolution'
import {
  WitchDecisionError,
  createWitchPoisonEffect,
  finalizeWitchCheckpoint,
  getWitchCapabilities,
  type FinalizeWitchCheckpointInput,
} from './witch-checkpoint'

const players = [
  { id: 'witch-player', alive: true },
  { id: 'chau', alive: true },
  { id: 'minh', alive: true },
]

function input(
  target = 'chau',
  overrides: Partial<FinalizeWitchCheckpointInput> = {},
): FinalizeWitchCheckpointInput {
  const resolution = resolveNightEffects(
    [createWolfAttackEffect('wolf-effect', target)],
    null,
  )
  return {
    nightNumber: 1,
    witchPlayerId: 'witch-player',
    witchAliveBeforeNight: true,
    provisionalDeathCandidateIds:
      resolution.provisionalDeathCandidateIds,
    preWitchEffects: resolution.effects,
    players,
    resources: {
      witchPlayerId: 'witch-player',
      resurrectionAvailable: true,
      poisonAvailable: true,
    },
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string) {
  try {
    action()
    throw new Error('Expected WitchDecisionError')
  } catch (error) {
    expect(error).toBeInstanceOf(WitchDecisionError)
    expect((error as WitchDecisionError).code).toBe(code)
  }
}

describe('MS-1C Witch final Night checkpoint', () => {
  it('rescues one current-Night provisional victim and preserves attack history', () => {
    const result = finalizeWitchCheckpoint({
      ...input(),
      decision: { resurrectionTargetId: 'chau', poisonTargetId: null },
    })

    expect(result.rescuedPlayerIds).toEqual(['chau'])
    expect(result.finalDeaths).toEqual([])
    expect(result.resourcesAfter).toMatchObject({
      resurrectionAvailable: false,
      poisonAvailable: true,
    })
    expect(input().preWitchEffects[0]).toMatchObject({
      id: 'wolf-effect',
      sourceType: 'WOLF_ATTACK',
      outcome: 'UNBLOCKED',
    })
  })

  it('finalizes an unresolved Wolf candidate when Witch does nothing', () => {
    expect(finalizeWitchCheckpoint(input()).finalDeaths).toEqual([
      { playerId: 'chau', sourceEffectIds: ['wolf-effect'] },
    ])
  })

  it('does not expose a Protector-blocked target as a resurrection candidate', () => {
    const resolution = resolveNightEffects(
      [createWolfAttackEffect('wolf-effect', 'chau')],
      'chau',
    )
    const blocked = input('chau', {
      provisionalDeathCandidateIds:
        resolution.provisionalDeathCandidateIds,
      preWitchEffects: resolution.effects,
    })

    expect(getWitchCapabilities(blocked).resurrectionCandidateIds).toEqual([])
    expect(finalizeWitchCheckpoint(blocked).finalDeaths).toEqual([])
  })

  it('denies resurrection when Witch is attacked and finalizes Witch dead', () => {
    const attacked = input('witch-player')
    expect(
      getWitchCapabilities(attacked),
    ).toMatchObject({ attackedThisNight: true, canResurrect: false })
    expectCode(
      () =>
        finalizeWitchCheckpoint({
          ...attacked,
          decision: {
            resurrectionTargetId: 'witch-player',
            poisonTargetId: null,
          },
        }),
      'WITCH_ATTACKED_CANNOT_RESURRECT',
    )
    expect(finalizeWitchCheckpoint(attacked).finalDeaths[0].playerId).toBe(
      'witch-player',
    )
  })

  it('allows an attacked Witch to poison as a last action on Night 2', () => {
    const result = finalizeWitchCheckpoint({
      ...input('witch-player', { nightNumber: 2 }),
      poisonEffectId: 'poison-effect',
      decision: { resurrectionTargetId: null, poisonTargetId: 'chau' },
    })

    expect(result.finalDeaths).toEqual([
      { playerId: 'witch-player', sourceEffectIds: ['wolf-effect'] },
      { playerId: 'chau', sourceEffectIds: ['poison-effect'] },
    ])
  })

  it('denies poison on Night 1 and denies self poison on Night 2', () => {
    expectCode(
      () =>
        finalizeWitchCheckpoint({
          ...input(),
          poisonEffectId: 'poison-effect',
          decision: { resurrectionTargetId: null, poisonTargetId: 'minh' },
        }),
      'WITCH_POISON_FORBIDDEN_NIGHT_ONE',
    )
    expectCode(
      () =>
        finalizeWitchCheckpoint({
          ...input('chau', { nightNumber: 2 }),
          poisonEffectId: 'poison-effect',
          decision: {
            resurrectionTargetId: null,
            poisonTargetId: 'witch-player',
          },
        }),
      'WITCH_POISON_SELF_TARGET',
    )
  })

  it('makes Witch poison lethal and explicitly non-Protector-blockable', () => {
    expect(createWitchPoisonEffect('poison-effect', 'chau')).toEqual({
      id: 'poison-effect',
      sourceType: 'WITCH_POISON',
      sourceRoleId: 'witch',
      category: 'NON_VILLAIN_LETHAL_EFFECT',
      targetPlayerId: 'chau',
      lethal: true,
      protectorBlockable: false,
    })
  })

  it('uses resurrection and poison atomically in the same Night', () => {
    const result = finalizeWitchCheckpoint({
      ...input('chau', { nightNumber: 2 }),
      poisonEffectId: 'poison-effect',
      decision: { resurrectionTargetId: 'chau', poisonTargetId: 'minh' },
    })

    expect(result.rescuedPlayerIds).toEqual(['chau'])
    expect(result.finalDeaths).toEqual([
      { playerId: 'minh', sourceEffectIds: ['poison-effect'] },
    ])
    expect(result.resourcesAfter).toMatchObject({
      resurrectionAvailable: false,
      poisonAvailable: false,
    })
  })

  it('still kills a rescued pre-Witch target when poison targets the same Player', () => {
    const result = finalizeWitchCheckpoint({
      ...input('chau', { nightNumber: 2 }),
      poisonEffectId: 'poison-effect',
      decision: { resurrectionTargetId: 'chau', poisonTargetId: 'chau' },
    })

    expect(result.finalDeaths).toEqual([
      { playerId: 'chau', sourceEffectIds: ['poison-effect'] },
    ])
  })

  it('returns no death names when resurrection potion is gone', () => {
    const spent = input('chau', {
      resources: {
        witchPlayerId: 'witch-player',
        resurrectionAvailable: false,
        poisonAvailable: true,
      },
    })

    expect(getWitchCapabilities(spent).resurrectionCandidateIds).toEqual([])
    expectCode(
      () =>
        finalizeWitchCheckpoint({
          ...spent,
          decision: { resurrectionTargetId: 'chau', poisonTargetId: null },
        }),
      'WITCH_RESURRECTION_UNAVAILABLE',
    )
  })

  it('finalizes without Witch configured and denies actions for a prior-dead Witch', () => {
    expect(
      finalizeWitchCheckpoint({
        ...input(),
        witchPlayerId: null,
        witchAliveBeforeNight: false,
        resources: null,
      }).finalDeaths,
    ).toEqual([{ playerId: 'chau', sourceEffectIds: ['wolf-effect'] }])

    expectCode(
      () =>
        finalizeWitchCheckpoint({
          ...input(),
          witchAliveBeforeNight: false,
          decision: { resurrectionTargetId: 'chau', poisonTargetId: null },
        }),
      'WITCH_HAS_NO_LIVING_ACTOR',
    )
  })

  it('is deterministic, so persisted retries produce one logical result', () => {
    const finalizeInput = {
      ...input('chau', { nightNumber: 2 }),
      poisonEffectId: 'stable-poison-effect',
      decision: { resurrectionTargetId: 'chau', poisonTargetId: 'minh' },
    }

    expect(finalizeWitchCheckpoint(finalizeInput)).toEqual(
      finalizeWitchCheckpoint(finalizeInput),
    )
  })
})
