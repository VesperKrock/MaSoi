import type { RoomTransportKind } from '../../transport/room-transport'

export function LandingView({
  transportKind = 'LOCAL',
}: {
  transportKind?: RoomTransportKind
}) {
  const localSuffix = transportKind === 'LOCAL' ? '&transport=local' : ''
  const authorityLabel =
    transportKind === 'SUPABASE'
      ? 'Phòng thật · Đồng bộ nhiều thiết bị'
      : transportKind === 'LOCAL'
        ? 'DEV ONLY · Mô phỏng local trong cùng trình duyệt'
        : 'Máy chủ phòng chưa được cấu hình'
  return (
    <main className="entry-viewport zero-scroll-surface" data-player-viewport data-surface="landing">
      <div className="entry-brand" aria-hidden="true">M</div>
      <div className="entry-copy">
        <p className="eyebrow">Boardgame companion</p>
        <h1>MA SÓI</h1>
        <p>Thay thế bộ bài giấy và trí nhớ của Quản trò.</p>
      </div>
      <div className="entry-actions">
        <a className="button primary full link-button" href={`?screen=create${localSuffix}`} data-required-control>
          Tạo phòng
        </a>
        <a className="button secondary full link-button" href={`?screen=join${localSuffix}`} data-required-control>
          Vào phòng
        </a>
      </div>
      <small className="local-truth">{authorityLabel}</small>
    </main>
  )
}
