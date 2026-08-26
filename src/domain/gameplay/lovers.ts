export type CupidObjectiveStatus =
  | 'UNRESOLVED'
  | 'ACTIVE'
  | 'FALLBACK_VILLAGE'

export interface LoverCouple {
  id: string
  cupidPlayerId: string
  loverPlayerIds: [string, string]
  pairedNightNumber: 1
  pairedAt: number
}

export interface CupidObjectiveState {
  cupidPlayerId: string
  status: CupidObjectiveStatus
  changedAt: number
  reason?: 'CUPID_DEAD_BEFORE_PAIRING' | 'COUPLE_DEAD'
}

export interface CupidLoverState {
  couple: LoverCouple | null
  loverRevealAcknowledgedPlayerIds: string[]
  objective: CupidObjectiveState | null
}

export interface HeartbreakEffect {
  id: string
  sourceType: 'LOVER_HEARTBREAK'
  category: 'NON_VILLAIN_LETHAL_EFFECT'
  sourcePlayerId: string
  targetPlayerId: string
  coupleId: string
  lethal: true
  protectorBlockable: false
  witchInteractable: false
  finalized: true
}

export interface StabilizedDeath {
  playerId: string
  sourceEffectIds: string[]
}

export interface HunterDeathTrigger {
  hunterPlayerId: string
  targetPlayerId: string
  effectId: string
}

export interface DeathConsequenceResult {
  finalDeaths: StabilizedDeath[]
  heartbreakEffects: HeartbreakEffect[]
  hunterShotActivated: boolean
}

export class CupidPairingError extends Error {
  constructor(
    readonly code:
      | 'CUPID_PAIRING_NIGHT_ONE_ONLY'
      | 'CUPID_PAIR_ALREADY_EXISTS'
      | 'CUPID_NOT_LIVING_ACTOR'
      | 'CUPID_TARGETS_MUST_BE_DISTINCT'
      | 'CUPID_CANNOT_TARGET_SELF'
      | 'CUPID_TARGET_NOT_LIVING',
  ) {
    super(code)
    this.name = 'CupidPairingError'
  }
}

export function createInitialCupidLoverState(
  assignments: readonly { playerId: string; roleId: string }[],
  now = 0,
): CupidLoverState {
  const cupidPlayerId = assignments.find(
    (assignment) => assignment.roleId === 'cupid',
  )?.playerId
  return {
    couple: null,
    loverRevealAcknowledgedPlayerIds: [],
    objective: cupidPlayerId
      ? { cupidPlayerId, status: 'UNRESOLVED', changedAt: now }
      : null,
  }
}

export function pairLovers(input: {
  state: CupidLoverState
  coupleId: string
  cupidPlayerId: string
  targetPlayerIds: readonly [string, string]
  livingPlayerIds: readonly string[]
  nightNumber: number
  now: number
}): CupidLoverState {
  if (input.nightNumber !== 1) {
    throw new CupidPairingError('CUPID_PAIRING_NIGHT_ONE_ONLY')
  }
  if (input.state.couple) {
    throw new CupidPairingError('CUPID_PAIR_ALREADY_EXISTS')
  }
  if (
    input.state.objective?.cupidPlayerId !== input.cupidPlayerId ||
    !input.livingPlayerIds.includes(input.cupidPlayerId)
  ) {
    throw new CupidPairingError('CUPID_NOT_LIVING_ACTOR')
  }
  const [firstTargetId, secondTargetId] = input.targetPlayerIds
  if (firstTargetId === secondTargetId) {
    throw new CupidPairingError('CUPID_TARGETS_MUST_BE_DISTINCT')
  }
  if (
    firstTargetId === input.cupidPlayerId ||
    secondTargetId === input.cupidPlayerId
  ) {
    throw new CupidPairingError('CUPID_CANNOT_TARGET_SELF')
  }
  if (
    !input.livingPlayerIds.includes(firstTargetId) ||
    !input.livingPlayerIds.includes(secondTargetId)
  ) {
    throw new CupidPairingError('CUPID_TARGET_NOT_LIVING')
  }

  return {
    couple: {
      id: input.coupleId,
      cupidPlayerId: input.cupidPlayerId,
      loverPlayerIds: [firstTargetId, secondTargetId],
      pairedNightNumber: 1,
      pairedAt: input.now,
    },
    loverRevealAcknowledgedPlayerIds: [],
    objective: {
      cupidPlayerId: input.cupidPlayerId,
      status: 'ACTIVE',
      changedAt: input.now,
    },
  }
}

export function fallbackCupidWithoutPair(
  state: CupidLoverState,
  cupidPlayerId: string,
  now: number,
): CupidLoverState {
  if (
    state.couple ||
    state.objective?.cupidPlayerId !== cupidPlayerId ||
    state.objective.status === 'FALLBACK_VILLAGE'
  ) {
    return state
  }
  return {
    ...state,
    objective: {
      cupidPlayerId,
      status: 'FALLBACK_VILLAGE',
      changedAt: now,
      reason: 'CUPID_DEAD_BEFORE_PAIRING',
    },
  }
}

