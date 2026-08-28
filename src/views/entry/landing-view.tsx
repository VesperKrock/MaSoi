import { appUrl } from '../../lib/app-url'
import { inspectOfflineSession } from '../../domain/offline/offline-storage'
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
  const offlineSession = inspectOfflineSession(window.localStorage)
  const offlineCopy =
    offlineSession.status === 'ACTIVE'
      ? {
          action: 'TIẾP TỤC VÁN OFFLINE',
          status: 'Đang có một ván Offline chưa kết thúc.',
        }
      : offlineSession.status === 'FINISHED'
        ? {
            action: 'XEM VÁN OFFLINE ĐÃ XONG',
            status: 'Ván Offline đã kết thúc vẫn được lưu trên máy.',
          }
        : offlineSession.status === 'CORRUPT'
          ? {
              action: 'KIỂM TRA DỮ LIỆU OFFLINE',
              status: 'Bản lưu Offline bị lỗi và sẽ không tự ghi đè.',
            }
          : {
              action: 'QUẢN TRÒ 1 MÁY',
              status: 'Chưa có ván Offline được lưu.',
            }
  const hasSavedOffline = offlineSession.status !== 'NONE'
  return (
    <main className="entry-viewport zero-scroll-surface" data-player-viewport data-surface="landing">
      <div className="entry-brand" aria-hidden="true">M</div>
      <div className="entry-copy">
        <p className="eyebrow">Boardgame companion</p>
        <h1>MA SÓI</h1>
        <p>Đồng hành cùng bộ bài vật lý và trí nhớ của Quản trò.</p>
      </div>
      <div className="entry-actions">
        <a className="button primary full link-button" href={appUrl(`?screen=create${localSuffix}`)} data-required-control>
          Tạo phòng
        </a>
        <a className="button secondary full link-button" href={appUrl(`?screen=join${localSuffix}`)} data-required-control>
          Vào phòng
        </a>
        <div className="offline-entry-state">
          <small>{offlineCopy.status}</small>
          {hasSavedOffline && (
            <a
              className="offline-new-session-link"
              href={appUrl('?screen=offline&intent=new')}
              data-required-control
            >
              Bắt đầu ván Offline mới
            </a>
          )}
        </div>
        <a
          className="button ghost full link-button offline-entry-action"
          href={appUrl('?screen=offline')}
          data-required-control
        >
          {offlineCopy.action}
        </a>
      </div>
      <small className="local-truth">{authorityLabel}</small>
    </main>
  )
}
