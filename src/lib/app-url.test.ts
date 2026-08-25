import { describe, expect, it } from 'vitest'
import { appUrl, publicAssetUrl } from './app-url'

describe('GitHub Pages base-aware URLs', () => {
  it('keeps query routing under the project-site base path', () => {
    expect(appUrl('?screen=create', '/MaSoi/')).toBe('/MaSoi/?screen=create')
    expect(appUrl('screen=join', '/MaSoi')).toBe('/MaSoi/?screen=join')
  })

  it('resolves public assets under the project-site base path', () => {
    expect(
      publicAssetUrl('/assets/cards/classic/Tiên Tri.jpg', '/MaSoi/'),
    ).toBe('/MaSoi/assets/cards/classic/Tiên Tri.jpg')
  })

  it('preserves the root base used by local development', () => {
    expect(appUrl('?transport=local', '/')).toBe('/?transport=local')
    expect(publicAssetUrl('assets/card.jpg', '/')).toBe('/assets/card.jpg')
  })
})
