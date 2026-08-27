import { describe, expect, it } from 'vitest'
import {
  buildModeratorJournalSections,
  type ModeratorJournalFact,
} from './moderator-journal'

function fact(
  id: string,
  kind: ModeratorJournalFact['kind'],
  overrides: Partial<ModeratorJournalFact> = {},
): ModeratorJournalFact {
  return {
    id,
    kind,
    phase: 'NIGHT',
    cycleNumber: 1,
    occurredAt: Number(id.replace(/\D/g, '')) || 1,
    ...overrides,
  }
}

describe('MS-1H2 Moderator Journal read model', () => {
  it('groups stable chronological Night, Day, and persisted result sections', () => {
    const sections = buildModeratorJournalSections({ facts: [
      fact('3', 'MATCH_FINISHED', { phase: 'RESULT', resolution: 'VILLAGE', occurredAt: 30 }),
      fact('1', 'WOLF_FINAL_TARGET', { targetName: 'Long', occurredAt: 10 }),
      fact('2', 'DAY_VOTE_OPENED', { phase: 'DAY', occurredAt: 20 }),
    ] })
    expect(sections.map((section) => section.title)).toEqual(['ĐÊM 1', 'NGÀY 1', 'KẾT QUẢ'])
    expect(sections[0].lines[0].text).toBe('Ma Sói chọn Long.')
    expect(sections[2].lines[0].text).toBe('Kết quả: Dân Làng chiến thắng.')
  })

  it('renders source-aware multi-attack, protection, immunity, Seer, and Witch truth', () => {
    const sections = buildModeratorJournalSections({ facts: [
      fact('1', 'PROTECTOR_INTENT', { targetName: 'Long' }),
      fact('2', 'WOLF_ATTACK_CREATED', { targetName: 'Long', resolution: 'BLOCKED_BY_PROTECTOR' }),
      fact('3', 'SERIAL_KILLER_ATTACK_CREATED', { targetName: 'Long', resolution: 'BLOCKED_BY_PROTECTOR' }),
      fact('4', 'WOLF_ATTACK_CREATED', { targetName: 'Mai', resolution: 'IMMUNE_TO_WOLF_ATTACK' }),
      fact('5', 'SEER_INSPECTION', { targetName: 'Tú', resolution: 'WOLF' }),
      fact('6', 'WITCH_RESURRECTION_USED', { targetName: 'Hương' }),
      fact('7', 'WITCH_POISON_USED', { targetName: 'Châu' }),
      fact('8', 'NIGHT_DEATH_FINALIZED', { targetName: 'Châu', sourceTypes: ['WITCH_POISON'] }),
    ] })
    const copy = sections[0].lines.map((line) => line.text)
    expect(copy).toContain('Ma Sói tấn công Long — bị Bảo Vệ chặn.')
    expect(copy).toContain('Sát Nhân Hàng Loạt tấn công Long — bị Bảo Vệ chặn.')
    expect(copy).toContain('Sói cắn Mai → mục tiêu miễn nhiễm.')
    expect(copy).toContain('Tiên Tri soi Tú → Sói.')
    expect(copy).toContain('Phù Thủy hồi sinh Hương.')
    expect(copy).toContain('Hương sống.')
    expect(copy).not.toContain('Hương chết trong Đêm.')
    expect(copy).toContain('Châu chết do Bình Độc.')
  })

  it('preserves Hunter, Lovers, and faction transition narrative', () => {
    const copy = buildModeratorJournalSections({ facts: [
      fact('1', 'CUPID_PAIR_CREATED', { relatedNames: ['Hương', 'Tú'] }),
      fact('2', 'LOVER_HEARTBREAK_CREATED', { targetName: 'Tú' }),
      fact('3', 'HUNTER_SHOT_ACTIVATED', { targetName: 'Mai' }),
      fact('4', 'HALF_WOLF_BITE_SCHEDULED', { targetName: 'Hương' }),
      fact('5', 'HALF_WOLF_TRANSFORMED', { targetName: 'Hương', cycleNumber: 2 }),
      fact('6', 'TRAITOR_CONVERTED_TO_VILLAGE', { targetName: 'Tú', phase: 'DAY' }),
      fact('7', 'HUNTER_REVENGE_RESOLVED', { targetName: 'Nam', phase: 'DAY' }),
    ] }).flatMap((section) => section.lines.map((line) => line.text))
    expect(copy).toEqual(expect.arrayContaining([
      'Cupid ghép đôi Hương và Tú.',
      'Tú chết vì Cặp Đôi.',
      'Thợ Săn bắn Mai.',
      'Hương (Bán Sói) bị Sói cắn → chờ hóa Sói.',
      'Hương đã hóa Sói.',
      'Tú (Kẻ Phản Bội) chuyển sang phe Dân.',
      'Thợ Săn trả thù và bắn Nam.',
    ]))
  })

  it('shows weighted totals without voter identities and handles tie/no-votes', () => {
    const sections = buildModeratorJournalSections({ facts: [
      fact('1', 'DAY_VOTE_RESOLVED', {
        phase: 'DAY',
        resolution: 'TIE',
        totals: [{ targetName: 'Long', total: 4 }, { targetName: 'Hương', total: 4 }],
      }),
      fact('2', 'DAY_VOTE_RESOLVED', {
        phase: 'DAY', cycleNumber: 2, resolution: 'NO_VOTES', totals: [],
      }),
    ] })
    expect(sections[0].lines.map((line) => line.text)).toEqual([
      'Kết quả phiếu: Long — 4 phiếu; Hương — 4 phiếu.',
      'Không ai bị treo cổ do hòa phiếu.',
    ])
    expect(sections[1].lines[0].text).toBe('Không ai bị treo cổ vì tất cả bỏ phiếu trắng.')
    expect(JSON.stringify(sections)).not.toContain('voter')
  })

  it('consumes all six persisted outcomes without recalculating a winner', () => {
    const expected = {
      FOOL: 'Kết quả: Thằng Ngố chiến thắng.',
      WOLF: 'Kết quả: Ma Sói chiến thắng.',
      COUPLE: 'Kết quả: Cặp Đôi chiến thắng.',
      SERIAL_KILLER: 'Kết quả: Sát Nhân Hàng Loạt chiến thắng.',
      VILLAGE: 'Kết quả: Dân Làng chiến thắng.',
      DRAW: 'Cả làng bị xóa sổ.',
    }
    for (const [outcome, line] of Object.entries(expected)) {
      const sections = buildModeratorJournalSections({ facts: [
        fact(outcome, 'MATCH_FINISHED', { phase: 'RESULT', resolution: outcome }),
      ] })
      expect(sections[0].lines[0].text).toBe(line)
    }
  })
})
