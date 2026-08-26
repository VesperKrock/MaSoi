import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260826170000_ms1e_faction_transitions.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('MS-1E Supabase faction-transition authority contract', () => {
  it('persists source-linked Half-Wolf and permanent Traitor truth privately', () => {
    for (const table of [
      'half_wolf_transitions',
      'traitor_faction_transitions',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(`revoke all on table private.${table}`)
    }
    expect(migration).toContain('source_effect_id uuid not null')
    expect(migration).toContain('transform_due_night_number = bitten_night_number + 1')
    expect(migration).toContain("conversion_reason = 'NO_LIVING_BITE_CAPABLE_WOLF'")
  })

  it('models a successful Half-Wolf bite as explicit nonlethal source-aware truth', () => {
    expect(migration).toContain("'HALF_WOLF_BITE_SCHEDULED'")
    expect(migration).toContain("'HALF_WOLF_TRANSFORMATION'")
    expect(migration).toContain('v_wolf_call.final_target_id, not v_half_wolf_bite, true')
    expect(migration).toContain("v_resolution_outcome := 'BITE_SCHEDULED'")
    expect(migration).not.toMatch(/set\s+alive\s*=\s*false[\s\S]{0,100}half.wolf/i)
  })

  it('derives Wolf voters, targets, and Seer truth from private runtime state', () => {
    expect(migration).toContain('private.ms1e_living_bite_capable_wolf_exists')
    expect(migration).toContain('private.ms1e_wolf_actor_ids')
    expect(migration).toContain('private.ms1e_wolf_target_ids')
    expect(migration).toContain("assignment.role_id = 'half-wolf'")
    expect(migration).toContain("transition.status = 'TRANSFORMED'")
    expect(migration).toContain("assignment.role_id = 'traitor'")
    expect(migration).toContain("then 'WOLF'")
  })

  it('uses one idempotent reconciliation primitive after deaths and at Night start', () => {
    expect(migration).toContain(
      'function private.ms1e_reconcile_faction_transitions',
    )
    expect(migration).toContain("p_stage not in ('AFTER_DEATH', 'START_NIGHT')")
    expect(migration).toContain('on conflict (room_id, player_id) do nothing')
    expect(migration).toContain('room_players_ms1e_reconcile_death')
    expect(migration).toContain('rooms_ms1e_reconcile_night_start')
    const traitorBlock = migration.indexOf(
      'if not private.ms1e_living_bite_capable_wolf_exists',
    )
    const transformBlock = migration.indexOf("if p_stage = 'START_NIGHT'")
    expect(traitorBlock).toBeGreaterThan(0)
    expect(transformBlock).toBeGreaterThan(traitorBlock)
  })

  it('exposes transition truth only in the owned Moderator projection', () => {
    expect(migration).toContain(
      "'factionTransitions', private.moderator_faction_transition_payload",
    )
    expect(migration).not.toContain(
      'create or replace function public.ms1a_get_player_room',
    )
    expect(migration).not.toContain('realtime.broadcast_changes')
    expect(migration).not.toContain('realtime.send')
  })

  it('accepts no client-supplied faction or transformation claims', () => {
    expect(migration).not.toMatch(
      /p_(transformed|faction|traitor_converted|bite_capable|bite_night)/i,
    )
    expect(migration).not.toMatch(
      /grant\s+(select|insert|update|delete).*faction_transitions/i,
    )
  })
})
