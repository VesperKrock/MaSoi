import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
} from './supabase-room-transport'

const migrationPath =
  'supabase/migrations/20260827190000_ms1h2_moderator_journal.sql'
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
  ['20260827170000_ms1h1_end_match_final_reveal.sql', '2d7631bac61c3823db2797dbbdda00b995a2c03b30043a1f9b678c055dbbe74d'],
])

const room = {
  id: 'room', code: '000001', seatCount: 2, status: 'IN_GAME',
  phase: 'NIGHT', dayNumber: 1, revision: 4,
  createdAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T01:00:00Z',
}

const journal = {
  facts: [
    {
      id: 'event-1', phase: 'NIGHT', cycleNumber: 1,
      kind: 'SEER_INSPECTION', occurredAt: '2026-08-27T00:30:00Z',
      actorName: 'An', targetName: 'Bình', resolution: 'NON_WOLF',
    },
    {
      id: 'event-2', phase: 'DAY', cycleNumber: 1,
      kind: 'DAY_VOTE_RESOLVED', occurredAt: '2026-08-27T01:00:00Z',
      resolution: 'TIE', totals: [
        { targetName: 'An', total: 2 },
        { targetName: 'Bình', total: 2 },
      ],
    },
  ],
}

describe('MS-1H2 private Moderator Journal contract', () => {
  it('preserves all eleven historical migrations and adds exactly one H2 migration', () => {
    const files = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort()
    expect(files.filter((file) => file <= '20260827190000_ms1h2_moderator_journal.sql')).toHaveLength(12)
    expect(files).toContain('20260827190000_ms1h2_moderator_journal.sql')
    for (const [file, expected] of historicalHashes) {
      const hash = createHash('sha256')
        .update(readFileSync(`supabase/migrations/${file}`))
        .digest('hex')
      expect(hash, file).toBe(expected)
    }
  })

  it('derives a narrow read model from durable truth without creating a journal authority', () => {
    expect(sql).toContain('from private.gameplay_events event')
    expect(sql).toContain('private.day_vote_result_totals')
    expect(sql).toContain('private.night_final_deaths')
    expect(sql).toContain('private.night_effects')
    expect(sql).not.toContain('create table')
    expect(sql).not.toContain('private.day_ballots')
    expect(sql).not.toContain("'ROLE_CALLED',\n        'CALL_COMPLETED'")
    expect(sql).not.toContain('DAY_VOTE_CHANGED')
  })

  it('adds secret facts only to the owner-checked Moderator projection', () => {
    expect(sql).toContain("'moderatorJournal', private.ms1h2_moderator_journal_payload")
    expect(sql).toContain('where owner.room_id = p_room_id and owner.user_id = v_user_id')
    expect(sql).not.toContain('create or replace function public.ms1a_get_player_room')
    expect(sql).toMatch(
      /revoke execute on function private\.ms1h2_moderator_journal_payload\(uuid\)\s+from public, anon, authenticated/,
    )
    expect(sql).not.toContain('broadcast_changes')
  })

  it('hydrates stable Moderator facts while ignoring forged Player journal data', () => {
    const players = [
      { id: 'a', seat: 1, displayName: 'An', revealConfirmed: true, joinedAt: room.createdAt },
      { id: 'b', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt },
    ]
    const moderator = moderatorSnapshotFromPayload({
      room,
      roleConfig: { seer: 1, villager: 1 },
      players,
      assignments: [
        { playerId: 'a', roleId: 'seer', assignedAt: room.createdAt },
        { playerId: 'b', roleId: 'villager', assignedAt: room.createdAt },
      ],
      alivePlayerIds: ['a', 'b'],
      moderatorJournal: journal,
    })
    expect(moderator.audience).toBe('MODERATOR')
    if (moderator.audience !== 'MODERATOR') throw new Error('Expected Moderator projection')
    expect(moderator.moderatorJournal.facts).toHaveLength(2)
    expect(moderator.moderatorJournal.facts[0]).toMatchObject({
      kind: 'SEER_INSPECTION',
      targetName: 'Bình',
      resolution: 'NON_WOLF',
    })

    const player = playerSnapshotFromPayload({
      room,
      self: players[1],
      players,
      assignment: { playerId: 'b', roleId: 'villager', assignedAt: room.createdAt },
      alivePlayerIds: ['a', 'b'],
      moderatorJournal: journal,
    })
    expect('moderatorJournal' in player).toBe(false)
    expect(JSON.stringify(player)).not.toContain('SEER_INSPECTION')
  })
})
