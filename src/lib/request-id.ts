export interface SecureRandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T
}

export const requestIdUnavailableMessage =
  'Trình duyệt này không cung cấp bộ sinh số ngẫu nhiên an toàn. Vui lòng dùng trình duyệt hiện đại rồi thử lại.'

export class RequestIdUnavailableError extends Error {
  readonly code = 'SECURE_RANDOM_UNAVAILABLE'

  constructor() {
    super(requestIdUnavailableMessage)
    this.name = 'RequestIdUnavailableError'
  }
}

export type RequestIdInitialization =
  | { ok: true; requestId: string }
  | { ok: false; error: string }

export function createRequestId(
  source: SecureRandomSource | null = globalThis.crypto ?? null,
): string {
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new RequestIdUnavailableError()
  }

  const bytes = new Uint8Array(16)
  try {
    source.getRandomValues(bytes)
  } catch {
    throw new RequestIdUnavailableError()
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

export function initializeRequestId(): RequestIdInitialization {
  try {
    return { ok: true, requestId: createRequestId() }
  } catch {
    return { ok: false, error: requestIdUnavailableMessage }
  }
}
