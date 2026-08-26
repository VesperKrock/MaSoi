import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
  SupabaseRoomTransport,
} from './supabase-room-transport'

const historicalMigrations = [
  [
    'supabase/migrations/20260825010000_ms1a_room_authority.sql',
    '0286f69d86225c880347ab847195b11ef9ee466b2b2ca66136fe0588bf6e2251',
  ],
  [
    'supabase/migrations/20260825120000_ms1b1_night_action_authority.sql',
    '09e583bde835ea4c8092f7fb22db9179415e938c3379dc61929063b18183ecbf',
  ],
  [
    'supabase/migrations/20260825150000_ms1b2_night_resolution_primitive.sql',
    '69ec281e80230338dae5de73e3d22207e9bdca3c72bf4de50a573ec5a880d93f',
  ],
  [
    'supabase/migrations/20260825190000_ms1c_witch_final_night_checkpoint.sql',
    '0bcab8279e4e84982abbeb4a3901512f874d1bfb467b20991dce876e4bf5f46b',
  ],
] as const
const migration = readFileSync(
  'supabase/migrations/20260826090000_ms1d1_hunter_night_morning.sql',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1D1 forward migration security and authority contract', () => {
  it('keeps every historical migration byte-identical', () => {
    for (const [path, hash] of historicalMigrations) {
      expect(
        createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex'),
      ).toBe(hash)
    }
  })

  it('stores Hunter intent and morning authority privately with direct DML denied', () => {
    for (const table of ['hunter_night_intents', 'morning_transitions']) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(`revoke all on table private.${table}`)
    }
    expect(migration).toContain('target_player_id uuid')
    expect(migration).toContain('confirmed boolean not null default false')
  })

  it('persists a source-aware conditional shot which Protector cannot block', () => {
    const resolve = functionBody('public.ms1b2_resolve_night_effects')
    expect(migration).toContain("activation_condition = 'SOURCE_PLAYER_FINAL_NIGHT_DEATH'")
    expect(migration).toContain("'CANCELED_SOURCE_SURVIVED'")
    expect(resolve).toContain("'HUNTER_SHOT'")
    expect(resolve).toContain("'NON_VILLAIN_LETHAL_EFFECT'")
    expect(resolve).toContain("v_hunter_target_id, true, false, 'UNBLOCKED'")
    expect(resolve).not.toContain('p_hunter_target')
    expect(resolve).not.toContain('p_source_player')
  })

  it('derives and finalizes activation from authoritative death state', () => {
    const finalize = functionBody('public.ms1c_finalize_night_checkpoint')
    expect(finalize).toContain("activation_status = case")
    expect(finalize).toContain("then 'ACTIVATED'")
    expect(finalize).toContain("else 'CANCELED_SOURCE_SURVIVED'")
    expect(finalize).toContain('private.night_final_deaths')
    expect(finalize).not.toContain("phase = 'DAY'")
    expect(finalize).not.toContain('p_hunter_target')
  })

  it('makes morning an explicit Moderator-only idempotent transition', () => {
    const morning = functionBody('public.ms1d1_start_morning')
    expect(morning).toContain('security definer')
    expect(morning).toContain("set search_path = ''")
    expect(morning).toContain('private.require_auth_uid()')
    expect(morning).toContain('private.room_owners')
    expect(morning).toContain('for update')
    expect(morning).toContain('private.night_finalizations')
    expect(morning).toContain("activation_status = 'CONDITIONAL'")
    expect(morning).toContain("set phase = 'DAY'")
    expect(morning).toContain("'MORNING_STARTED'")
    expect(morning).toContain("'dayVoteOpened', false")
  })

  it('keeps Hunter targets out of generic Realtime payloads', () => {
    expect(migration).not.toContain('realtime.send')
    expect(migration).not.toContain('broadcast_changes')
    expect(migration).not.toContain('room_changed_payload')
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
  revision: 50,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:10:00.000Z',
  lockedAt: '2026-08-26T00:05:00.000Z',
  startedAt: '2026-08-26T00:09:00.000Z',
} as const
const players = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    seat: 1,
    displayName: 'Thợ Săn',
    revealConfirmed: true,
    joinedAt: room.createdAt,
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    seat: 2,
    displayName: 'Mục tiêu',
    revealConfirmed: true,
    joinedAt: room.createdAt,
  },
]

