import { describe, expect, it } from 'vitest'
import {
  acknowledgeLoverReveal,
  createInitialCupidLoverState,
  fallbackCupidWithoutPair,
  getLoverPartnerId,
  pairLovers,
  reconcileCupidObjective,
  stabilizeDeathConsequences,
} from './lovers'

const assignments = [
  { playerId: 'cupid', roleId: 'cupid' },
  { playerId: 'lover-a', roleId: 'villager' },
  { playerId: 'lover-b', roleId: 'werewolf' },
  { playerId: 'hunter', roleId: 'hunter' },
  { playerId: 'target', roleId: 'villager' },
]

function paired() {
  return pairLovers({
    state: createInitialCupidLoverState(assignments),
    coupleId: 'couple-1',
    cupidPlayerId: 'cupid',
    targetPlayerIds: ['lover-a', 'lover-b'],
    livingPlayerIds: assignments.map((entry) => entry.playerId),
    nightNumber: 1,
    now: 10,
  })
}

describe('Cupid pairing and private relationship state', () => {
  it('pairs two distinct living non-Cupid Players once without changing roles', () => {
    const result = paired()
    expect(result.couple).toMatchObject({
      cupidPlayerId: 'cupid',
      loverPlayerIds: ['lover-a', 'lover-b'],
      pairedNightNumber: 1,
    })
    expect(result.objective?.status).toBe('ACTIVE')
    expect(assignments.map((entry) => entry.roleId)).toEqual([
      'cupid',
      'villager',
      'werewolf',
      'hunter',
      'villager',
    ])
  })

  it('denies duplicate targets, self-selection, dead targets, later Nights, and second pairs', () => {
    const base = createInitialCupidLoverState(assignments)
    const make = (overrides: Partial<Parameters<typeof pairLovers>[0]>) =>
      pairLovers({
        state: base,
        coupleId: 'couple-1',
        cupidPlayerId: 'cupid',
        targetPlayerIds: ['lover-a', 'lover-b'],
        livingPlayerIds: assignments.map((entry) => entry.playerId),
        nightNumber: 1,
        now: 10,
        ...overrides,
      })
    expect(() => make({ targetPlayerIds: ['lover-a', 'lover-a'] })).toThrow(
      'CUPID_TARGETS_MUST_BE_DISTINCT',
    )
    expect(() => make({ targetPlayerIds: ['cupid', 'lover-a'] })).toThrow(
      'CUPID_CANNOT_TARGET_SELF',
    )
    expect(() => make({ livingPlayerIds: ['cupid', 'lover-a'] })).toThrow(
      'CUPID_TARGET_NOT_LIVING',
    )
    expect(() => make({ nightNumber: 2 })).toThrow(
      'CUPID_PAIRING_NIGHT_ONE_ONLY',
    )
    expect(() => make({ state: paired() })).toThrow('CUPID_PAIR_ALREADY_EXISTS')
  })

  it('projects only the reciprocal partner and persists reveal acknowledgement', () => {
    const state = paired()
    expect(getLoverPartnerId(state, 'lover-a')).toBe('lover-b')
    expect(getLoverPartnerId(state, 'lover-b')).toBe('lover-a')
    expect(getLoverPartnerId(state, 'target')).toBeNull()
    const acknowledged = acknowledgeLoverReveal(state, 'lover-a')
    expect(acknowledged.loverRevealAcknowledgedPlayerIds).toEqual(['lover-a'])
    expect(acknowledgeLoverReveal(acknowledged, 'lover-a')).toEqual(
      acknowledged,
    )
  })

  it('falls back permanently for a dead pre-pair Cupid or a dead couple', () => {
    const initial = createInitialCupidLoverState(assignments)
    const deadCupid = fallbackCupidWithoutPair(initial, 'cupid', 20)
    expect(deadCupid.objective).toMatchObject({
      status: 'FALLBACK_VILLAGE',
      reason: 'CUPID_DEAD_BEFORE_PAIRING',
    })
    expect(fallbackCupidWithoutPair(deadCupid, 'cupid', 30)).toEqual(deadCupid)

    const active = paired()
    const coupleDead = reconcileCupidObjective(active, ['cupid', 'hunter'], 40)
    expect(coupleDead.objective).toMatchObject({
      status: 'FALLBACK_VILLAGE',
      reason: 'COUPLE_DEAD',
    })
    expect(reconcileCupidObjective(coupleDead, assignments.map((entry) => entry.playerId), 50)).toEqual(
      coupleDead,
    )
  })
})

