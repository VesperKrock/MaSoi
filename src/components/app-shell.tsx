import type { ReactNode } from 'react'
import type { RoomTransportKind } from '../transport/room-transport'

interface AppShellProps {
  roomCode?: string
  transportKind?: RoomTransportKind
  children: ReactNode
}

export function AppShell({ roomCode, transportKind, children }: AppShellProps) {
  const homeHref = transportKind === 'LOCAL' ? '/?transport=local' : '/'
  const authorityLabel =
    transportKind === 'SUPABASE'
      ? 'SERVER · NHIỀU THIẾT BỊ'
      : transportKind === 'LOCAL'
        ? 'DEV LOCAL · CÙNG TRÌNH DUYỆT'
        : 'CHƯA KẾT NỐI SERVER'
  return (
    <div className="app-shell moderator-shell">
      <header className="topbar">
        <a className="brand" href={homeHref}>
          <span className="brand-mark">M</span>
          <span>
            <strong>MaSoi</strong>
            <small>{roomCode ? `PHÒNG ${roomCode}` : 'BOARDGAME COMPANION'}</small>
          </span>
        </a>
        <nav aria-label="Điều hướng Quản trò">
          <span className="local-badge">{authorityLabel}</span>
          <a href={homeHref}>Trang chủ</a>
        </nav>
      </header>
      {children}
    </div>
  )
}
