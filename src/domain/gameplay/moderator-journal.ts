import type { JournalEvent, MatchOutcome, RoomState } from '../game/types'

export const moderatorJournalFactKinds = [
  'ROLE_IDENTITIES_DISCOVERED',
  'WOLF_REVOTE_STARTED',
  'WOLF_FINAL_TARGET',
  'PROTECTOR_INTENT',
  'SEER_INSPECTION',
  'WOLF_ATTACK_CREATED',
  'SERIAL_KILLER_ATTACK_CREATED',
  'WITCH_RESURRECTION_USED',
  'WITCH_POISON_USED',
  'NIGHT_DEATH_FINALIZED',
  'HUNTER_SHOT_ACTIVATED',
  'CUPID_PAIR_CREATED',
  'LOVER_HEARTBREAK_CREATED',
  'HALF_WOLF_BITE_SCHEDULED',
  'HALF_WOLF_TRANSFORMED',
  'TRAITOR_CONVERTED_TO_VILLAGE',
  'DAY_VOTE_OPENED',
  'DAY_VOTE_RESOLVED',
  'DAY_CANDIDATE_LOCKED',
  'DAY_CANDIDATE_SPARED',
  'DAY_NO_CANDIDATE',
  'DAY_HANGING_CREATED',
  'HUNTER_REVENGE_RESOLVED',
  'MATCH_FINISHED',
] as const

export type ModeratorJournalFactKind =
  (typeof moderatorJournalFactKinds)[number]

export interface ModeratorJournalVoteTotal {
  targetName: string
  total: number
}

export interface ModeratorJournalFact {
  id: string
  phase: 'NIGHT' | 'DAY' | 'RESULT'
  cycleNumber: number
  kind: ModeratorJournalFactKind
  occurredAt: number
  actorName?: string
  roleName?: string
  targetName?: string
  relatedNames?: string[]
  resolution?: string
  totals?: ModeratorJournalVoteTotal[]
  sourceTypes?: string[]
  random?: boolean
}

export interface ModeratorJournalSnapshot {
  facts: ModeratorJournalFact[]
}

export interface ModeratorJournalLine {
  id: string
  text: string
  occurredAt: number
}

export interface ModeratorJournalSection {
  id: string
  title: string
  phase: ModeratorJournalFact['phase']
  cycleNumber: number
  lines: ModeratorJournalLine[]
}

function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case 'WOLF_ATTACK': return 'Ma Sói'
    case 'SERIAL_KILLER_ATTACK': return 'Sát Nhân Hàng Loạt'
    case 'WITCH_POISON': return 'Bình Độc'
    case 'HUNTER_SHOT': return 'Thợ Săn'
    case 'LOVER_HEARTBREAK': return 'Cặp Đôi'
    default: return sourceType
  }
}

function outcomeLine(outcome: string | undefined): string | undefined {
  switch (outcome as MatchOutcome | undefined) {
    case 'FOOL': return 'Kết quả: Thằng Ngố chiến thắng.'
    case 'WOLF': return 'Kết quả: Ma Sói chiến thắng.'
    case 'COUPLE': return 'Kết quả: Cặp Đôi chiến thắng.'
    case 'SERIAL_KILLER': return 'Kết quả: Sát Nhân Hàng Loạt chiến thắng.'
    case 'VILLAGE': return 'Kết quả: Dân Làng chiến thắng.'
    case 'DRAW': return 'Cả làng bị xóa sổ.'
    default: return undefined
  }
}