describe('source-aware heartbreak fixpoint', () => {
  const couple = paired().couple
  const living = assignments.map((entry) => entry.playerId)

  it('does not trigger from a Witch-rescued provisional death', () => {
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [],
      livingPlayerIdsBefore: living,
      couple,
      nextEffectId: () => 'heartbreak-1',
    })
    expect(result.finalDeaths).toEqual([])
    expect(result.heartbreakEffects).toEqual([])
  })

  it('kills the surviving Lover after final death with a non-blockable effect', () => {
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'lover-a', sourceEffectIds: ['wolf-attack'] },
      ],
      livingPlayerIdsBefore: living,
      couple,
      nextEffectId: () => 'heartbreak-1',
    })
    expect(result.finalDeaths).toEqual([
      { playerId: 'lover-a', sourceEffectIds: ['wolf-attack'] },
      { playerId: 'lover-b', sourceEffectIds: ['heartbreak-1'] },
    ])
    expect(result.heartbreakEffects[0]).toMatchObject({
      sourceType: 'LOVER_HEARTBREAK',
      sourcePlayerId: 'lover-a',
      targetPlayerId: 'lover-b',
      protectorBlockable: false,
      witchInteractable: false,
    })
  })

  it('does not create duplicate heartbreak when both Lovers independently die', () => {
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'lover-a', sourceEffectIds: ['wolf'] },
        { playerId: 'lover-b', sourceEffectIds: ['poison'] },
      ],
      livingPlayerIdsBefore: living,
      couple,
      nextEffectId: () => 'unused',
    })
    expect(result.heartbreakEffects).toEqual([])
    expect(result.finalDeaths).toHaveLength(2)
  })

  it('activates a Night Hunter killed by heartbreak and continues through a Lover target', () => {
    const hunterCouple = {
      ...couple!,
      loverPlayerIds: ['lover-a', 'hunter'] as [string, string],
    }
    let sequence = 0
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'lover-a', sourceEffectIds: ['wolf'] },
      ],
      livingPlayerIdsBefore: living,
      couple: hunterCouple,
      hunter: {
        hunterPlayerId: 'hunter',
        targetPlayerId: 'lover-b',
        effectId: 'hunter-shot',
      },
      nextEffectId: () => `heartbreak-${++sequence}`,
    })
    expect(result.hunterShotActivated).toBe(true)
    expect(result.finalDeaths).toEqual([
      { playerId: 'lover-a', sourceEffectIds: ['wolf'] },
      { playerId: 'hunter', sourceEffectIds: ['heartbreak-1'] },
      { playerId: 'lover-b', sourceEffectIds: ['hunter-shot'] },
    ])
  })

  it('lets a Hunter shot kill a Lover and propagates heartbreak to the partner', () => {
    let sequence = 0
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'hunter', sourceEffectIds: ['wolf'] },
      ],
      livingPlayerIdsBefore: living,
      couple,
      hunter: {
        hunterPlayerId: 'hunter',
        targetPlayerId: 'lover-a',
        effectId: 'hunter-shot',
      },
      nextEffectId: () => `heartbreak-${++sequence}`,
    })
    expect(result.finalDeaths).toEqual([
      { playerId: 'hunter', sourceEffectIds: ['wolf'] },
      { playerId: 'lover-a', sourceEffectIds: ['hunter-shot'] },
      { playerId: 'lover-b', sourceEffectIds: ['heartbreak-1'] },
    ])
  })

  it('preserves Witch suppression of an already-active Hunter shot', () => {
    const result = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'hunter', sourceEffectIds: ['wolf'] },
      ],
      livingPlayerIdsBefore: living,
      couple,
      hunter: {
        hunterPlayerId: 'hunter',
        targetPlayerId: 'lover-a',
        effectId: 'hunter-shot',
      },
      suppressedEffectIds: ['hunter-shot'],
      nextEffectId: () => 'unused',
    })
    expect(result.hunterShotActivated).toBe(true)
    expect(result.finalDeaths).toEqual([
      { playerId: 'hunter', sourceEffectIds: ['wolf'] },
    ])
  })

  it('is stable when reconciled again from its finalized result', () => {
    let sequence = 0
    const first = stabilizeDeathConsequences({
      initialFinalDeaths: [
        { playerId: 'lover-a', sourceEffectIds: ['wolf'] },
      ],
      livingPlayerIdsBefore: living,
      couple,
      nextEffectId: () => `heartbreak-${++sequence}`,
    })
    const second = stabilizeDeathConsequences({
      initialFinalDeaths: first.finalDeaths,
      livingPlayerIdsBefore: living,
      couple,
      nextEffectId: () => `unexpected-${++sequence}`,
    })
    expect(second.finalDeaths).toEqual(first.finalDeaths)
    expect(second.heartbreakEffects).toEqual([])
  })
})