export function acknowledgeLoverReveal(
  state: CupidLoverState,
  playerId: string,
): CupidLoverState {
  if (!state.couple?.loverPlayerIds.includes(playerId)) return state
  if (state.loverRevealAcknowledgedPlayerIds.includes(playerId)) return state
  return {
    ...state,
    loverRevealAcknowledgedPlayerIds: [
      ...state.loverRevealAcknowledgedPlayerIds,
      playerId,
    ],
  }
}

export function getLoverPartnerId(
  state: CupidLoverState | null | undefined,
  playerId: string,
): string | null {
  const pair = state?.couple?.loverPlayerIds
  if (!pair) return null
  if (pair[0] === playerId) return pair[1]
  if (pair[1] === playerId) return pair[0]
  return null
}

export function reconcileCupidObjective(
  state: CupidLoverState,
  livingPlayerIds: readonly string[],
  now: number,
): CupidLoverState {
  if (!state.couple || state.objective?.status !== 'ACTIVE') return state
  const living = new Set(livingPlayerIds)
  if (state.couple.loverPlayerIds.some((playerId) => living.has(playerId))) {
    return state
  }
  return {
    ...state,
    objective: {
      cupidPlayerId: state.couple.cupidPlayerId,
      status: 'FALLBACK_VILLAGE',
      changedAt: now,
      reason: 'COUPLE_DEAD',
    },
  }
}

/**
 * Stabilizes consequences of already-final death truth. Heartbreak is created
 * only after Witch has had the one allowed resurrection checkpoint. A Hunter
 * shot can become effective if the Hunter enters the final set through the
 * chain, and the loop continues until no new death can be produced.
 */
export function stabilizeDeathConsequences(input: {
  initialFinalDeaths: readonly StabilizedDeath[]
  livingPlayerIdsBefore: readonly string[]
  couple: LoverCouple | null
  hunter?: HunterDeathTrigger | null
  suppressedEffectIds?: readonly string[]
  nextEffectId: () => string
}): DeathConsequenceResult {
  const livingBefore = new Set(input.livingPlayerIdsBefore)
  const sourceIdsByPlayer = new Map<string, string[]>()
  for (const death of input.initialFinalDeaths) {
    sourceIdsByPlayer.set(death.playerId, [...new Set(death.sourceEffectIds)])
  }
  const heartbreakEffects: HeartbreakEffect[] = []
  const suppressedEffectIds = new Set(input.suppressedEffectIds ?? [])
  let hunterShotActivated = false
  let changed = true

  while (changed) {
    changed = false

    if (input.couple) {
      const [firstLoverId, secondLoverId] = input.couple.loverPlayerIds
      for (const [sourcePlayerId, targetPlayerId] of [
        [firstLoverId, secondLoverId],
        [secondLoverId, firstLoverId],
      ] as const) {
        if (
          sourceIdsByPlayer.has(sourcePlayerId) &&
          !sourceIdsByPlayer.has(targetPlayerId) &&
          livingBefore.has(targetPlayerId)
        ) {
          const effect: HeartbreakEffect = {
            id: input.nextEffectId(),
            sourceType: 'LOVER_HEARTBREAK',
            category: 'NON_VILLAIN_LETHAL_EFFECT',
            sourcePlayerId,
            targetPlayerId,
            coupleId: input.couple.id,
            lethal: true,
            protectorBlockable: false,
            witchInteractable: false,
            finalized: true,
          }
          heartbreakEffects.push(effect)
          sourceIdsByPlayer.set(targetPlayerId, [effect.id])
          changed = true
        }
      }
    }

    if (
      input.hunter &&
      sourceIdsByPlayer.has(input.hunter.hunterPlayerId) &&
      !hunterShotActivated
    ) {
      hunterShotActivated = true
      if (!suppressedEffectIds.has(input.hunter.effectId)) {
        const sourceIds = sourceIdsByPlayer.get(input.hunter.targetPlayerId)
        if (sourceIds) {
          if (!sourceIds.includes(input.hunter.effectId)) {
            sourceIds.push(input.hunter.effectId)
          }
        } else if (livingBefore.has(input.hunter.targetPlayerId)) {
          sourceIdsByPlayer.set(input.hunter.targetPlayerId, [
            input.hunter.effectId,
          ])
          changed = true
        }
      }
    }
  }

  return {
    finalDeaths: [...sourceIdsByPlayer].map(
      ([playerId, sourceEffectIds]) => ({ playerId, sourceEffectIds }),
    ),
    heartbreakEffects,
    hunterShotActivated,
  }
}
