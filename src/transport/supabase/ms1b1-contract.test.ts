import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
  SupabaseRoomTransport,
} from './supabase-room-transport'

const historicalMigration = readFileSync(
  'supabase/migrations/20260825010000_ms1a_room_authority.sql',
  'utf8',
)
const migration = readFileSync(
  'supabase/migrations/20260825120000_ms1b1_night_action_authority.sql',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1B1 forward migration authority contract', () => {
  it('does not edit the already-applied MS-1A migration', () => {
    expect(createHash('sha256').update(historicalMigration).digest('hex')).toBe(
      '0286f69d86225c880347ab847195b11ef9ee466b2b2ca66136fe0588bf6e2251',
    )
  })

  it('keeps all action truth private and revokes browser table access', () => {
    for (const table of [
      'night_role_calls',
      'wolf_ballots',
      'seer_inspections',
      'protector_intents',
      'gameplay_events',
    ]) {
      expect(migration).toContain(`create table private.${table}`)
      expect(migration).toContain(
        `alter table private.${table} enable row level security`,
      )
      expect(migration).toContain(
        `revoke all on table private.${table} from public, anon, authenticated`,
      )
    }
    expect(migration).not.toContain('alter publication supabase_realtime add table')
    expect(functionBody('private.touch_gameplay_room')).toContain(
      'update public.rooms',
    )
  })

  it('pins SECURITY DEFINER search paths and grants only narrow authenticated RPCs', () => {
    const rpcNames = [
      'public.ms1b1_open_night_role_call',
      'public.ms1b1_complete_empty_night_role_call',
      'public.ms1b1_submit_wolf_ballot',
      'public.ms1b1_confirm_wolf_ballot',
      'public.ms1b1_finalize_wolf_round',
      'public.ms1b1_submit_seer_inspection',
      'public.ms1b1_acknowledge_seer_result',
      'public.ms1b1_submit_protector_target',
    ]
    for (const name of rpcNames) {
      const body = functionBody(name)
      expect(body).toContain('security definer')
      expect(body).toContain("set search_path = ''")
      expect(body).toContain('private.require_auth_uid()')
      expect(migration).toContain(
        `grant execute on function ${name}`,
      )
    }
    expect(migration.toLowerCase()).not.toContain('service_role')
  })

  it('derives Player identity and role server-side for every private action', () => {
    for (const name of [
      'public.ms1b1_submit_wolf_ballot',
      'public.ms1b1_confirm_wolf_ballot',
      'public.ms1b1_submit_seer_inspection',
      'public.ms1b1_acknowledge_seer_result',
      'public.ms1b1_submit_protector_target',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('public.room_memberships')
      expect(body).toContain('player.alive')
      expect(body).toContain('eligible_actor_ids')
      expect(body).toContain("v_room.phase <> 'NIGHT'")
    }
    expect(functionBody('public.ms1b1_submit_wolf_ballot')).not.toContain(
      'p_role_id',
    )
  })

  it('implements manual calls, Traitor gating, exact tie pools, and no death resolution', () => {
    const open = functionBody('public.ms1b1_open_night_role_call')
    expect(open).toContain("assignment.role_id = 'werewolf'")
    expect(open).toContain("assignment.role_id in ('werewolf', 'traitor')")
    expect(open).not.toContain('next_role')
    expect(open).not.toContain('night_order')

    const finalize = functionBody('public.ms1b1_finalize_wolf_round')
    expect(finalize).toContain('initial_tied_target_ids = v_leaders')
    expect(finalize).toContain("interval '10 seconds'")
    expect(finalize).toContain("'REVOTE_ALL_ABSTAIN_RANDOM'")
    expect(finalize).toContain('statement_timestamp()')
    expect(migration).not.toMatch(/set\s+alive\s*=\s*false/i)
  })

  it('locks Seer and Protector product semantics on the server', () => {
    const seer = functionBody('public.ms1b1_submit_seer_inspection')
    expect(seer).toContain("v_target_role_id = 'werewolf'")
    expect(seer).not.toContain("v_target_role_id in ('werewolf', 'traitor')")
    const protector = functionBody('public.ms1b1_submit_protector_target')
    expect(protector).toContain('v_room.day_number - 1')
    expect(protector).toContain("private.raise_ms1b1('SAME_PROTECTOR_TARGET')")
    expect(protector).not.toContain('p_target_player_id <> v_player_id')
  })
})