describe('MS-1D1 transport and private projection contract', () => {
  it('parses only the Hunter own active pre-lock, including Nobody selection state', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignment: {
        playerId: players[0].id,
        roleId: 'hunter',
        assignedAt: room.lockedAt,
      },
      nightAction: {
        id: 'hunter-call',
        kind: 'HUNTER_PRELOCK',
        roleId: 'hunter',
        roleName: 'Thợ Săn',
        mode: 'HUNTER_PRELOCK',
        instructions: 'Khóa trước mục tiêu.',
        candidates: [players[1]],
        currentTargetId: null,
        hasSelected: true,
      },
    })

    expect(snapshot.nightAction).toMatchObject({
      kind: 'HUNTER_PRELOCK',
      mode: 'HUNTER_PRELOCK',
      currentTargetId: null,
      hasSelected: true,
    })
    expect(JSON.stringify(snapshot)).not.toContain('sourceEffect')
  })

  it('parses conditional resolution and finalized morning death truth for Moderator', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room: { ...room, phase: 'DAY' },
      roleConfig: { hunter: 1, villager: 1 },
      players,
      alivePlayerIds: [players[1].id],
      assignments: [
        { playerId: players[0].id, roleId: 'hunter', assignedAt: room.lockedAt },
        { playerId: players[1].id, roleId: 'villager', assignedAt: room.lockedAt },
      ],
      nightResolution: {
        id: 'resolution',
        nightNumber: 1,
        outcome: 'UNBLOCKED',
        effects: [
          {
            id: 'shot',
            sourceType: 'HUNTER_SHOT',
            sourceRoleId: 'hunter',
            category: 'NON_VILLAIN_LETHAL_EFFECT',
            targetPlayerId: players[1].id,
            lethal: true,
            protectorBlockable: false,
            outcome: 'UNBLOCKED',
            activationCondition: {
              kind: 'SOURCE_PLAYER_FINAL_NIGHT_DEATH',
              sourcePlayerId: players[0].id,
            },
            activationStatus: 'ACTIVATED',
          },
        ],
        provisionalDeathCandidateIds: [players[0].id, players[1].id],
        resolvedAt: room.updatedAt,
      },
      witchCheckpoint: {
        id: 'checkpoint',
        nightNumber: 1,
        finalizedAt: room.updatedAt,
        decision: { resurrectionTargetId: null, poisonTargetId: null },
        rescuedPlayerIds: [],
        poisonEffect: null,
        finalDeaths: [
          { playerId: players[0].id, sourceEffectIds: ['wolf'] },
          { playerId: players[1].id, sourceEffectIds: ['shot'] },
        ],
        conditionalEffectStates: [{ effectId: 'shot', status: 'ACTIVATED' }],
        resourcesAfter: null,
      },
    })

    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') return
    expect(snapshot.state.phase).toBe('DAY')
    expect(snapshot.state.nightResolution?.effects[0]).toMatchObject({
      activationStatus: 'ACTIVATED',
      protectorBlockable: false,
    })
    expect(snapshot.state.players[0].alive).toBe(false)
  })

  it('routes Hunter select/confirm and morning through narrow D1 RPCs', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-user' } } },
          error: null,
        }),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)

    await transport.dispatch(room.id, { type: 'CALL_NIGHT_ROLE', roleId: 'hunter' })
    await transport.dispatch(room.id, {
      type: 'CAST_HUNTER_PRELOCK',
      playerId: players[0].id,
      targetId: null,
    })
    await transport.dispatch(room.id, {
      type: 'CONFIRM_HUNTER_PRELOCK',
      playerId: players[0].id,
    })
    await transport.dispatch(room.id, { type: 'START_DAY' })

    expect(rpc.mock.calls).toEqual([
      ['ms1d1_open_hunter_call', { p_room_id: room.id }],
      [
        'ms1d1_submit_hunter_prelock',
        { p_room_id: room.id, p_target_player_id: null },
      ],
      ['ms1d1_confirm_hunter_prelock', { p_room_id: room.id }],
      ['ms1d1_start_morning', { p_room_id: room.id }],
    ])
  })
})
