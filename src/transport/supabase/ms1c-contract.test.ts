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
] as const
const migration = readFileSync(
  'supabase/migrations/20260825190000_ms1c_witch_final_night_checkpoint.sql',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1C forward migration security and authority contract', () => {
  it('keeps all historical migrations byte-identical', () => {
    for (const [path, hash] of historicalMigrations) {
      expect(
        createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex'),
      ).toBe(hash)
    }
  })

  it('stores resources, decisions, rescues, finalizations and source deaths privately', () => {
    for (const table of [
      'night_role_stages',
      'witch_resources',
      'witch_decisions',
      'night_finalizations',
      'witch_rescues',
      'night_final_deaths',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(`revoke all on table private.${table}`)
    }
    expect(migration).toContain('resurrection_available boolean not null default true')
    expect(migration).toContain('poison_available boolean not null default true')
    expect(migration).toContain('source_effect_id uuid not null')
    expect(migration).not.toContain('protected boolean')
  })

  it('enforces PRE_WITCH and FINAL_CHECKPOINT stages without auto ordering', () => {
    const trigger = functionBody('private.enforce_night_role_stage')
    expect(migration).toContain("('witch', 'FINAL_CHECKPOINT', 40)")
    expect(trigger).toContain("stage.stage = 'PRE_WITCH'")
    expect(trigger).toContain("call.status = 'COMPLETED'")
    expect(trigger).toContain('private.night_resolutions')
    expect(trigger).toContain("'WITCH_CHECKPOINT_ALREADY_OPEN'")
    expect(migration).not.toContain('AUTO_NEXT_ROLE')
  })

  it('uses narrow authenticated RPCs with explicit ownership/identity checks', () => {
    const open = functionBody('public.ms1c_open_witch_call')
    const submit = functionBody('public.ms1c_submit_witch_decision')
    const finalize = functionBody('public.ms1c_finalize_night_checkpoint')
    for (const body of [open, submit, finalize]) {
      expect(body).toContain('security definer')
      expect(body).toContain("set search_path = ''")
      expect(body).toContain('private.require_auth_uid()')
      expect(body).toContain('for update')
    }
    expect(open).toContain('private.room_owners')
    expect(submit).toContain('public.room_memberships')
    expect(submit).toContain("assignment.role_id = 'witch'")
    expect(finalize).toContain('private.room_owners')
    expect(finalize).not.toContain('p_death_target')
    expect(finalize).not.toContain('p_source_effect')
  })

  it('locks resurrection/poison rules and final death application server-side', () => {
    const submit = functionBody('public.ms1c_submit_witch_decision')
    const finalize = functionBody('public.ms1c_finalize_night_checkpoint')
    expect(submit).toContain("'WITCH_ATTACKED_CANNOT_RESURRECT'")
    expect(submit).toContain("'WITCH_POISON_FORBIDDEN_NIGHT_ONE'")
    expect(submit).toContain("'WITCH_POISON_SELF_TARGET'")
    expect(finalize).toContain("'WITCH_POISON'")
    expect(finalize).toContain("'NON_VILLAIN_LETHAL_EFFECT'")
    expect(finalize).toContain("false, 'UNBLOCKED'")
    expect(finalize).toMatch(/set alive = false/i)
    expect(finalize).not.toMatch(/phase\s*=\s*'DAY'/i)
  })

  it('keeps Player output names-only and masks current-Night final death', () => {
    const action = functionBody('private.witch_player_action_payload')
    const playerGetter = functionBody('public.ms1a_get_player_room')
    expect(action).toContain("'displayName'")
    expect(action).toContain("'resurrectionCandidates'")
    expect(action).not.toContain("'sourceType'")
    expect(action).not.toContain("'sourceEffectIds'")
    expect(playerGetter).toContain('private.night_final_deaths')
    expect(playerGetter).not.toContain("'witchCheckpoint'")
    expect(playerGetter).not.toContain("'nightResolution'")
  })

  it('retains generic realtime and does not add secret broadcast payloads', () => {
    expect(migration).not.toContain('realtime.send')
    expect(migration).not.toContain('room_changed_payload')
    expect(migration).not.toContain('broadcast_changes')
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
  revision: 40,
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
    displayName: 'Phù Thủy',
    revealConfirmed: true,
    joinedAt: room.createdAt,
  },
]

describe('MS-1C transport and private projection contract', () => {
  it('parses Moderator finalization while leaving phase NIGHT', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { villager: 1, witch: 1 },
      players,
      alivePlayerIds: [players[1].id],
      assignments: [
        { playerId: players[0].id, roleId: 'villager', assignedAt: room.lockedAt },
        { playerId: players[1].id, roleId: 'witch', assignedAt: room.lockedAt },
      ],
      witchCheckpoint: {
        id: '00000000-0000-4000-8000-000000000090',
        nightNumber: 1,
        finalizedAt: room.updatedAt,
        decision: { resurrectionTargetId: null, poisonTargetId: null },
        rescuedPlayerIds: [],
        poisonEffect: null,
        finalDeaths: [
          { playerId: players[0].id, sourceEffectIds: ['effect-wolf'] },
        ],
        resourcesAfter: {
          witchPlayerId: players[1].id,
          resurrectionAvailable: true,
          poisonAvailable: true,
        },
      },
    })

    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') throw new Error('wrong audience')
    expect(snapshot.state.phase).toBe('NIGHT')
    expect(snapshot.state.players[0].alive).toBe(false)
    expect(snapshot.state.witchCheckpoint?.finalDeaths[0].playerId).toBe(
      players[0].id,
    )
  })

  it('gives only Witch current victim names and no source truth', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[1],
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignment: {
        playerId: players[1].id,
        roleId: 'witch',
        assignedAt: room.lockedAt,
      },
      nightAction: {
        id: 'witch-call',
        kind: 'WITCH_DECISION',
        roleId: 'witch',
        roleName: 'Phù Thủy',
        mode: 'WITCH_DECISION',
        instructions: 'Quyết định.',
        candidates: [],
        resurrectionCandidates: [players[0]],
        poisonCandidates: [],
        resurrectionAvailable: true,
        poisonAvailable: false,
        witchAttackedThisNight: false,
        hasSelected: false,
      },
    })

    expect(snapshot.nightAction?.mode).toBe('WITCH_DECISION')
    expect(snapshot.nightAction?.resurrectionCandidates?.[0].alias).toBe('Châu')
    expect(JSON.stringify(snapshot)).not.toContain('WOLF_ATTACK')
    expect(JSON.stringify(snapshot)).not.toContain('sourceEffect')
  })

  it('keeps a just-finalized victim neutral/alive-looking during NIGHT', () => {
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
    })
    expect(snapshot.phase).toBe('NIGHT')
    expect(snapshot.self.alive).toBe(true)
    expect(snapshot.nightAction).toBeUndefined()
  })

  it('routes Witch call, decision and finalization to narrow RPCs', async () => {
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

    await transport.dispatch(room.id, { type: 'CALL_NIGHT_ROLE', roleId: 'witch' })
    await transport.dispatch(room.id, {
      type: 'SUBMIT_WITCH_DECISION',
      playerId: players[1].id,
      resurrectionTargetId: players[0].id,
      poisonTargetId: null,
    })
    await transport.dispatch(room.id, { type: 'FINALIZE_NIGHT_CHECKPOINT' })

    expect(rpc.mock.calls).toEqual([
      ['ms1c_open_witch_call', { p_room_id: room.id }],
      [
        'ms1c_submit_witch_decision',
        {
          p_room_id: room.id,
          p_resurrection_target_id: players[0].id,
          p_poison_target_id: null,
        },
      ],
      ['ms1c_finalize_night_checkpoint', { p_room_id: room.id }],
    ])
  })
})
