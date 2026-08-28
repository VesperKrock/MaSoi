import type { ReactNode } from 'react'
import { appUrl } from '../lib/app-url'
import type { RoomTransportKind } from '../transport/room-transport'

interface AppShellProps {
  roomCode?: string
  transportKind?: RoomTransportKind
  authorityMode?: 'ONLINE' | 'OFFLINE'
  children: ReactNode
}

export function AppShell({
  roomCode,
  transportKind,
  authorityMode = 'ONLINE',
  children,
}: AppShellProps) {
  const homeHref = appUrl(
    transportKind === 'LOCAL' ? '?transport=local' : '',
  )
  const authorityLabel =
    authorityMode === 'OFFLINE'
      ? 'OFFLINE · 1 THIẾT BỊ'
      : transportKind === 'SUPABASE'
      ? 'SERVER · NHIỀU THIẾT BỊ'
      : transportKind === 'LOCAL'
        ? 'DEV LOCAL · CÙNG TRÌNH DUYỆT'
        : 'CHƯA KẾT NỐI SERVER'
  return (
    <div
      className={`app-shell moderator-shell ${authorityMode === 'OFFLINE' ? 'offline-shell' : ''}`}
    >
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
