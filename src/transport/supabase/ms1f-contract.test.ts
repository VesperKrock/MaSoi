import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const historicalMigrations = [
  ['20260825010000_ms1a_room_authority.sql', '0286f69d86225c880347ab847195b11ef9ee466b2b2ca66136fe0588bf6e2251'],
  ['20260825120000_ms1b1_night_action_authority.sql', '09e583bde835ea4c8092f7fb22db9179415e938c3379dc61929063b18183ecbf'],
  ['20260825150000_ms1b2_night_resolution_primitive.sql', '69ec281e80230338dae5de73e3d22207e9bdca3c72bf4de50a573ec5a880d93f'],
  ['20260825190000_ms1c_witch_final_night_checkpoint.sql', '0bcab8279e4e84982abbeb4a3901512f874d1bfb467b20991dce876e4bf5f46b'],
  ['20260826090000_ms1d1_hunter_night_morning.sql', '4ddb1df05c221a158a01170a5830151aed99789fa448bf00ca1160b6b372ccef'],
  ['20260826130000_ms1d2_day_vote_hunter_revenge_next_night.sql', '840a94285b135828ce5f1cf9bdc70a8e1e8c1cbf8507fe07ce40207175574663'],
  ['20260826170000_ms1e_faction_transitions.sql', '1799b26bdf57f65d58dad41b2bf694ff7f7331fc8b7e6e3ef9b6f84b00501f90'],
] as const

const migration = readFileSync(
  'supabase/migrations/20260826210000_ms1f_cupid_lovers_heartbreak.sql',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1F forward migration contract', () => {
  it('keeps every historical migration byte-identical', () => {
    for (const [filename, hash] of historicalMigrations) {
      expect(
        createHash('sha256')
          .update(readFileSync(`supabase/migrations/${filename}`, 'utf8'))
          .digest('hex'),
      ).toBe(hash)
    }
  })

  it('persists pair, reveal acknowledgement, and Cupid objective privately', () => {
    for (const table of [
      'cupid_couples',
      'lover_reveal_acknowledgements',
      'cupid_runtime_objectives',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(`revoke all on table private.${table}`)
    }
    expect(migration).toContain('paired_night_number integer not null check (paired_night_number = 1)')
    expect(migration).toContain('first_lover_player_id <> second_lover_player_id')
    expect(migration).toContain('cupid_player_id <> first_lover_player_id')
  })

  it('models source-aware non-blockable, post-Witch heartbreak in existing effect tables', () => {
    expect(migration).toContain("'LOVER_HEARTBREAK', 'cupid', 'NON_VILLAIN_LETHAL_EFFECT'")
    expect(migration).toContain("source_type not in ('WITCH_POISON', 'LOVER_HEARTBREAK')")
    expect(migration).toContain('private.night_final_deaths')
    expect(migration).toContain('private.day_effects')
    const night = functionBody('private.ms1f_reconcile_night_death_consequences')
    expect(night).toContain("effect.source_type = 'HUNTER_SHOT'")
    expect(night).toContain("activation_status = 'ACTIVATED'")
    expect(night).toContain('while v_changed loop')
    expect(night).not.toContain('PROTECTOR_SHIELD')
  })

  it('extends the existing finalization/vote/revenge paths and closes old bypass RPCs', () => {
    expect(functionBody('public.ms1f_finalize_night_checkpoint')).toContain(
      'perform public.ms1c_finalize_night_checkpoint(p_room_id)',
    )
    expect(functionBody('public.ms1f_resolve_day_vote')).toContain(
      'perform public.ms1d2_resolve_day_vote(p_room_id)',
    )
    expect(functionBody('public.ms1f_submit_hunter_revenge')).toContain(
      'perform public.ms1d2_submit_hunter_revenge',
    )
    for (const signature of [
      'public.ms1c_finalize_night_checkpoint(uuid)',
      'public.ms1d2_resolve_day_vote(uuid)',
      'public.ms1d2_submit_hunter_revenge(uuid, uuid)',
      'public.ms1d2_start_next_night(uuid)',
    ]) {
      expect(migration).toContain(
        `revoke execute on function ${signature}\n  from public, anon, authenticated`,
      )
    }
  })

  it('derives pairing and death truth without client-supplied authority flags', () => {
    const pair = functionBody('public.ms1f_submit_cupid_pairing')
    expect(pair).toContain('private.require_auth_uid()')
    expect(pair).toContain("assignment.role_id = 'cupid'")
    expect(pair).toContain("v_room.day_number <> 1")
    expect(pair).toContain('p_first_target_player_id = p_second_target_player_id')
    expect(migration).not.toMatch(
      /p_(lover|heartbreak|objective|final_death|cupid_role|protector_blockable)/i,
    )
  })

  it('pins SECURITY DEFINER search paths and leaks no relationship through Realtime', () => {
    for (const name of [
      'public.ms1f_open_cupid_call',
      'public.ms1f_submit_cupid_pairing',
      'public.ms1f_acknowledge_lover_reveal',
      'public.ms1f_open_witch_call',
      'public.ms1f_finalize_night_checkpoint',
      'public.ms1f_resolve_day_vote',
      'public.ms1f_submit_hunter_revenge',
      'public.ms1f_start_next_night',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('security definer')
      expect(body).toContain("set search_path = ''")
    }
    expect(migration).not.toContain('realtime.send')
    expect(migration).not.toContain('broadcast_changes')
    expect(migration).not.toContain('alter publication supabase_realtime add table')
  })
})
