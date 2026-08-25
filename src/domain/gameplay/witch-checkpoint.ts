import type { PlayerId } from '../game/types'
import type {
  ResolvedNightEffect,
  NightEffectInput,
} from './night-resolution'

export interface WitchResources {
  witchPlayerId: PlayerId
  resurrectionAvailable: boolean
  poisonAvailable: boolean
}

export interface WitchDecision {
  resurrectionTargetId: PlayerId | null
  poisonTargetId: PlayerId | null
}

export interface WitchPlayerState {
  id: PlayerId
  alive: boolean
}

export interface WitchCapabilities {
  hasLivingActor: boolean
  attackedThisNight: boolean
  canResurrect: boolean
  canPoison: boolean
  resurrectionCandidateIds: PlayerId[]
  poisonCandidateIds: PlayerId[]
}

export interface FinalNightDeath {
  playerId: PlayerId
  sourceEffectIds: string[]
}

export interface WitchCheckpointResult {
  decision: WitchDecision
  rescuedPlayerIds: PlayerId[]
  poisonEffect: ResolvedNightEffect | null
  finalDeaths: FinalNightDeath[]
  resourcesAfter: WitchResources | null
}

export interface PersistedWitchCheckpoint extends WitchCheckpointResult {
  id: string
  nightNumber: number
  finalizedAt: number
}

export type WitchDecisionErrorCode =
  | 'WITCH_HAS_NO_LIVING_ACTOR'
  | 'WITCH_RESURRECTION_UNAVAILABLE'
  | 'WITCH_ATTACKED_CANNOT_RESURRECT'
  | 'WITCH_RESURRECTION_TARGET_NOT_CURRENT_CANDIDATE'
  | 'WITCH_POISON_UNAVAILABLE'
  | 'WITCH_POISON_FORBIDDEN_NIGHT_ONE'
  | 'WITCH_POISON_SELF_TARGET'
  | 'WITCH_POISON_TARGET_NOT_LIVING'
  | 'WITCH_POISON_EFFECT_ID_REQUIRED'

export class WitchDecisionError extends Error {
  constructor(readonly code: WitchDecisionErrorCode) {
    super(code)
    this.name = 'WitchDecisionError'
  }
}

export interface WitchCapabilityInput {
  nightNumber: number
  witchPlayerId: PlayerId | null
  witchAliveBeforeNight: boolean
  provisionalDeathCandidateIds: readonly PlayerId[]
  players: readonly WitchPlayerState[]
  resources: WitchResources | null
}

export interface FinalizeWitchCheckpointInput extends WitchCapabilityInput {
  preWitchEffects: readonly ResolvedNightEffect[]
  decision?: WitchDecision | null
  poisonEffectId?: string
}

export function getWitchCapabilities(
  input: WitchCapabilityInput,
): WitchCapabilities {
  const hasLivingActor =
    input.witchPlayerId !== null && input.witchAliveBeforeNight
  const attackedThisNight =
    input.witchPlayerId !== null &&
    input.provisionalDeathCandidateIds.includes(input.witchPlayerId)
  const resurrectionAvailable =
    hasLivingActor &&
    !attackedThisNight &&
    input.resources?.resurrectionAvailable === true
  const poisonAvailable =
    hasLivingActor &&
    input.nightNumber >= 2 &&
    input.resources?.poisonAvailable === true

  return {
    hasLivingActor,
    attackedThisNight,
    canResurrect: resurrectionAvailable,
    canPoison: poisonAvailable,
    resurrectionCandidateIds: resurrectionAvailable
      ? [...new Set(input.provisionalDeathCandidateIds)]
      : [],
    poisonCandidateIds: poisonAvailable
      ? input.players
          .filter(
            (player) =>
              player.alive && player.id !== input.witchPlayerId,
          )
          .map((player) => player.id)
      : [],
  }
}

export function createWitchPoisonEffect(
  id: string,
  targetPlayerId: PlayerId,
): NightEffectInput {
  return {
    id,
    sourceType: 'WITCH_POISON',
    sourceRoleId: 'witch',
    category: 'NON_VILLAIN_LETHAL_EFFECT',
    targetPlayerId,
    lethal: true,
    protectorBlockable: false,
  }
}

