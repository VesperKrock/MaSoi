import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')

describe('Player zero-scroll CSS contract', () => {
  it('locks every player/entry surface to 100dvh with hidden overflow', () => {
    expect(styles).toContain('body:has(.zero-scroll-surface)')
    expect(styles).toMatch(/\.zero-scroll-surface\s*\{[^}]*height:\s*100dvh;/s)
    expect(styles).toMatch(/\.zero-scroll-surface\s*\{[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.player-stage\s*\{[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.name-modal\s*\{[^}]*overflow:\s*hidden;/s)
  })

  it('uses a four-column compact target grid for the 16-player worst case', () => {
    expect(styles).toMatch(
      /\.compact-action \.target-list\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s,
    )
    expect(styles).not.toMatch(
      /\.compact-action \.target-list\s*\{[^}]*overflow:\s*(auto|scroll)/s,
    )
  })

  it('does not apply the zero-scroll class to Moderator roots', () => {
    expect(styles).toContain('Moderator create-room / role-market is deliberately scrollable')
    expect(styles).not.toMatch(/\.moderator-layout[^}]*overflow:\s*hidden/s)
    expect(styles).not.toMatch(/\.create-room-layout[^}]*overflow:\s*hidden/s)
  })
})