function factLines(fact: ModeratorJournalFact): string[] {
  const target = fact.targetName ?? 'Không ai'
  switch (fact.kind) {
    case 'ROLE_IDENTITIES_DISCOVERED':
      return fact.roleName && fact.relatedNames?.length
        ? [`${fact.roleName}: ${fact.relatedNames.join(', ')}.`]
        : []
    case 'WOLF_REVOTE_STARTED':
      return ['Phiếu Sói hòa → chọn lại.']
    case 'WOLF_FINAL_TARGET':
      return fact.targetName
        ? [fact.random
            ? `Phiếu Sói hòa → hệ thống chọn ngẫu nhiên ${target}.`
            : `Ma Sói chọn ${target}.`]
        : []
    case 'PROTECTOR_INTENT':
      return [`Bảo Vệ bảo vệ ${target}.`]
    case 'SEER_INSPECTION':
      return [`Tiên Tri soi ${target} → ${fact.resolution === 'WOLF' ? 'Sói' : 'Không phải Sói'}.`]
    case 'WOLF_ATTACK_CREATED':
      if (fact.resolution === 'BLOCKED_BY_PROTECTOR') {
        return [`Ma Sói tấn công ${target} — bị Bảo Vệ chặn.`]
      }
      if (fact.resolution === 'IMMUNE_TO_WOLF_ATTACK') {
        return [`Sói cắn ${target} → mục tiêu miễn nhiễm.`]
      }
      if (fact.resolution === 'HALF_WOLF_BITE_SCHEDULED') return []
      return [`Ma Sói tấn công ${target}.`]
    case 'SERIAL_KILLER_ATTACK_CREATED':
      return [fact.resolution === 'BLOCKED_BY_PROTECTOR'
        ? `Sát Nhân Hàng Loạt tấn công ${target} — bị Bảo Vệ chặn.`
        : `Sát Nhân Hàng Loạt tấn công ${target}.`]
    case 'WITCH_RESURRECTION_USED':
      return [`Phù Thủy hồi sinh ${target}.`, `${target} sống.`]
    case 'WITCH_POISON_USED':
      return [`Phù Thủy đầu độc ${target}.`]
    case 'NIGHT_DEATH_FINALIZED': {
      const sources = [...new Set(fact.sourceTypes ?? [])].map(sourceLabel)
      return [sources.length > 0
        ? `${target} chết do ${sources.join(' và ')}.`
        : `${target} chết trong Đêm.`]
    }
    case 'HUNTER_SHOT_ACTIVATED':
      return [`Thợ Săn bắn ${target}.`]
    case 'CUPID_PAIR_CREATED':
      return fact.relatedNames?.length === 2
        ? [`Cupid ghép đôi ${fact.relatedNames[0]} và ${fact.relatedNames[1]}.`]
        : []
    case 'LOVER_HEARTBREAK_CREATED':
      return [`${target} chết vì Cặp Đôi.`]
    case 'HALF_WOLF_BITE_SCHEDULED':
      return [`${target} (Bán Sói) bị Sói cắn → chờ hóa Sói.`]
    case 'HALF_WOLF_TRANSFORMED':
      return [`${target} đã hóa Sói.`]
    case 'TRAITOR_CONVERTED_TO_VILLAGE':
      return [`${target} (Kẻ Phản Bội) chuyển sang phe Dân.`]
    case 'DAY_VOTE_OPENED':
      return ['Bắt đầu bỏ phiếu.']
    case 'DAY_VOTE_RESOLVED': {
      const totals = (fact.totals ?? []).map(
        ({ targetName, total }) => `${targetName} — ${total} phiếu`,
      )
      const result = fact.resolution === 'TIE'
        ? 'Không ai bị treo cổ do hòa phiếu.'
        : fact.resolution === 'NO_VOTES'
          ? 'Không ai bị treo cổ vì tất cả bỏ phiếu trắng.'
          : undefined
      return [
        ...(totals.length > 0 ? [`Kết quả phiếu: ${totals.join('; ')}.`] : []),
        ...(result ? [result] : []),
      ]
    }
    case 'DAY_CANDIDATE_LOCKED':
      return [`${target} được đưa lên trăng trối.`]
    case 'DAY_CANDIDATE_SPARED':
      return [`${target} được tha.`]
    case 'DAY_NO_CANDIDATE':
      return ['Không ai được đưa lên trăng trối.']
    case 'DAY_HANGING_CREATED':
      return [`${target} bị treo cổ.`]
    case 'HUNTER_REVENGE_RESOLVED':
      return [fact.targetName
        ? `Thợ Săn trả thù và bắn ${target}.`
        : 'Thợ Săn không bắn ai.']
    case 'MATCH_FINISHED': {
      const line = outcomeLine(fact.resolution)
      return line ? [line] : []
    }
  }
}

function sectionTitle(fact: ModeratorJournalFact): string {
  if (fact.phase === 'RESULT') return 'KẾT QUẢ'
  return `${fact.phase === 'NIGHT' ? 'ĐÊM' : 'NGÀY'} ${fact.cycleNumber}`
}

export function buildModeratorJournalSections(
  snapshot: ModeratorJournalSnapshot,
): ModeratorJournalSection[] {
  const sections = new Map<string, ModeratorJournalSection>()
  const facts = [...snapshot.facts].sort(
    (left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id),
  )
  for (const fact of facts) {
    const lines = factLines(fact)
    if (lines.length === 0) continue
    const id = fact.phase === 'RESULT'
      ? 'RESULT'
      : `${fact.phase}-${fact.cycleNumber}`
    let section = sections.get(id)
    if (!section) {
      section = {
        id,
        title: sectionTitle(fact),
        phase: fact.phase,
        cycleNumber: fact.cycleNumber,
        lines: [],
      }
      sections.set(id, section)
    }
    lines.forEach((text, index) => {
      section?.lines.push({
        id: `${fact.id}:${index}`,
        text,
        occurredAt: fact.occurredAt,
      })
    })
  }
  return [...sections.values()]
}

