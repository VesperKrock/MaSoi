import type { PlayerId } from '../game/types'
import {
  resolveNightEffects,
  type NightEffectInput,
  type NightResolutionResult,
} from './night-resolution'

export interface HunterNightIntent {
  hunterPlayerId: PlayerId
  targetPlayerId: PlayerId | null
}

export function createHunterShotEffect(
  id: string,
  hunterPlayerId: PlayerId,
  targetPlayerId: PlayerId,
): NightEffectInput {
  return {
    id,
    sourceType: 'HUNTER_SHOT',
    sourceRoleId: 'hunter',
    category: 'NON_VILLAIN_LETHAL_EFFECT',
    targetPlayerId,
    lethal: true,
    protectorBlockable: false,
    activationCondition: {
      kind: 'SOURCE_PLAYER_FINAL_NIGHT_DEATH',
      sourcePlayerId: hunterPlayerId,
    },
  }
}

export function resolveNightEffectsWithHunter(
  baseEffects: readonly NightEffectInput[],
  protectorIntentTargetId: PlayerId | null | undefined,
  hunterIntent: HunterNightIntent | null,
  hunterShotEffectId?: string,
): NightResolutionResult {
  const base = resolveNightEffects(baseEffects, protectorIntentTargetId)
  if (!hunterIntent?.targetPlayerId) {
    return base
  }
  if (!hunterShotEffectId) {
    throw new Error('HUNTER_SHOT_EFFECT_ID_REQUIRED')
  }

  const shot = resolveNightEffects(
    [
      createHunterShotEffect(
        hunterShotEffectId,
        hunterIntent.hunterPlayerId,
        hunterIntent.targetPlayerId,
      ),
    ],
    protectorIntentTargetId,
  ).effects[0]

  return {
    outcome: base.outcome,
    effects: [...base.effects, shot],
    provisionalDeathCandidateIds: base.provisionalDeathCandidateIds.includes(
      hunterIntent.hunterPlayerId,
    )
      ? [
          ...new Set([
            ...base.provisionalDeathCandidateIds,
            hunterIntent.targetPlayerId,
          ]),
        ]
      : base.provisionalDeathCandidateIds,
  }
}
