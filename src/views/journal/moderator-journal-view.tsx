import {
  buildModeratorJournalSections,
  type ModeratorJournalSnapshot,
} from '../../domain/gameplay/moderator-journal'

export function ModeratorJournalView({
  journal,
  onClose,
}: {
  journal: ModeratorJournalSnapshot
  onClose: () => void
}) {
  const sections = buildModeratorJournalSections(journal)

  return (
    <main className="moderator-layout moderator-journal-view">
      <header className="phase-heading moderator-journal-heading">
        <div>
          <p className="eyebrow">Riêng tư · Chỉ Quản trò</p>
          <h1>Nhật ký</h1>
          <p className="moderator-journal-order">Theo thời gian · cũ nhất đến mới nhất</p>
        </div>
        <button className="button secondary" onClick={onClose}>
          Quay lại
        </button>
      </header>

      {sections.length === 0 ? (
        <section className="panel moderator-journal-empty">
          <p>Chưa có sự kiện gameplay có ý nghĩa để ghi lại.</p>
        </section>
      ) : (
        <div className="moderator-journal-sections">
          {sections.map((section) => (
            <section className="panel moderator-journal-section" key={section.id}>
              <div className="section-title">
                <h2>{section.title}</h2>
                <span>{section.lines.length} dòng</span>
              </div>
              <ul>
                {section.lines.map((line) => (
                  <li key={line.id}>{line.text}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
