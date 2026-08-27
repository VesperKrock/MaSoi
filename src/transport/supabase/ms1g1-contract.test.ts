import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
  SupabaseRoomTransport,
} from './supabase-room-transport'

const room = {
  id: '00000000-0000-4000-8000-000000000001',
  code: '012345',
  seatCount: 3,
  status: 'IN_GAME',
  phase: 'NIGHT',
  dayNumber: 1,
  wolfPolicy: 'RANDOM_ON_TIE',
  revision: 1,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:01:00.000Z',
}

const players = [
  { id: 'wolf', seat: 1, displayName: 'Wolf', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'sk', seat: 2, displayName: 'Solo', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'target', seat: 3, displayName: 'Châu', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
]

describe('MS-1G1 Supabase authority boundary', () => {
  it('hydrates only the private Serial Killer action for its holder', () => {
    const holder = playerSnapshotFromPayload({
      room,
      self: players[1],
      players,
      assignment: { playerId: 'sk', roleId: 'serial-killer', assignedAt: room.createdAt },
      alivePlayerIds: ['wolf', 'sk', 'target'],
      nightAction: {
        id: 'sk-call',
        kind: 'SERIAL_KILLER_ATTACK',
        roleId: 'serial-killer',
        roleName: 'Sát Nhân Hàng Loạt',
        instructions: 'Chọn một người khác hoặc Không ai.',
        mode: 'SERIAL_KILLER_ATTACK',
        candidates: [players[0], players[2]],
        currentTargetId: null,
        hasSelected: true,
      },
    })
    const ordinary = playerSnapshotFromPayload({
      room,
      self: players[2],
      players,
      assignment: { playerId: 'target', roleId: 'villager', assignedAt: room.createdAt },
      alivePlayerIds: ['wolf', 'sk', 'target'],
    })

    expect(holder.nightAction).toMatchObject({
      kind: 'SERIAL_KILLER_ATTACK',
      mode: 'SERIAL_KILLER_ATTACK',
      currentTargetId: null,
      hasSelected: true,
    })
    expect(ordinary.nightAction).toBeUndefined()
    expect(JSON.stringify(ordinary)).not.toContain('SERIAL_KILLER')
  })

  it('hydrates source-aware immunity only in the Moderator projection', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { werewolf: 1, 'serial-killer': 1, villager: 1 },
      players,
      assignments: [
        { playerId: 'wolf', roleId: 'werewolf', assignedAt: room.createdAt },
        { playerId: 'sk', roleId: 'serial-killer', assignedAt: room.createdAt },
        { playerId: 'target', roleId: 'villager', assignedAt: room.createdAt },
      ],
      alivePlayerIds: ['wolf', 'sk', 'target'],
      nightResolution: {
        id: 'resolution',
        nightNumber: 1,
        outcome: 'IMMUNE',
        resolvedAt: room.updatedAt,
        provisionalDeathCandidateIds: [],
        effects: [{
          id: 'wolf-effect',
          sourceType: 'WOLF_ATTACK',
          sourceRoleId: 'werewolf',
          category: 'HOSTILE_VILLAIN_ATTACK',
          targetPlayerId: 'sk',
          lethal: false,
          protectorBlockable: true,
          outcome: 'IMMUNE_TO_WOLF_ATTACK',
          immunity: {
            kind: 'WOLF_ATTACK_IMMUNITY',
            roleId: 'serial-killer',
          },
        }],
      },
    })

    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') return
    expect(snapshot.state.nightResolution).toMatchObject({
      outcome: 'IMMUNE',
      effects: [{
        outcome: 'IMMUNE_TO_WOLF_ATTACK',
        immunity: {
          kind: 'WOLF_ATTACK_IMMUNITY',
          roleId: 'serial-killer',
        },
      }],
    })
  })

  it('routes intent IDs only and never accepts client effect outcomes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-sk' } } },
          error: null,
        }),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)

    await transport.dispatch(room.id, {
      type: 'CALL_NIGHT_ROLE',
      roleId: 'serial-killer',
    })
    await transport.dispatch(room.id, {
      type: 'CAST_SERIAL_KILLER_ATTACK',
      playerId: 'ignored-client-player',
      targetId: 'target',
    })
    await transport.dispatch(room.id, {
      type: 'CONFIRM_SERIAL_KILLER_ATTACK',
      playerId: 'ignored-client-player',
    })

    expect(rpc).toHaveBeenNthCalledWith(1, 'ms1g2_open_serial_killer_call', {
      p_room_id: room.id,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'ms1g2_submit_serial_killer_intent', {
      p_room_id: room.id,
      p_target_player_id: 'target',
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'ms1g2_confirm_serial_killer_intent', {
      p_room_id: room.id,
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(
      /blocked|immune|lethal|protectorBlockable|roleIdentity/i,
    )
  })

  it('keeps G1 private storage locked and exposes only minimal security-definer RPCs', () => {
    const sql = readFileSync(
      'supabase/migrations/20260827010000_ms1g1_serial_killer_authority.sql',
      'utf8',
    )
    expect(sql).toContain('create table private.serial_killer_intents')
    expect(sql).toContain('alter table private.serial_killer_intents enable row level security')
    expect(sql).toContain('revoke all on table private.serial_killer_intents from public, anon, authenticated')
    expect(sql).toContain("set search_path = ''")
    expect(sql).toContain('private.require_auth_uid()')
    expect(sql).toContain('for update')
    expect(sql).toContain("'IMMUNE_TO_WOLF_ATTACK'")
    expect(sql).toContain("'SERIAL_KILLER_ATTACK'")
    expect(sql).not.toMatch(/service_role|VITE_SUPABASE|database password/i)
  })
})
