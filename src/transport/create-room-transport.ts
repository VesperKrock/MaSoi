import {
  createBrowserSupabaseClient,
  readSupabaseEnvironment,
} from '../lib/supabase'
import { LocalRoomTransport } from './local/local-room-transport'
import type { RoomTransport, RoomTransportKind } from './room-transport'
import { SupabaseRoomTransport } from './supabase/supabase-room-transport'
import { UnavailableRoomTransport } from './unavailable-room-transport'

export interface RoomTransportSelection {
  kind: RoomTransportKind
  reason: 'EXPLICIT_DEV_LOCAL' | 'SUPABASE_CONFIGURED' | 'CONFIG_UNAVAILABLE'
}

export function selectRoomTransport(
  env: ImportMetaEnv,
  development: boolean,
  requestedTransport: string | null,
): RoomTransportSelection {
  if (development && requestedTransport === 'local') {
    return { kind: 'LOCAL', reason: 'EXPLICIT_DEV_LOCAL' }
  }
  const environment = readSupabaseEnvironment(env)
  if (environment.configured) {
    return { kind: 'SUPABASE', reason: 'SUPABASE_CONFIGURED' }
  }
  return { kind: 'UNAVAILABLE', reason: 'CONFIG_UNAVAILABLE' }
}

export function createConfiguredRoomTransport(
  requestedTransport: string | null,
): RoomTransport {
  const selection = selectRoomTransport(
    import.meta.env,
    import.meta.env.DEV,
    requestedTransport,
  )
  if (selection.kind === 'LOCAL') return new LocalRoomTransport()
  const environment = readSupabaseEnvironment(import.meta.env)
  if (selection.kind === 'SUPABASE' && environment.configured) {
    return new SupabaseRoomTransport(
      createBrowserSupabaseClient(environment.value),
    )
  }
  return new UnavailableRoomTransport(
    environment.configured
      ? 'Không thể khởi tạo máy chủ phòng.'
      : environment.error,
  )
}
