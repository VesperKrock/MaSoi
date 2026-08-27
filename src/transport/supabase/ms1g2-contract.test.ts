import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
} from './supabase-room-transport'

const migrationPath =
  'supabase/migrations/20260827130000_ms1g2_fool_global_win_engine.sql'
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
])

describe('MS-1G2 server contract', () => {
  it('preserves all nine pre-G2 migrations and keeps G2 as the tenth migration', () => {
    const files = readdirSync('supabase/migrations').filter((file) => file.endsWith('.sql')).sort()
    expect(files[9]).toBe('20260827130000_ms1g2_fool_global_win_engine.sql')
    for (const [file, expected] of historicalHashes) {
      const hash = createHash('sha256')
        .update(readFileSync(`supabase/migrations/${file}`))
        .digest('hex')
      expect(hash, file).toBe(expected)
    }
  })

  it('persists one private immutable result shape with locked outcomes and subjects', () => {
    expect(sql).toContain('create table private.match_results')
    expect(sql).toContain("outcome_type in ('FOOL', 'WOLF', 'COUPLE', 'SERIAL_KILLER', 'VILLAGE', 'DRAW')")
    expect(sql).toContain('room_id uuid primary key')
    expect(sql).toContain('subject_player_ids uuid[]')
    expect(sql).toContain('alter table private.match_results enable row level security')
    expect(sql).toContain('revoke all on table private.match_results from public, anon, authenticated')
  })

  it('locks precedence, pending Half-Wolf handling, and stable checkpoints server-side', () => {
    const wolf = sql.indexOf("p_room_id, 'WOLF', p_trigger_type")
    const couple = sql.indexOf("p_room_id, 'COUPLE', p_trigger_type")
    const serialKiller = sql.indexOf("p_room_id, 'SERIAL_KILLER', p_trigger_type")
    const draw = sql.indexOf("p_room_id, 'DRAW', p_trigger_type")
    const village = sql.indexOf("p_room_id, 'VILLAGE', p_trigger_type")
    expect(wolf).toBeGreaterThan(0)
    expect(wolf).toBeLessThan(couple)
    expect(couple).toBeLessThan(serialKiller)
    expect(serialKiller).toBeLessThan(draw)
    expect(draw).toBeLessThan(village)
    expect(sql).toContain("transition.status = 'PENDING_TRANSFORMATION'")
    expect(sql).toContain("'NIGHT_STABILIZED', 'DAY_STABILIZED', 'START_NIGHT'")
  })

  it('makes Fool an authoritative Day-hanging override before normal resolution', () => {
    expect(sql).toContain('private.ms1g2_finish_fool_hanging')
    expect(sql).toContain("effect.source_type = 'DAY_HANGING'")
    expect(sql).toContain("assignment.role_id = 'fool'")
    const day = sql.slice(sql.indexOf('function public.ms1g2_resolve_day_vote'))
    expect(day.indexOf("v_hanged_role = 'fool'")).toBeLessThan(
      day.indexOf('private.ms1f_reconcile_day_heartbreak'),
    )
  })

  it('runs existing death fixpoints before every normal winner check', () => {
    const night = sql.slice(sql.indexOf('function public.ms1g2_finalize_night_checkpoint'))
    expect(night.indexOf('public.ms1f_finalize_night_checkpoint')).toBeLessThan(
      night.indexOf("private.ms1g2_resolve_global_win(p_room_id, 'NIGHT_STABILIZED')"),
    )
    const day = sql.slice(sql.indexOf('function public.ms1g2_resolve_day_vote'))
    expect(day.indexOf('private.ms1f_reconcile_day_heartbreak')).toBeLessThan(
      day.indexOf("private.ms1g2_resolve_global_win(p_room_id, 'DAY_STABILIZED')"),
    )
    const nextNight = sql.slice(sql.indexOf('function public.ms1g2_start_next_night'))
    expect(nextNight.indexOf('public.ms1f_start_next_night')).toBeLessThan(
      nextNight.indexOf("private.ms1g2_resolve_global_win(p_room_id, 'START_NIGHT')"),
    )
  })

  it('revokes historical browser mutation bypasses and grants guarded G2 endpoints', () => {
    expect(sql).toContain('revoke execute on function public.ms1f_finalize_night_checkpoint(uuid) from public, anon, authenticated')
    expect(sql).toContain('revoke execute on function public.ms1f_resolve_day_vote(uuid) from public, anon, authenticated')
    expect(sql).toContain('revoke execute on function public.ms1g1_submit_serial_killer_intent(uuid, uuid) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.ms1g2_finalize_night_checkpoint(uuid) to authenticated')
    expect(sql).toContain('perform private.ms1g2_assert_match_active(p_room_id)')
  })

  it('hydrates only minimal outcome truth after FINISHED', () => {
    const room = {
      id: 'room', code: '000001', seatCount: 1, status: 'FINISHED',
      phase: 'ENDED', dayNumber: 2, revision: 8,
      createdAt: '2026-08-27T00:00:00Z', updatedAt: '2026-08-27T01:00:00Z',
    }
    const matchResult = {
      outcome: 'VILLAGE', finishedAt: room.updatedAt, finishedPhase: 'DAY',
      dayNumber: 2, trigger: 'DAY_STABILIZED',
    }
    const moderator = moderatorSnapshotFromPayload({
      room, roleConfig: { villager: 1 },
      players: [{ id: 'p', seat: 1, displayName: 'P', revealConfirmed: true, joinedAt: room.createdAt }],
      assignments: [{ playerId: 'p', roleId: 'villager', assignedAt: room.createdAt }],
      alivePlayerIds: ['p'], matchResult,
    })
    const player = playerSnapshotFromPayload({
      room,
      self: { id: 'p', seat: 1, displayName: 'P', revealConfirmed: true, joinedAt: room.createdAt },
      players: [{ id: 'p', seat: 1, displayName: 'P', revealConfirmed: true, joinedAt: room.createdAt }],
      assignment: { playerId: 'p', roleId: 'villager', assignedAt: room.createdAt },
      alivePlayerIds: ['p'], matchResult,
    })
    expect(moderator.audience === 'MODERATOR' && moderator.state.matchResult?.outcome).toBe('VILLAGE')
    expect(player.matchResult).toEqual({ outcome: 'VILLAGE' })
    expect(JSON.stringify(player.matchResult)).not.toContain('subject')
  })
})
