import type { RoleId } from '../roles/classic-catalog'

export type NightEffectCategory =
  | 'HOSTILE_VILLAIN_ATTACK'
  | 'NON_VILLAIN_LETHAL_EFFECT'

export type NightEffectOutcome =
  | 'BLOCKED_BY_PROTECTOR'
  | 'UNBLOCKED'
  | 'HALF_WOLF_BITE_SCHEDULED'
  | 'IMMUNE_TO_WOLF_ATTACK'

export interface NightEffectConversion {
  kind: 'HALF_WOLF_TRANSFORMATION'
  dueNightNumber: number
}

export interface NightEffectActivationCondition {
  kind: 'SOURCE_PLAYER_FINAL_NIGHT_DEATH'
  sourcePlayerId: string
}

export type NightEffectActivationStatus =
  | 'CONDITIONAL'
  | 'ACTIVATED'
  | 'CANCELED_SOURCE_SURVIVED'

export interface NightEffectInput {
  id: string
  sourceType: string
  sourceRoleId?: RoleId
  category: NightEffectCategory
  targetPlayerId: string
  sourcePlayerId?: string
  coupleId?: string
  lethal: boolean
  protectorBlockable: boolean
  witchInteractable?: boolean
  conversion?: NightEffectConversion
  activationCondition?: NightEffectActivationCondition
  immunity?: {
    kind: 'WOLF_ATTACK_IMMUNITY'
    roleId: 'serial-killer'
  }
}

export interface ResolvedNightEffect extends NightEffectInput {
  outcome: NightEffectOutcome
  activationStatus?: NightEffectActivationStatus
  blockSourceType?: 'PROTECTOR_SHIELD'
  blockSourceRoleId?: 'protector'
}

export interface NightResolutionResult {
  outcome:
    | 'NO_ATTACK'
    | 'BLOCKED'
    | 'UNBLOCKED'
    | 'BITE_SCHEDULED'
    | 'IMMUNE'
  effects: ResolvedNightEffect[]
  provisionalDeathCandidateIds: string[]
}

export interface PersistedNightResolution extends NightResolutionResult {
  id: string
  nightNumber: number
  resolvedAt: number
}

export interface NightResolutionReadinessInput {
  configuredRoleIds: readonly RoleId[]
  calls: ReadonlyArray<{
    roleId: RoleId
    status: 'NOT_CALLED' | 'CALLED' | 'COMPLETED'
  }>
}

export interface NightResolutionReadiness {
  ready: boolean
  incompleteRoleIds: RoleId[]
}

const resolutionContributors: readonly RoleId[] = [
  'werewolf',
  'protector',
  'hunter',
  'serial-killer',
]

export function createWolfAttackEffect(
  id: string,
  targetPlayerId: string,
): NightEffectInput {
  return {
    id,
    sourceType: 'WOLF_ATTACK',
    sourceRoleId: 'werewolf',
    category: 'HOSTILE_VILLAIN_ATTACK',
    targetPlayerId,
    lethal: true,
    protectorBlockable: true,
  }
}

export function createWolfAttackAgainstSerialKillerEffect(
  id: string,
  targetPlayerId: string,
): NightEffectInput {
  return {
    ...createWolfAttackEffect(id, targetPlayerId),
    lethal: false,
    immunity: {
      kind: 'WOLF_ATTACK_IMMUNITY',
      roleId: 'serial-killer',
    },
  }
}

export function createSerialKillerAttackEffect(
  id: string,
  targetPlayerId: string,
  sourcePlayerId?: string,
): NightEffectInput {
  return {
    id,
    sourceType: 'SERIAL_KILLER_ATTACK',
    sourceRoleId: 'serial-killer',
    sourcePlayerId,
    category: 'HOSTILE_VILLAIN_ATTACK',
    targetPlayerId,
    lethal: true,
    protectorBlockable: true,
    witchInteractable: true,
  }
}

export function createHalfWolfBiteEffect(
  id: string,
  targetPlayerId: string,
  nightNumber: number,
): NightEffectInput {
  return {
    id,
    sourceType: 'WOLF_ATTACK',
    sourceRoleId: 'werewolf',
    category: 'HOSTILE_VILLAIN_ATTACK',
    targetPlayerId,
    lethal: false,
    protectorBlockable: true,
    conversion: {
      kind: 'HALF_WOLF_TRANSFORMATION',
      dueNightNumber: nightNumber + 1,
    },
  }
}

export function getNightResolutionReadiness(
  input: NightResolutionReadinessInput,
): NightResolutionReadiness {
  const configured = new Set(input.configuredRoleIds)
  const completed = new Set(
    input.calls
      .filter((call) => call.status === 'COMPLETED')
      .map((call) => call.roleId),
  )
  const incompleteRoleIds = resolutionContributors.filter(
    (roleId) => configured.has(roleId) && !completed.has(roleId),
  )
  return { ready: incompleteRoleIds.length === 0, incompleteRoleIds }
}

export function resolveNightEffects(
  effects: readonly NightEffectInput[],
  protectorIntentTargetId?: string | null,
): NightResolutionResult {
  const resolvedEffects = effects.map((effect): ResolvedNightEffect => {
    const blocked =
      effect.protectorBlockable &&
      protectorIntentTargetId !== null &&
      protectorIntentTargetId !== undefined &&
      effect.targetPlayerId === protectorIntentTargetId

    return blocked
      ? {
          ...effect,
          outcome: 'BLOCKED_BY_PROTECTOR',
          activationStatus: effect.activationCondition
            ? 'CONDITIONAL'
            : undefined,
          immunity: undefined,
          blockSourceType: 'PROTECTOR_SHIELD',
          blockSourceRoleId: 'protector',
        }
      : effect.conversion
        ? {
            ...effect,
            outcome: 'HALF_WOLF_BITE_SCHEDULED',
            activationStatus: effect.activationCondition
              ? 'CONDITIONAL'
              : undefined,
          }
        : effect.immunity
          ? {
              ...effect,
              outcome: 'IMMUNE_TO_WOLF_ATTACK',
              activationStatus: effect.activationCondition
                ? 'CONDITIONAL'
                : undefined,
            }
          : {
          ...effect,
          outcome: 'UNBLOCKED',
          activationStatus: effect.activationCondition
            ? 'CONDITIONAL'
            : undefined,
        }
  })

  const provisionalDeathCandidateIds = [
    ...new Set(
      resolvedEffects
        .filter(
          (effect) => effect.lethal && effect.outcome === 'UNBLOCKED',
        )
        .map((effect) => effect.targetPlayerId),
    ),
  ]

  return {
    outcome:
      resolvedEffects.length === 0
        ? 'NO_ATTACK'
        : resolvedEffects.some((effect) => effect.outcome === 'UNBLOCKED')
          ? 'UNBLOCKED'
          : resolvedEffects.some(
                (effect) => effect.outcome === 'HALF_WOLF_BITE_SCHEDULED',
              )
            ? 'BITE_SCHEDULED'
            : resolvedEffects.some(
                  (effect) => effect.outcome === 'IMMUNE_TO_WOLF_ATTACK',
                )
              ? 'IMMUNE'
              : 'BLOCKED',
    effects: resolvedEffects,
    provisionalDeathCandidateIds,
  }
}
