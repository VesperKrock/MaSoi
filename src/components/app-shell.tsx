import type { ReactNode } from 'react'

interface AppShellProps {
  roomCode?: string
  children: ReactNode
}

export function AppShell({ roomCode, children }: AppShellProps) {
  return (
    <div className="app-shell moderator-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">M</span>
          <span>
            <strong>MaSoi</strong>
            <small>{roomCode ? `PHÒNG ${roomCode}` : 'BOARDGAME COMPANION'}</small>
          </span>
        </a>
        <nav aria-label="Điều hướng Quản trò">
          <span className="local-badge">LOCAL · CÙNG TRÌNH DUYỆT</span>
          <a href="/">Trang chủ</a>
        </nav>
      </header>
      {children}
    </div>
  )
}
