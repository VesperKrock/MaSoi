import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
  SupabaseRoomTransport,
} from './supabase-room-transport'

const ms1aMigration = readFileSync(
  'supabase/migrations/20260825010000_ms1a_room_authority.sql',
  'utf8',
)
const ms1b1Migration = readFileSync(
  'supabase/migrations/20260825120000_ms1b1_night_action_authority.sql',
  'utf8',
)
const migration = readFileSync(
  'supabase/migrations/20260825150000_ms1b2_night_resolution_primitive.sql',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1B2 forward migration contract', () => {
  it('does not edit either deployed historical migration', () => {
    expect(createHash('sha256').update(ms1aMigration).digest('hex')).toBe(
      '0286f69d86225c880347ab847195b11ef9ee466b2b2ca66136fe0588bf6e2251',
    )
    expect(createHash('sha256').update(ms1b1Migration).digest('hex')).toBe(
      '09e583bde835ea4c8092f7fb22db9179415e938c3379dc61929063b18183ecbf',
    )
  })

  it('persists source-aware private effect and candidate truth', () => {
    for (const table of [
      'night_resolutions',
      'night_effects',
      'provisional_night_death_candidates',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(
        `revoke all on table private.${table}`,
      )
    }
    for (const field of [
      'source_type',
      'source_role_id',
      'effect_category',
      'target_player_id',
      'lethal',
      'protector_blockable',
      'outcome',
      'block_source_type',
      'block_source_role_id',
    ]) {
      expect(migration).toContain(field)
    }
    expect(migration).not.toContain('protected boolean')
  })

  it('defines one narrow Moderator-only idempotent resolver', () => {
    const resolver = functionBody('public.ms1b2_resolve_night_effects')
    expect(migration).toContain(
      'function public.ms1b2_resolve_night_effects(p_room_id uuid)',
    )
    expect(resolver).toContain('security definer')
    expect(resolver).toContain("set search_path = ''")
    expect(resolver).toContain('private.require_auth_uid()')
    expect(resolver).toContain('private.room_owners')
    expect(resolver).toContain('for update')
    expect(resolver).toContain('private.night_resolutions')
    expect(resolver).toContain(
      'return private.moderator_night_resolution_payload(p_room_id)',
    )
    expect(migration).toContain(
      'unique (room_id, night_number)',
    )
    expect(migration).toContain(
      'unique (source_call_id, source_type)',
    )
    expect(migration).toContain(
      'grant execute on function public.ms1b2_resolve_night_effects(uuid)',
    )
  })

  it('derives Wolf and Protector inputs only from B1 authority', () => {
    const resolver = functionBody('public.ms1b2_resolve_night_effects')
    expect(resolver).toContain('private.night_role_calls')
    expect(resolver).toContain('v_wolf_call.final_target_id')
    expect(resolver).toContain('private.protector_intents')
    expect(resolver).not.toContain('p_wolf_target')
    expect(resolver).not.toContain('p_protector_target')
    expect(resolver).not.toContain('p_blocked')
    expect(resolver).not.toContain('p_death_candidate')
  })

  it('gates only configured Wolf and Protector calls, not Seer', () => {
    const resolver = functionBody('public.ms1b2_resolve_night_effects')
    expect(resolver).toContain("config.role_id = 'werewolf'")
    expect(resolver).toContain("config.role_id = 'protector'")
    expect(resolver).toContain("v_wolf_call.status <> 'COMPLETED'")
    expect(resolver).toContain("v_protector_call.status <> 'COMPLETED'")
    expect(resolver).not.toContain("config.role_id = 'seer'")
    expect(resolver).not.toContain('night_order')
  })

  it('does not apply death, Day transition, or deferred effects', () => {
    expect(migration).not.toMatch(/set\s+alive\s*=\s*false/i)
    expect(migration).not.toMatch(/phase\s*=\s*'DAY'/i)
    expect(migration).not.toContain('WITCH_POISON')
    expect(migration).not.toContain('HUNTER_SHOT')
    expect(migration).not.toContain('SERIAL_KILLER_ATTACK')
    expect(migration).not.toContain('LOVER_DEATH')
  })

  it('keeps resolution out of every Player projection', () => {
    expect(migration).not.toContain(
      'create or replace function public.ms1a_get_player_room',
    )
    expect(functionBody('public.ms1a_get_moderator_room')).toContain(
      "'nightResolution'",
    )
  })
})

const room = {
  id: '00000000-0000-4000-8000-000000000001',
  code: '012345',
  seatCount: 7,
  status: 'IN_GAME',
  phase: 'NIGHT',
  dayNumber: 1,
  wolfPolicy: 'RANDOM_ON_TIE',
  revision: 30,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:10:00.000Z',
  lockedAt: '2026-08-25T00:05:00.000Z',
  startedAt: '2026-08-25T00:09:00.000Z',
} as const

const players = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    seat: 1,
    displayName: 'Châu',
    revealConfirmed: true,
    joinedAt: room.createdAt,
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    seat: 2,
    displayName: 'Sói',
    revealConfirmed: true,
    joinedAt: room.createdAt,
  },
]

describe('MS-1B2 transport/projection boundary', () => {
  it('projects source-aware resolution only to Moderator state', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { werewolf: 1, villager: 1 },
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignments: [
        { playerId: players[0].id, roleId: 'villager', assignedAt: room.lockedAt },
        { playerId: players[1].id, roleId: 'werewolf', assignedAt: room.lockedAt },
      ],
      nightResolution: {
        id: '00000000-0000-4000-8000-000000000099',
        nightNumber: 1,
        outcome: 'UNBLOCKED',
        resolvedAt: room.updatedAt,
        effects: [
          {
            id: '00000000-0000-4000-8000-000000000098',
            sourceType: 'WOLF_ATTACK',
            sourceRoleId: 'werewolf',
            category: 'HOSTILE_VILLAIN_ATTACK',
            targetPlayerId: players[0].id,
            lethal: true,
            protectorBlockable: true,
            outcome: 'UNBLOCKED',
          },
        ],
        provisionalDeathCandidateIds: [players[0].id],
      },
    })

    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') throw new Error('wrong audience')
    expect(snapshot.state.nightResolution?.outcome).toBe('UNBLOCKED')
    expect(snapshot.state.nightResolution?.provisionalDeathCandidateIds).toEqual([
      players[0].id,
    ])
    expect(snapshot.state.players[0].alive).toBe(true)
  })

  it('ignores forged resolution truth in a Player payload', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignment: {
        playerId: players[0].id,
        roleId: 'villager',
        assignedAt: room.lockedAt,
      },
      nightAction: null,
      nightResolution: {
        outcome: 'UNBLOCKED',
        provisionalDeathCandidateIds: [players[0].id],
      },
    })

    expect(snapshot.audience).toBe('PLAYER')
    expect(snapshot.self.alive).toBe(true)
    expect(snapshot.nightAction).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('provisionalDeathCandidate')
    expect(JSON.stringify(snapshot)).not.toContain('WOLF_ATTACK')
  })

  it('dispatches resolution with room ID and no outcome parameters', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-moderator' } } },
          error: null,
        }),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)

    await transport.dispatch(room.id, { type: 'RESOLVE_NIGHT_EFFECTS' })

    expect(rpc).toHaveBeenCalledWith('ms1g2_resolve_night_effects', {
      p_room_id: room.id,
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('target')
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('blocked')
  })
})
