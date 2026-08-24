import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseEnvironment {
  url: string
  publishableKey: string
}

export type SupabaseEnvironmentResult =
  | { configured: true; value: SupabaseEnvironment }
  | { configured: false; error: string }

export function readSupabaseEnvironment(
  env: ImportMetaEnv = import.meta.env,
): SupabaseEnvironmentResult {
  const url = env.VITE_SUPABASE_URL?.trim() ?? ''
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (!url && !publishableKey) {
    return {
      configured: false,
      error: 'Máy chủ phòng chưa được cấu hình trên thiết bị này.',
    }
  }
  if (!url || !publishableKey) {
    return {
      configured: false,
      error: 'Cấu hình máy chủ phòng chưa đầy đủ. Vui lòng liên hệ Quản trò.',
    }
  }
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1') {
      throw new Error('invalid protocol')
    }
  } catch {
    return {
      configured: false,
      error: 'Địa chỉ máy chủ phòng không hợp lệ.',
    }
  }
  return { configured: true, value: { url, publishableKey } }
}

export function createBrowserSupabaseClient(
  environment: SupabaseEnvironment,
): SupabaseClient {
  return createClient(environment.url, environment.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })
}