const room = {
  id: '00000000-0000-4000-8000-000000000001',
  code: '012345',
  seatCount: 7,
  status: 'IN_GAME',
  phase: 'NIGHT',
  dayNumber: 1,
  wolfPolicy: 'REVOTE_10S',
  revision: 20,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:10:00.000Z',
  lockedAt: '2026-08-25T00:05:00.000Z',
  startedAt: '2026-08-25T00:09:00.000Z',
} as const

const players = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    seat: 1,
    displayName: 'Tiên Tri',
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

describe('MS-1B1 Supabase transport projection and dispatch', () => {
  it('projects a private Seer result without another action secret', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignment: {
        playerId: players[0].id,
        roleId: 'seer',
        assignedAt: room.lockedAt,
      },
      nightAction: {
        id: '00000000-0000-4000-8000-000000000099',
        kind: 'SELECT_TARGET',
        roleId: 'seer',
        roleName: 'Tiên Tri',
        instructions: 'Ghi nhớ kết quả.',
        mode: 'SEER_RESULT',
        candidates: [],
        hasSelected: true,
        inspectedTarget: {
          id: players[1].id,
          seat: 2,
          displayName: 'Mục tiêu',
          alive: true,
        },
        seerResult: 'NON_WOLF',
      },
    })
    expect(snapshot.nightAction?.mode).toBe('SEER_RESULT')
    expect(snapshot.nightAction?.seerResult).toBe('NON_WOLF')
    expect(JSON.stringify(snapshot)).not.toContain('protector_player_id')
    expect(JSON.stringify(snapshot)).not.toContain('wolf_ballots')
  })

  it('parses the Moderator call checklist and final Wolf intent without killing', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { werewolf: 1, seer: 1 },
      players,
      alivePlayerIds: players.map((player) => player.id),
      assignments: [
        { playerId: players[0].id, roleId: 'seer', assignedAt: room.lockedAt },
        { playerId: players[1].id, roleId: 'werewolf', assignedAt: room.lockedAt },
      ],
      night: {
        number: 1,
        calls: [
          { roleId: 'werewolf', status: 'COMPLETED' },
          { roleId: 'seer', status: 'NOT_CALLED' },
        ],
        activeRoleId: null,
        actionsByRole: {
          werewolf: {
            id: '00000000-0000-4000-8000-000000000099',
            roleId: 'werewolf',
            kind: 'WOLF_VOTE',
            status: 'COMPLETED',
            eligibleActorIds: [players[1].id],
            eligibleTargetIds: [players[0].id],
            selections: { [players[1].id]: players[0].id },
            confirmedActorIds: [players[1].id],
            wolf: { round: 'INITIAL', initialTiedTargetIds: [] },
            result: {
              targetId: players[0].id,
              random: false,
              reason: 'UNIQUE_TOP',
            },
            openedAt: room.startedAt,
            completedAt: room.updatedAt,
          },
        },
        events: [],
      },
    })
    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') throw new Error('wrong audience')
    expect(snapshot.state.night?.calls[0].status).toBe('COMPLETED')
    expect(snapshot.state.night?.actionsByRole.werewolf?.result?.targetId).toBe(
      players[0].id,
    )
    expect(snapshot.state.players.every((player) => player.alive)).toBe(true)
  })

  it('never sends caller-supplied Player or role identity to action RPCs', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-seer' } } },
          error: null,
        }),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)
    await transport.dispatch(room.id, {
      type: 'SUBMIT_SEER_INSPECTION',
      playerId: 'forged-player-id',
      targetId: players[1].id,
    })
    expect(rpc).toHaveBeenCalledWith('ms1g2_submit_seer_inspection', {
      p_room_id: room.id,
      p_target_player_id: players[1].id,
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('forged-player-id')
  })
})
