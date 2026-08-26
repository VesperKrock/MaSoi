import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260826130000_ms1d2_day_vote_hunter_revenge_next_night.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('MS-1D2 Supabase authority contract', () => {
  it('persists private ballot, result, source-aware effect, revenge, and transition truth', () => {
    for (const table of [
      'day_vote_rounds',
      'day_ballots',
      'day_vote_result_totals',
      'day_effects',
      'hunter_day_revenge',
      'day_to_night_transitions',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(`alter table private.${table} enable row level security`)
      expect(migration).toContain(`revoke all on table private.${table}`)
    }
    expect(migration).toContain("source_type in ('DAY_HANGING', 'HUNTER_REVENGE_SHOT')")
    expect(migration).toContain('check (not protector_blockable)')
  })

  it('owns an exact server deadline without early finish, extension, or restart input', () => {
    expect(migration).toContain("deadline_at = opened_at + interval '30 seconds'")
    expect(migration).toContain("v_opened_at + interval '30 seconds'")
    expect(migration).toContain("private.raise_ms1d2('DAY_VOTE_NOT_READY')")
    expect(migration).toContain("private.raise_ms1d2('DAY_VOTE_EXPIRED')")
    expect(migration).not.toMatch(/p_deadline|p_duration|p_extend|p_weight/i)
  })

  it('derives Mayor weight and server-side unique/tie/no-vote resolution', () => {
    expect(migration).toContain("case when assignment.role_id = 'mayor' then 2 else 1 end")
    expect(migration).toContain("v_outcome := 'NO_VOTES'")
    expect(migration).toContain("v_outcome := 'HANGED'")
    expect(migration).toContain("v_outcome := 'TIE'")
    expect(migration).toContain('v_hanged_player_id := null')
    expect(migration).not.toMatch(/random\s*\(/i)
  })

  it('authorizes Moderator and Player calls from auth.uid with minimal signatures', () => {
    for (const functionName of [
      'ms1d2_start_day_vote',
      'ms1d2_cast_day_vote',
      'ms1d2_resolve_day_vote',
      'ms1d2_submit_hunter_revenge',
      'ms1d2_start_next_night',
    ]) {
      expect(migration).toContain(`function public.${functionName}`)
      expect(migration).toMatch(
        new RegExp(`function public\\.${functionName}[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`),
      )
      expect(migration).toContain(`grant execute on function public.${functionName}`)
    }
    expect(migration).toContain('v_user_id uuid := private.require_auth_uid()')
    expect(migration).toContain("private.raise_ms1d2('NOT_MODERATOR')")
    expect(migration).toContain("private.raise_ms1d2('NOT_PLAYER')")
  })

  it('keeps raw ballots and revenge target out of generic Realtime payloads', () => {
    expect(migration).not.toContain('realtime.broadcast_changes')
    expect(migration).not.toContain('realtime.send')
    expect(migration).toContain('perform private.touch_gameplay_room(p_room_id)')
    expect(migration).toContain("'dayVote', private.player_day_vote_payload")
    expect(migration).not.toMatch(/grant\s+(select|insert|update|delete).*day_ballots/i)
  })

  it('guards Hunter revenge and increments the next Night exactly once', () => {
    expect(migration).toContain("v_hanged_role_id = 'hunter'")
    expect(migration).toContain("v_revenge.status = 'RESOLVED'")
    expect(migration).toContain("private.raise_ms1d2('HUNTER_REVENGE_NOT_PENDING')")
    expect(migration).toContain("private.raise_ms1d2('DAY_CONSEQUENCE_NOT_READY')")
    expect(migration).toContain('next_night_number = day_number + 1')
    expect(migration).toContain('day_number = day_number + 1')
    expect(migration).toContain("set phase = 'NIGHT'")
  })
})
