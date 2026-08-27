import { useState } from 'react'
import { playerLabel } from '../../components/player-label'
import {
  finalRevealPageSize,
  getOutcomePresentation,
  type EndMatchSnapshot,
  type FinalRosterEntry,
} from '../../domain/gameplay/end-match'
import { classicRoleById } from '../../domain/roles/classic-catalog'

function runtimeNote(entry: FinalRosterEntry): string | undefined {
  return entry.runtimeNote === 'HALF_WOLF_TRANSFORMED'
    ? 'Đã hóa Sói'
    : entry.runtimeNote === 'TRAITOR_CONVERTED_VILLAGE'
      ? 'Đã về Dân'
      : undefined
}

function subjectCopy(endMatch: EndMatchSnapshot): string | undefined {
  if (endMatch.subjects.length === 0) return undefined
  return endMatch.subjects.map(playerLabel).join(' · ')
}

function FinalRosterRow({
  entry,
  playerNameById,
}: {
  entry: FinalRosterEntry
  playerNameById: ReadonlyMap<string, string>
}) {
  const note = runtimeNote(entry)
  const loverName = entry.loverPartnerPlayerId
    ? playerNameById.get(entry.loverPartnerPlayerId)
    : undefined
  const relationshipNote = loverName ? `♡ ${loverName}` : undefined
  const finalNote = [note, relationshipNote].filter(Boolean).join(' · ')
  return (
    <article className={`final-roster-row ${entry.player.alive ? '' : 'dead'}`}>
      <span className="final-seat">{String(entry.player.seat).padStart(2, '0')}</span>
      <div className="final-player-role">
        <strong title={entry.player.alias}>{entry.player.alias}</strong>
        <span>{classicRoleById[entry.roleId].displayName}</span>
      </div>
      <small title={[note, loverName ? `Cặp đôi với ${loverName}` : ''].filter(Boolean).join(' · ')}>
        {finalNote || (entry.player.alive ? 'Sống' : 'Đã chết')}
      </small>
    </article>
  )
}

function ResultSummary({ endMatch }: { endMatch: EndMatchSnapshot }) {
  const presentation = getOutcomePresentation(endMatch.outcome)
  const subjects = subjectCopy(endMatch)
  return (
    <div className="end-result-copy">
      <p className="eyebrow">{presentation.eyebrow}</p>
      <div className="end-result-mark" aria-hidden="true">✦</div>
      <h1>{presentation.title}</h1>
      {subjects && <p className="end-subjects">{subjects}</p>}
    </div>
  )
}

export function PlayerEndMatch({
  endMatch,
  revealOpen,
  onRevealOpenChange,
  homeHref,
}: {
  endMatch: EndMatchSnapshot
  revealOpen: boolean
  onRevealOpenChange: (open: boolean) => void
  homeHref: string
}) {
  const [page, setPage] = useState(0)
  return revealOpen ? (
    <PlayerFinalRoster
      endMatch={endMatch}
      page={page}
      onPageChange={setPage}
      onBack={() => onRevealOpenChange(false)}
      homeHref={homeHref}
    />
  ) : (
    <section className="end-match-player end-result-player">
      <ResultSummary endMatch={endMatch} />
      <div className="end-match-actions">
        <button
          className="button primary full"
          onClick={() => onRevealOpenChange(true)}
          data-required-control
        >
          Xem vai trò
        </button>
        <a
          className="button secondary full link-button"
          href={homeHref}
          data-required-control
        >
          Về trang chủ
        </a>
      </div>
    </section>
  )
}

function PlayerFinalRoster({
  endMatch,
  page: requestedPage,
  onPageChange,
  onBack,
  homeHref,
}: {
  endMatch: EndMatchSnapshot
  page: number
  onPageChange: (page: number) => void
  onBack: () => void
  homeHref: string
}) {
  const pageCount = Math.max(1, Math.ceil(endMatch.roster.length / finalRevealPageSize))
  const page = Math.min(requestedPage, pageCount - 1)
  const entries = endMatch.roster.slice(
    page * finalRevealPageSize,
    (page + 1) * finalRevealPageSize,
  )
  const playerNameById = new Map(
    endMatch.roster.map((entry) => [entry.player.id, entry.player.alias]),
  )
  return (
    <section className="end-match-player end-roster-player">
      <header>
        <p className="eyebrow">VAI TRÒ CUỐI TRẬN</p>
        <h1>Danh sách vai trò</h1>
      </header>
      <div className="final-roster-list">
        {entries.map((entry) => (
          <FinalRosterRow
            key={entry.player.id}
            entry={entry}
            playerNameById={playerNameById}
          />
        ))}
      </div>
      <div className="final-pagination">
        <button
          className="button secondary"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          data-required-control
        >
          Trước
        </button>
        <strong>Trang {page + 1} / {pageCount}</strong>
        <button
          className="button secondary"
          disabled={page + 1 >= pageCount}
          onClick={() => onPageChange(page + 1)}
          data-required-control
        >
          Tiếp
        </button>
      </div>
      <div className="final-roster-actions">
        <button className="button ghost" onClick={onBack} data-required-control>
          Kết quả
        </button>
        <a
          className="button secondary link-button"
          href={homeHref}
          data-required-control
        >
          Về trang chủ
        </a>
      </div>
    </section>
  )
}

export function ModeratorEndMatch({
  endMatch,
  homeHref,
  onOpenJournal,
}: {
  endMatch: EndMatchSnapshot
  homeHref: string
  onOpenJournal: () => void
}) {
  const playerNameById = new Map(
    endMatch.roster.map((entry) => [entry.player.id, entry.player.alias]),
  )
  return (
    <main className="moderator-layout moderator-end-match">
      <section className="panel moderator-end-result">
        <ResultSummary endMatch={endMatch} />
        <div className="moderator-end-actions">
          <button className="button secondary" onClick={onOpenJournal}>
            Nhật ký
          </button>
          <a className="button primary link-button" href={homeHref}>
            Về trang chủ
          </a>
        </div>
      </section>
      <section className="panel moderator-final-roster">
        <div className="section-title">
          <div>
            <p className="eyebrow">CÔNG KHAI SAU KHI KẾT THÚC</p>
            <h2>Vai trò cuối trận</h2>
          </div>
          <strong>{endMatch.roster.length} người chơi</strong>
        </div>
        <div className="moderator-final-roster-grid">
          {endMatch.roster.map((entry) => (
            <FinalRosterRow
              key={entry.player.id}
              entry={entry}
              playerNameById={playerNameById}
            />
          ))}
        </div>
      </section>
    </main>
  )
}
