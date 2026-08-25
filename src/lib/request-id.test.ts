import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRequestId,
  initializeRequestId,
  requestIdUnavailableMessage,
  type SecureRandomSource,
} from './request-id'

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function deterministicSource(initialSeed = 0): SecureRandomSource {
  let seed = initialSeed
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (!(array instanceof Uint8Array)) throw new Error('Expected Uint8Array')
      for (let index = 0; index < array.length; index += 1) {
        array[index] = (seed + index) & 0xff
      }
      seed += 1
      return array
    },
  }
}

function productSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productSourceFiles(path)
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser-safe request IDs', () => {
  it('creates RFC4122-v4 IDs and produces a distinct ID per initialization', () => {
    const source = deterministicSource()
    const first = createRequestId(source)
    const second = createRequestId(source)

    expect(first).toMatch(uuidV4Pattern)
    expect(second).toMatch(uuidV4Pattern)
    expect(second).not.toBe(first)
  })

  it('works when crypto.randomUUID is absent but getRandomValues remains available', () => {
    const source = deterministicSource(41)
    vi.stubGlobal('crypto', { getRandomValues: source.getRandomValues })

    expect('randomUUID' in globalThis.crypto).toBe(false)
    expect(createRequestId()).toMatch(uuidV4Pattern)
  })

  it('never invokes Math.random as a fallback', () => {
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used')
    })

    expect(createRequestId(deterministicSource())).toMatch(uuidV4Pattern)
    expect(weakRandom).not.toHaveBeenCalled()
    expect(readFileSync('src/lib/request-id.ts', 'utf8')).not.toContain('Math.random')
  })

  it('returns a truthful visible initialization failure without secure entropy', () => {
    vi.stubGlobal('crypto', {})

    expect(initializeRequestId()).toEqual({
      ok: false,
      error: requestIdUnavailableMessage,
    })
  })

  it('keeps one lazy request ID for the mounted Create Room attempt', () => {
    const viewSource = readFileSync(
      'src/views/entry/create-room-view.tsx',
      'utf8',
    )

    expect(viewSource).toContain('useState(() => initializeRequestId())')
    expect(viewSource).toContain('createRequest.requestId')
    expect(viewSource).not.toContain('useRef(')
  })

  it('has no direct randomUUID dependency in browser product source', () => {
    const offenders = productSourceFiles('src').filter((file) =>
      readFileSync(file, 'utf8').includes('randomUUID'),
    )

    expect(offenders).toEqual([])
  })
})