export function validateWitchDecision(
  input: FinalizeWitchCheckpointInput,
  decision: WitchDecision,
  capabilities: WitchCapabilities,
): void {
  if (
    !capabilities.hasLivingActor &&
    (decision.resurrectionTargetId !== null || decision.poisonTargetId !== null)
  ) {
    throw new WitchDecisionError('WITCH_HAS_NO_LIVING_ACTOR')
  }

  if (decision.resurrectionTargetId !== null) {
    if (!input.resources?.resurrectionAvailable) {
      throw new WitchDecisionError('WITCH_RESURRECTION_UNAVAILABLE')
    }
    if (capabilities.attackedThisNight) {
      throw new WitchDecisionError('WITCH_ATTACKED_CANNOT_RESURRECT')
    }
    if (
      !capabilities.resurrectionCandidateIds.includes(
        decision.resurrectionTargetId,
      )
    ) {
      throw new WitchDecisionError(
        'WITCH_RESURRECTION_TARGET_NOT_CURRENT_CANDIDATE',
      )
    }
  }

  if (decision.poisonTargetId !== null) {
    if (!input.resources?.poisonAvailable) {
      throw new WitchDecisionError('WITCH_POISON_UNAVAILABLE')
    }
    if (input.nightNumber < 2) {
      throw new WitchDecisionError('WITCH_POISON_FORBIDDEN_NIGHT_ONE')
    }
    if (decision.poisonTargetId === input.witchPlayerId) {
      throw new WitchDecisionError('WITCH_POISON_SELF_TARGET')
    }
    if (!capabilities.poisonCandidateIds.includes(decision.poisonTargetId)) {
      throw new WitchDecisionError('WITCH_POISON_TARGET_NOT_LIVING')
    }
    if (!input.poisonEffectId) {
      throw new WitchDecisionError('WITCH_POISON_EFFECT_ID_REQUIRED')
    }
  }
}

/**
 * Applies the final Night checkpoint without erasing any pre-Witch effect.
 * Resurrection suppresses a Player's pre-Witch lethal outcome; poison is then
 * appended as a distinct, non-Protector-blockable source.
 */
export function finalizeWitchCheckpoint(
  input: FinalizeWitchCheckpointInput,
): WitchCheckpointResult {
  const decision = input.decision ?? {
    resurrectionTargetId: null,
    poisonTargetId: null,
  }
  const capabilities = getWitchCapabilities(input)
  validateWitchDecision(input, decision, capabilities)

  const poisonEffectInput =
    decision.poisonTargetId === null
      ? null
      : createWitchPoisonEffect(
          input.poisonEffectId as string,
          decision.poisonTargetId,
        )
  const poisonEffect: ResolvedNightEffect | null = poisonEffectInput
    ? { ...poisonEffectInput, outcome: 'UNBLOCKED' }
    : null
  const effectiveEffects = [
    ...input.preWitchEffects.filter(
      (effect) =>
        effect.lethal &&
        effect.outcome === 'UNBLOCKED' &&
        effect.targetPlayerId !== decision.resurrectionTargetId,
    ),
    ...(poisonEffect ? [poisonEffect] : []),
  ]
  const sourceIdsByPlayer = new Map<PlayerId, string[]>()

  for (const effect of effectiveEffects) {
    const sourceIds = sourceIdsByPlayer.get(effect.targetPlayerId) ?? []
    sourceIds.push(effect.id)
    sourceIdsByPlayer.set(effect.targetPlayerId, sourceIds)
  }

  return {
    decision,
    rescuedPlayerIds:
      decision.resurrectionTargetId === null
        ? []
        : [decision.resurrectionTargetId],
    poisonEffect,
    finalDeaths: [...sourceIdsByPlayer].map(
      ([playerId, sourceEffectIds]) => ({ playerId, sourceEffectIds }),
    ),
    resourcesAfter:
      input.resources === null
        ? null
        : {
            ...input.resources,
            resurrectionAvailable:
              input.resources.resurrectionAvailable &&
              decision.resurrectionTargetId === null,
            poisonAvailable:
              input.resources.poisonAvailable &&
              decision.poisonTargetId === null,
          },
  }
}
