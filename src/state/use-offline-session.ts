import { useCallback, useEffect, useState } from 'react'
import {
  createOfflineSessionState,
  reduceOfflineSession,
  type OfflineSessionCommand,
  type OfflineSessionState,
} from '../domain/offline/offline-session'
import {
  clearOfflineSession,
  inspectOfflineSession,
  saveOfflineSession,
  type OfflineSessionStorageStatus,
} from '../domain/offline/offline-storage'

export function useOfflineSession(): {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
  savedStatusAtEntry: OfflineSessionStorageStatus
  startNewSession: () => void
} {
  const [entry] = useState(() => inspectOfflineSession(window.localStorage))
  const [state, setState] = useState<OfflineSessionState>(
    () => entry.state ?? createOfflineSessionState(),
  )
  const [persistenceEnabled, setPersistenceEnabled] = useState(
    () => entry.status !== 'CORRUPT',
  )

  useEffect(() => {
    if (persistenceEnabled) {
      saveOfflineSession(window.localStorage, state)
    }
  }, [persistenceEnabled, state])

  const dispatch = useCallback((command: OfflineSessionCommand) => {
    setState((current) => reduceOfflineSession(current, command))
  }, [])

  const startNewSession = useCallback(() => {
    clearOfflineSession(window.localStorage)
    setState(createOfflineSessionState())
    setPersistenceEnabled(true)
  }, [])

  return {
    state,
    dispatch,
    savedStatusAtEntry: entry.status,
    startNewSession,
  }
}
