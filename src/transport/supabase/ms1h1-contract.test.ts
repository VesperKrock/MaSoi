import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
} from './supabase-room-transport'

const migrationPath =
  'supabase/migrations/20260827170000_ms1h1_end_match_final_reveal.sql'
const sql = readFileSync(migrationPath, 'utf8')

const historicalHashes = new Map([
  ['20260825010000_ms1a_room_authority.sql', '0286f69d86225c880347ab847195b11ef9ee466b2b2ca66136fe0588bf6e2251'],
  ['20260825120000_ms1b1_night_action_authority.sql', '09e583bde835ea4c8092f7fb22db9179415e938c3379dc61929063b18183ecbf'],
  ['20260825150000_ms1b2_night_resolution_primitive.sql', '69ec281e80230338dae5de73e3d22207e9bdca3c72bf4de50a573ec5a880d93f'],
  ['20260825190000_ms1c_witch_final_night_checkpoint.sql', '0bcab8279e4e84982abbeb4a3901512f874d1bfb467b20991dce876e4bf5f46b'],
  ['20260826090000_ms1d1_hunter_night_morning.sql', '4ddb1df05c221a158a01170a5830151aed99789fa448bf00ca1160b6b372ccef'],
  ['20260826130000_ms1d2_day_vote_hunter_revenge_next_night.sql', '840a94285b135828ce5f1cf9bdc70a8e1e8c1cbf8507fe07ce40207175574663'],
  ['20260826170000_ms1e_faction_transitions.sql', '1799b26bdf57f65d58dad41b2bf694ff7f7331fc8b7e6e3ef9b6f84b00501f90'],
  ['20260826210000_ms1f_cupid_lovers_heartbreak.sql', '6b62e27c35143641f8b09357d386fd75c2ba8b02f5c77ce23945f12161edcb3c'],
  ['20260827010000_ms1g1_serial_killer_authority.sql', '6134c7495998c13ffe02ffd756e01c8854932ae2c8e6dc5e9cab53143d10035c'],
  ['20260827130000_ms1g2_fool_global_win_engine.sql', '73db515b838c618f355064dd349c1a552d92644e936a611117dc756e45cb93b1'],
])

const room = {
  id: 'room', code: '000001', seatCount: 2, status: 'FINISHED',
  phase: 'ENDED', dayNumber: 2, revision: 9,
  createdAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T01:00:00Z',
}
const endMatch = {
  outcome: 'COUPLE',
  subjects: [
    { id: 'cupid', seat: 1, displayName: 'An', alive: true },
    { id: 'lover', seat: 2, displayName: 'Bình', alive: true },
  ],
  roster: [
    {
      player: { id: 'cupid', seat: 1, displayName: 'An', alive: true },
      roleId: 'cupid',
    },
    {
      player: { id: 'lover', seat: 2, displayName: 'Bình', alive: true },
      roleId: 'half-wolf',
      runtimeNote: 'HALF_WOLF_TRANSFORMED',
      loverPartnerPlayerId: 'cupid',
    },
  ],
  couple: { cupidPlayerId: 'cupid', loverPlayerIds: ['lover', 'cupid'] },
}
const matchResult = {
  outcome: 'COUPLE',
  finishedAt: room.updatedAt,
  finishedPhase: 'DAY',
  dayNumber: 2,
  trigger: 'DAY_STABILIZED',
}

describe('MS-1H1 server and transport contract', () => {
  it('preserves all ten historical migrations and keeps H1 at its historical position', () => {
    const files = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort()
    expect(files[10]).toBe('20260827170000_ms1h1_end_match_final_reveal.sql')
    for (const [file, expected] of historicalHashes) {
      const hash = createHash('sha256')
        .update(readFileSync(`supabase/migrations/${file}`))
        .digest('hex')
      expect(hash, file).toBe(expected)
    }
  })

  it('projects final secrets only from an authoritative terminal match', () => {
    expect(sql).toContain("room.status = 'FINISHED'")
    expect(sql).toContain("room.phase = 'ENDED'")
    expect(sql).toContain("'endMatch', private.ms1h1_final_reveal_payload")
    expect(sql).toContain("'HALF_WOLF_TRANSFORMED'")
    expect(sql).toContain("'TRAITOR_CONVERTED_VILLAGE'")
    expect(sql).toContain("'loverPartnerPlayerId'")
    expect(sql).toContain('v_result.subject_player_ids')
  })

  it('keeps the reveal helper private and browser direct access revoked', () => {
    expect(sql).toMatch(
      /revoke execute on function private\.ms1h1_final_reveal_payload\(uuid\)\s+from public, anon, authenticated/,
    )
    expect(sql).not.toContain('create table')
    expect(sql).not.toContain('broadcast_changes')
  })

  it('hydrates the same authoritative end projection for Moderator and Player', () => {
    const moderator = moderatorSnapshotFromPayload({
      room,
      roleConfig: { cupid: 1, 'half-wolf': 1 },
      players: [
        { id: 'cupid', seat: 1, displayName: 'An', revealConfirmed: true, joinedAt: room.createdAt },
        { id: 'lover', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt },
      ],
      assignments: [
        { playerId: 'cupid', roleId: 'cupid', assignedAt: room.createdAt },
        { playerId: 'lover', roleId: 'half-wolf', assignedAt: room.createdAt },
      ],
      alivePlayerIds: ['cupid', 'lover'],
      matchResult,
      endMatch,
    })
    const player = playerSnapshotFromPayload({
      room,
      self: { id: 'lover', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt },
      players: [
        { id: 'cupid', seat: 1, displayName: 'An', revealConfirmed: true, joinedAt: room.createdAt },
        { id: 'lover', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt },
      ],
      assignment: { playerId: 'lover', roleId: 'half-wolf', assignedAt: room.createdAt },
      alivePlayerIds: ['cupid', 'lover'],
      matchResult,
      endMatch,
    })
    expect(moderator.audience === 'MODERATOR' && moderator.endMatch).toEqual(player.endMatch)
    expect(player.endMatch?.roster[1]).toMatchObject({
      roleId: 'half-wolf',
      runtimeNote: 'HALF_WOLF_TRANSFORMED',
      loverPartnerPlayerId: 'cupid',
    })
  })

  it('keeps pre-FINISHED player hydration free of final roster truth', () => {
    const player = playerSnapshotFromPayload({
      room: { ...room, status: 'STARTED', phase: 'NIGHT' },
      self: { id: 'lover', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt },
      players: [{ id: 'lover', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt }],
      assignment: { playerId: 'lover', roleId: 'half-wolf', assignedAt: room.createdAt },
      alivePlayerIds: ['lover'],
      endMatch: null,
    })
    expect(player.endMatch).toBeUndefined()
    expect(JSON.stringify(player)).not.toContain('cupid')
  })
})
