import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { selectRoomTransport } from '../create-room-transport'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
  SupabaseRoomTransport,
} from './supabase-room-transport'

const migration = readFileSync(
  'supabase/migrations/20260825010000_ms1a_room_authority.sql',
  'utf8',
)

const room = {
  id: '00000000-0000-4000-8000-000000000001',
  code: '012345',
  seatCount: 7,
  status: 'ROLE_REVEAL',
  phase: 'SETUP',
  dayNumber: 1,
  wolfPolicy: 'RANDOM_ON_TIE',
  revision: 9,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:01:00.000Z',
  lockedAt: '2026-08-25T00:01:00.000Z',
  startedAt: null,
} as const

const players = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    seat: 1,
    displayName: 'Bảo Châu',
    revealConfirmed: false,
    joinedAt: '2026-08-25T00:00:10.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    seat: 2,
    displayName: 'Minh',
    revealConfirmed: false,
    joinedAt: '2026-08-25T00:00:11.000Z',
  },
]

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-1A migration authority contract', () => {
  it('contains exactly the approved 12 Classic role IDs', () => {
    const catalogBlock = migration.slice(
      migration.indexOf('insert into public.classic_roles'),
      migration.indexOf('create table public.rooms'),
    )
    const ids = [...catalogBlock.matchAll(/\('([^']+)',\s*'[^']+',\s*'(?:MULTIPLE|SINGLE)'\)/g)]
      .map((match) => match[1])
    expect(ids).toEqual([
      'villager',
      'protector',
      'witch',
      'cupid',
      'mayor',
      'hunter',
      'seer',
      'werewolf',
      'traitor',
      'serial-killer',
      'fool',
      'half-wolf',
    ])
  })

  it('enforces seats, six text digits, singleton quantities, and exact role count', () => {
    expect(migration).toContain("code text not null unique check (code ~ '^[0-9]{6}$')")
    expect(migration).toContain('seat_count between 7 and 16')
    expect(migration).toContain("role_id in ('villager', 'werewolf') or quantity = 1")
    expect(functionBody('private.validate_role_config')).toContain(
      'if v_total <> p_seat_count',
    )
  })

  it('serializes create idempotency and same-room joins inside server transactions', () => {
    expect(functionBody('public.ms1a_create_room')).toContain(
      'pg_catalog.pg_advisory_xact_lock',
    )
    expect(migration).toContain('unique (user_id, create_request_id)')
    const join = functionBody('public.ms1a_join_room')
    expect(join).toContain('for update')
    expect(join.indexOf('for update')).toBeLessThan(join.indexOf('insert into public.room_players'))
    expect(migration).toContain('primary key (room_id, user_id)')
    expect(migration).toContain('unique (room_id, normalized_name)')
  })

  it('locks/deals once and validates the persisted assignment count and multiset', () => {
    const lock = functionBody('public.ms1a_lock_and_assign_roles')
    expect(lock).toContain("private.raise_ms1a('ALREADY_DEALT')")
    expect(lock).toContain("private.raise_ms1a('INVALID_ASSIGNMENT')")
    expect(lock).toContain('except')
    expect(lock).toContain("set status = 'ROLE_REVEAL'")
  })

  it('enables explicit SELECT-only RLS and revokes direct browser DML', () => {
    for (const table of [
      'rooms',
      'room_role_config',
      'room_players',
      'room_memberships',
      'room_role_assignments',
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`)
      expect(migration).toContain(
        `revoke all on table public.${table} from anon, authenticated`,
      )
      expect(migration).toContain(`grant select on table public.${table} to authenticated`)
    }
    expect(migration).not.toMatch(/create policy[\s\S]{0,160}for (insert|update|delete|all)/i)
    expect(migration).toContain('private.can_read_assignment(room_id, player_id)')
    expect(migration).toContain('private.is_room_moderator(room_id)')
  })

  it('pins every SECURITY DEFINER search path and exposes RPCs only to authenticated', () => {
    const definerNames = [
      'private.is_room_moderator',
      'private.is_room_member',
      'private.can_read_assignment',
      'private.can_receive_room_topic',
      'private.broadcast_room_change',
      'public.ms1a_create_room',
      'public.ms1a_lookup_room',
      'public.ms1a_join_room',
      'public.ms1a_get_moderator_room',
      'public.ms1a_get_player_room',
      'public.ms1a_resume_current_room',
      'public.ms1a_lock_and_assign_roles',
      'public.ms1a_confirm_role_reveal',
      'public.ms1a_start_room',
    ]
    for (const name of definerNames) {
      const body = functionBody(name)
      expect(body).toContain('security definer')
      expect(body).toContain("set search_path = ''")
    }
    expect(migration).toContain(
      'revoke execute on function public.ms1a_join_room(text, text) from public, anon',
    )
    expect(migration).toContain(
      'grant execute on function public.ms1a_join_room(text, text) to authenticated',
    )
    expect(migration.toLowerCase()).not.toContain('service_role')
  })

  it('uses authorized private Broadcast without publishing secret tables', () => {
    expect(migration).toContain('ms1a_room_broadcast_member_or_moderator_read')
    expect(migration).toContain("and private.can_receive_room_topic(realtime.topic())")
    expect(migration).toContain('create trigger ms1a_broadcast_rooms')
    expect(migration).toContain('create trigger ms1a_broadcast_room_players')
    expect(migration).not.toContain('alter publication supabase_realtime add table')
    const broadcast = functionBody('private.broadcast_room_change')
    expect(broadcast).not.toContain('room_role_assignments')
    expect(broadcast).not.toContain('room_role_config')
  })
})

describe('Supabase transport privacy and selection', () => {
  it('preserves a six-digit leading zero and projects only the supplied Player role', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      assignment: {
        playerId: players[0].id,
        roleId: 'seer',
        assignedAt: room.lockedAt,
      },
    })
    expect(snapshot.roomCode).toBe('012345')
    expect(snapshot.self.id).toBe(players[0].id)
    expect(snapshot.roleIdentity?.roleId).toBe('seer')
    expect(JSON.stringify(snapshot)).not.toContain('werewolf')
  })

  it('builds a Moderator snapshot with the exact assignment multiset', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { villager: 1, seer: 1 },
      players,
      assignments: [
        { playerId: players[0].id, roleId: 'seer', assignedAt: room.lockedAt },
        { playerId: players[1].id, roleId: 'villager', assignedAt: room.lockedAt },
      ],
    })
    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') throw new Error('wrong projection')
    expect(snapshot.state.roleAssignments).toHaveLength(2)
    expect(snapshot.state.roomCode).toBe('012345')
  })

  it('rejects an altered Player URL id even when the server returns caller membership', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        room,
        self: players[0],
        players,
        assignment: null,
      },
      error: null,
    })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-a' } } },
          error: null,
        }),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)
    await expect(
      transport.getSnapshot(room.id, {
        kind: 'PLAYER',
        playerId: players[1].id,
      }),
    ).rejects.toThrow('Phiên thiết bị không có quyền')
    expect(rpc).toHaveBeenCalledWith('ms1a_get_player_room', { p_room_id: room.id })
  })

  it('creates an anonymous identity only when no persisted session exists', async () => {
    const getSession = vi.fn().mockResolvedValue({ data: { session: null }, error: null })
    const signInAnonymously = vi.fn().mockResolvedValue({
      data: { user: { id: 'anonymous-device-a' } },
      error: null,
    })
    const rpc = vi.fn().mockResolvedValue({
      data: { exists: false, joinable: false, reason: 'ROOM_NOT_FOUND' },
      error: null,
    })
    const client = {
      auth: { getSession, signInAnonymously },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)
    await transport.validateRoomCode('012345')
    await transport.validateRoomCode('012345')
    expect(getSession).toHaveBeenCalledTimes(1)
    expect(signInAnonymously).toHaveBeenCalledTimes(1)
  })

  it('never interprets a local request as fallback in production or configured mode', () => {
    const configured = {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
    } as ImportMetaEnv
    expect(selectRoomTransport(configured, false, null).kind).toBe('SUPABASE')
    expect(selectRoomTransport(configured, true, null).kind).toBe('SUPABASE')
    expect(selectRoomTransport(configured, true, 'local').kind).toBe('LOCAL')
    expect(selectRoomTransport({} as ImportMetaEnv, false, 'local').kind).toBe(
      'UNAVAILABLE',
    )
  })
})