function playerName(state: RoomState, playerId: unknown): string | undefined {
  if (typeof playerId !== 'string') return undefined
  return state.players.find((player) => player.id === playerId)?.alias
}

function localPhase(event: JournalEvent): ModeratorJournalFact['phase'] {
  if (event.type === 'MATCH_ENDED') return 'RESULT'
  return event.phase === 'DAY' ? 'DAY' : 'NIGHT'
}

function localFactKind(event: JournalEvent): ModeratorJournalFactKind | null {
  if (event.type === 'MATCH_ENDED') return 'MATCH_FINISHED'
  if (event.type === 'HANGING_RESULT') return 'DAY_VOTE_RESOLVED'
  if (event.type === 'TARGET_SELECTED' && event.actorRoleId === 'werewolf') {
    return 'WOLF_FINAL_TARGET'
  }
  return moderatorJournalFactKinds.includes(
    event.type as ModeratorJournalFactKind,
  )
    ? event.type as ModeratorJournalFactKind
    : null
}

function effectSourceType(event: JournalEvent): string | undefined {
  if (typeof event.metadata?.sourceType === 'string') {
    return event.metadata.sourceType
  }
  switch (event.type) {
    case 'WITCH_POISON_USED': return 'WITCH_POISON'
    case 'HUNTER_SHOT_CREATED': return 'HUNTER_SHOT'
    case 'LOVER_HEARTBREAK_CREATED': return 'LOVER_HEARTBREAK'
    case 'WOLF_ATTACK_CREATED': return 'WOLF_ATTACK'
    case 'SERIAL_KILLER_ATTACK_CREATED': return 'SERIAL_KILLER_ATTACK'
    default: return undefined
  }
}

function voteTotals(
  state: RoomState,
  event: JournalEvent,
): ModeratorJournalVoteTotal[] | undefined {
  if (event.type !== 'HANGING_RESULT' || !event.metadata?.counts) return undefined
  const counts = event.metadata.counts
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) {
    return undefined
  }
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([playerId, total]) => ({
      targetName: playerName(state, playerId) ?? 'Không rõ',
      total,
    }))
    .filter(({ total }) => total > 0)
    .sort((left, right) => right.total - left.total || left.targetName.localeCompare(right.targetName, 'vi'))
}

/** Local transport counterpart of the server read model. */
export function projectLocalModeratorJournal(
  state: RoomState,
): ModeratorJournalSnapshot {
  const sourceByEffectId = new Map<string, string>()
  for (const event of state.journal) {
    const effectId = event.metadata?.effectId
    const sourceType = effectSourceType(event)
    if (typeof effectId === 'string' && sourceType) {
      sourceByEffectId.set(effectId, sourceType)
    }
  }
  const facts = state.journal.flatMap((event): ModeratorJournalFact[] => {
    const kind = localFactKind(event)
    if (!kind) return []
    const relatedIds = Array.isArray(event.metadata?.loverPlayerIds)
      ? event.metadata.loverPlayerIds
      : []
    let sourceTypes = Array.isArray(event.metadata?.sourceTypes)
      ? event.metadata.sourceTypes.filter((value): value is string => typeof value === 'string')
      : undefined
    if (event.type === 'NIGHT_DEATH_FINALIZED') {
      const sourceEffectIds = Array.isArray(event.metadata?.sourceEffectIds)
        ? event.metadata.sourceEffectIds
        : []
      sourceTypes = sourceEffectIds
        .map((effectId) => typeof effectId === 'string' ? sourceByEffectId.get(effectId) : undefined)
        .filter((value): value is string => Boolean(value))
    }
    return [{
      id: event.id,
      phase: localPhase(event),
      cycleNumber: event.dayNumber,
      kind: kind as ModeratorJournalFactKind,
      occurredAt: event.timestamp,
      actorName: playerName(state, event.actorPlayerId),
      targetName: playerName(state, event.targetPlayerId),
      relatedNames: relatedIds
        .map((playerId) => playerName(state, playerId))
        .filter((name): name is string => Boolean(name)),
      resolution: event.type === 'MATCH_ENDED'
        ? state.matchResult?.outcome
        : event.resolution,
      totals: voteTotals(state, event),
      sourceTypes,
      random: event.metadata?.random === true,
    }]
  })
  return { facts }
}
