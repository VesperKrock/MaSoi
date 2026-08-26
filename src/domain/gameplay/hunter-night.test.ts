import { describe, expect, it } from 'vitest'
import { createWolfAttackEffect } from './night-resolution'
import {
  createHunterShotEffect,
  resolveNightEffectsWithHunter,
} from './hunter-night'
import { finalizeWitchCheckpoint } from './witch-checkpoint'

const players = [
  { id: 'hunter-player', alive: true },
  { id: 'shot-target', alive: true },
  { id: 'witch-player', alive: true },
  { id: 'other-target', alive: true },
]

function hunterResolution() {
  return resolveNightEffectsWithHunter(
    [createWolfAttackEffect('wolf-effect', 'hunter-player')],
    'shot-target',
    {
      hunterPlayerId: 'hunter-player',
      targetPlayerId: 'shot-target',
    },
    'hunter-shot-effect',
  )
}

function finalize(
  resurrectionTargetId: string | null,
  preWitchEffects = hunterResolution().effects,
  provisionalDeathCandidateIds =
    hunterResolution().provisionalDeathCandidateIds,
) {
  return finalizeWitchCheckpoint({
    nightNumber: 1,
    witchPlayerId: 'witch-player',
    witchAliveBeforeNight: true,
    provisionalDeathCandidateIds,
    preWitchEffects,
    players,
    resources: {
      witchPlayerId: 'witch-player',
      resurrectionAvailable: true,
      poisonAvailable: true,
    },
    decision: { resurrectionTargetId, poisonTargetId: null },
  })
}

describe('MS-1D1 Hunter Night pre-lock and conditional death trigger', () => {
  it('creates a source-aware conditional shot only when Hunter is provisional', () => {
    const result = hunterResolution()

    expect(result.provisionalDeathCandidateIds).toEqual([
      'hunter-player',
      'shot-target',
    ])
    expect(result.effects[1]).toEqual({
      ...createHunterShotEffect(
        'hunter-shot-effect',
        'hunter-player',
        'shot-target',
      ),
      outcome: 'UNBLOCKED',
      activationStatus: 'CONDITIONAL',
    })
  })

  it('keeps a surviving Hunter shot conditional without creating a victim, and Nobody creates no effect', () => {
    const survives = resolveNightEffectsWithHunter(
      [createWolfAttackEffect('wolf-effect', 'other-target')],
      null,
      {
        hunterPlayerId: 'hunter-player',
        targetPlayerId: 'shot-target',
      },
      'hunter-shot-effect',
    )
    const nobody = resolveNightEffectsWithHunter(
      [createWolfAttackEffect('wolf-effect', 'hunter-player')],
      null,
      { hunterPlayerId: 'hunter-player', targetPlayerId: null },
      'hunter-shot-effect',
    )

    expect(survives.effects).toHaveLength(2)
    expect(survives.effects[1]).toMatchObject({
      sourceType: 'HUNTER_SHOT',
      activationStatus: 'CONDITIONAL',
    })
    expect(survives.provisionalDeathCandidateIds).toEqual(['other-target'])
    expect(nobody.effects).toHaveLength(1)
    expect(nobody.provisionalDeathCandidateIds).toEqual(['hunter-player'])
  })

  it('activates the shot when Hunter finally dies and Protector cannot block it', () => {
    const result = finalize(null)

    expect(result.conditionalEffectStates).toEqual([
      { effectId: 'hunter-shot-effect', status: 'ACTIVATED' },
    ])
    expect(result.finalDeaths).toEqual([
      { playerId: 'hunter-player', sourceEffectIds: ['wolf-effect'] },
      {
        playerId: 'shot-target',
        sourceEffectIds: ['hunter-shot-effect'],
      },
    ])
    expect(hunterResolution().effects[1]).toMatchObject({
      protectorBlockable: false,
      outcome: 'UNBLOCKED',
    })
  })

  it('cancels the shot when Witch resurrects Hunter', () => {
    const result = finalize('hunter-player')

    expect(result.conditionalEffectStates).toEqual([
      {
        effectId: 'hunter-shot-effect',
        status: 'CANCELED_SOURCE_SURVIVED',
      },
    ])
    expect(result.finalDeaths).toEqual([])
  })

  it('keeps the shot active but rescues its victim when Witch selects that victim', () => {
    const result = finalize('shot-target')

    expect(result.conditionalEffectStates).toEqual([
      { effectId: 'hunter-shot-effect', status: 'ACTIVATED' },
    ])
    expect(result.finalDeaths).toEqual([
      { playerId: 'hunter-player', sourceEffectIds: ['wolf-effect'] },
    ])
  })

  it('preserves an independent lethal source after Hunter resurrection cancels the shot', () => {
    const base = hunterResolution()
    const otherEffect = {
      id: 'other-lethal-effect',
      sourceType: 'FUTURE_NON_BLOCKABLE_SOURCE',
      category: 'NON_VILLAIN_LETHAL_EFFECT' as const,
      targetPlayerId: 'shot-target',
      lethal: true,
      protectorBlockable: false,
      outcome: 'UNBLOCKED' as const,
    }
    const result = finalize(
      'hunter-player',
      [...base.effects, otherEffect],
      base.provisionalDeathCandidateIds,
    )

    expect(result.conditionalEffectStates[0].status).toBe(
      'CANCELED_SOURCE_SURVIVED',
    )
    expect(result.finalDeaths).toEqual([
      {
        playerId: 'shot-target',
        sourceEffectIds: ['other-lethal-effect'],
      },
    ])
  })
})
