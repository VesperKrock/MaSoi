import { useCallback, useEffect, useState } from 'react'
import type { RoomCommand } from '../domain/game/types'
import type { RoomTransport } from '../transport/room-transport'
import type { RoomAudience, RoomSnapshot } from './room-projection'

export function useRoom(
  transport: RoomTransport,
  roomId: string,
  audience: RoomAudience,
): {
  snapshot: RoomSnapshot | null
  error: string | null
  dispatch: (command: RoomCommand) => Promise<boolean>
  clearError: () => void
} {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const audienceKind = audience.kind
  const audiencePlayerId = audience.kind === 'PLAYER' ? audience.playerId : ''

  useEffect(() => {
    let active = true
    void transport.getSnapshot(roomId, audience).then(
      (nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot)
      },
      (reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Không thể mở phòng.',
          )
        }
      },
    )
    const unsubscribe = transport.subscribe(roomId, audience, setSnapshot)
    return () => {
      active = false
      unsubscribe()
    }
    // The scalar identity values avoid re-subscribing for an equivalent object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, roomId, audienceKind, audiencePlayerId])

  const dispatch = useCallback(
    async (command: RoomCommand) => {
      setError(null)
      const result = await transport.dispatch(roomId, command)
      if (!result.ok) {
        setError(result.error ?? 'Lệnh không thành công.')
      }
      return result.ok
    },
    [roomId, transport],
  )

  return {
    snapshot,
    error,
    dispatch,
    clearError: () => setError(null),
  }
}
