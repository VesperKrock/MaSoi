import { useMemo } from 'react'
import { AppShell } from './components/app-shell'
import { appUrl } from './lib/app-url'
import { useRoom } from './state/use-room'
import type { RoomAudience } from './state/room-projection'
import type { RoomTransport } from './transport/room-transport'
import { CreateRoomView } from './views/entry/create-room-view'
import { JoinRoomView } from './views/entry/join-room-view'
import { LandingView } from './views/entry/landing-view'
import { ModeratorView } from './views/moderator/moderator-view'
import { PlayerView } from './views/player/player-view'
import { ZeroScrollHarness } from './views/dev/zero-scroll-harness'

interface AppProps {
  transport: RoomTransport
}

function RoomExperience({
  transport,
  roomId,
  audience,
}: {
  transport: RoomTransport
  roomId: string
  audience: RoomAudience
}) {
  const audienceKind = audience.kind
  const audiencePlayerId =
    audience.kind === 'PLAYER' ? audience.playerId : undefined
  const stableAudience = useMemo(
    (): RoomAudience =>
      audienceKind === 'PLAYER' && audiencePlayerId
        ? { kind: 'PLAYER', playerId: audiencePlayerId }
        : { kind: 'MODERATOR' },
    [audienceKind, audiencePlayerId],
  )
  const { snapshot, error, dispatch, clearError } = useRoom(
    transport,
    roomId,
    stableAudience,
  )
  const homeHref = appUrl(transport.kind === 'LOCAL' ? '?transport=local' : '')

  if (!snapshot) {
    return (
      <main className="entry-viewport zero-scroll-surface" data-player-viewport>
        <div className="entry-copy">
          <p className="eyebrow">
            {transport.kind === 'LOCAL' ? 'Phòng DEV local' : 'Phòng máy chủ'}
          </p>
          <h1>{error ? 'Không thể mở phòng' : 'Đang mở phòng…'}</h1>
          {error && <p>{error}</p>}
        </div>
        <a
          className="button primary link-button"
          href={appUrl(transport.kind === 'LOCAL' ? '?transport=local' : '')}
          data-required-control
        >
          Về trang chủ
        </a>
      </main>
    )
  }

  if (snapshot.audience === 'PLAYER') {
    return (
      <>
        {error && (
          <div className="player-error" role="alert" onClick={clearError}>
            {error}
          </div>
        )}
        <PlayerView
          snapshot={snapshot}
          dispatch={dispatch}
          homeHref={homeHref}
        />
      </>
    )
  }

  return (
    <AppShell roomCode={snapshot.state.roomCode} transportKind={transport.kind}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Đóng thông báo lỗi">×</button>
        </div>
      )}
      <ModeratorView
        state={snapshot.state}
        dispatch={dispatch}
        endMatch={snapshot.endMatch}
        homeHref={homeHref}
      />
    </AppShell>
  )
}

export function App({ transport }: AppProps) {
  const params = new URLSearchParams(window.location.search)
  if (import.meta.env.DEV && params.get('dev') === 'zero-scroll') {
    return <ZeroScrollHarness surface={params.get('surface') ?? 'landing'} />
  }
  const roomId = params.get('room')
  const playerId = params.get('player')
  const isModerator = params.get('as') === 'moderator'

  if (roomId && playerId) {
    return (
      <RoomExperience
        transport={transport}
        roomId={roomId}
        audience={{ kind: 'PLAYER', playerId }}
      />
    )
  }
  if (roomId && isModerator) {
    return (
      <RoomExperience
        transport={transport}
        roomId={roomId}
        audience={{ kind: 'MODERATOR' }}
      />
    )
  }

  const screen = params.get('screen')
  if (screen === 'create') return <CreateRoomView transport={transport} />
  if (screen === 'join') return <JoinRoomView transport={transport} />
  return <LandingView transportKind={transport.kind} />
}
