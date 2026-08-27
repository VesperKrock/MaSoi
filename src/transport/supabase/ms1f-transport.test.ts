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
  revision: 12,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
}

const players = [
  { id: 'cupid', seat: 1, displayName: 'Cupid', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'lover-a', seat: 2, displayName: 'An', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'lover-b', seat: 3, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
]

const couple = {
  id: 'couple-1',
  cupidPlayerId: 'cupid',
  loverPlayerIds: ['lover-a', 'lover-b'],
  pairedNightNumber: 1,
  pairedAt: room.updatedAt,
}

describe('MS-1F Supabase transport boundary', () => {
  it('hydrates operational Cupid truth for Moderator including source-aware heartbreak', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { cupid: 1, villager: 2 },
      players,
      assignments: [
        { playerId: 'cupid', roleId: 'cupid', assignedAt: room.createdAt },
        { playerId: 'lover-a', roleId: 'villager', assignedAt: room.createdAt },
        { playerId: 'lover-b', roleId: 'villager', assignedAt: room.createdAt },
      ],
      alivePlayerIds: ['cupid'],
      cupidLovers: {
        couple,
        loverRevealAcknowledgedPlayerIds: ['lover-a'],
        objective: {
          cupidPlayerId: 'cupid',
          status: 'FALLBACK_VILLAGE',
          changedAt: room.updatedAt,
          reason: 'COUPLE_DEAD',
        },
      },
      nightResolution: {
        id: 'resolution-1',
        nightNumber: 1,
        outcome: 'UNBLOCKED',
        resolvedAt: room.updatedAt,
        provisionalDeathCandidateIds: ['lover-a'],
        effects: [{
          id: 'heartbreak-1',
          sourceType: 'LOVER_HEARTBREAK',
          sourceRoleId: 'cupid',
          sourcePlayerId: 'lover-a',
          coupleId: 'couple-1',
          category: 'NON_VILLAIN_LETHAL_EFFECT',
          targetPlayerId: 'lover-b',
          lethal: true,
          protectorBlockable: false,
          witchInteractable: false,
          outcome: 'UNBLOCKED',
        }],
      },
    })
    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') return
    expect(snapshot.state.cupidLovers).toMatchObject({
      couple: { loverPlayerIds: ['lover-a', 'lover-b'] },
      objective: { status: 'FALLBACK_VILLAGE' },
    })
    expect(snapshot.state.nightResolution?.effects[0]).toMatchObject({
      sourceType: 'LOVER_HEARTBREAK',
      sourcePlayerId: 'lover-a',
      targetPlayerId: 'lover-b',
      protectorBlockable: false,
      witchInteractable: false,
    })
  })

  it('hydrates only reciprocal partner name and never another relationship', () => {
    const lover = playerSnapshotFromPayload({
      room,
      self: players[1],
      players,
      assignment: { playerId: 'lover-a', roleId: 'villager', assignedAt: room.createdAt },
      alivePlayerIds: ['cupid', 'lover-a', 'lover-b'],
      loverRelationship: { partner: players[2], revealPending: true },
    })
    const ordinary = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      assignment: { playerId: 'cupid', roleId: 'cupid', assignedAt: room.createdAt },
      alivePlayerIds: ['cupid', 'lover-a', 'lover-b'],
    })
    expect(lover.loverRelationship).toMatchObject({
      partner: { id: 'lover-b', alias: 'Bình' },
      revealPending: true,
    })
    expect(lover.loverRelationship?.partner).not.toHaveProperty('roleId')
    expect(ordinary.loverRelationship).toBeUndefined()
    expect(JSON.stringify(lover)).not.toContain('couple-1')
  })

  it('hydrates the Night-1 Cupid action without card art or authority flags', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[0],
      players,
      assignment: { playerId: 'cupid', roleId: 'cupid', assignedAt: room.createdAt },
      alivePlayerIds: ['cupid', 'lover-a', 'lover-b'],
      nightAction: {
        id: 'call-1',
        kind: 'CUPID_PAIRING',
        roleId: 'cupid',
        roleName: 'Thần Tình Yêu',
        instructions: 'Chọn đúng hai người.',
        mode: 'CUPID_PAIRING',
        candidates: [players[1], players[2]],
        selectedTargetIds: [],
        hasSelected: false,
      },
    })
    expect(snapshot.nightAction).toMatchObject({
      kind: 'CUPID_PAIRING',
      mode: 'CUPID_PAIRING',
      selectedTargetIds: [],
    })
    expect(snapshot.nightAction?.candidates).toHaveLength(2)
    expect(JSON.stringify(snapshot.nightAction)).not.toContain('cardAsset')
  })

  it('routes only target IDs for pairing and uses the F wrappers for affected death paths', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-cupid' } } },
          error: null,
        }),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)
    await transport.dispatch(room.id, {
      type: 'SUBMIT_CUPID_PAIRING',
      playerId: 'ignored-client-player',
      targetIds: ['lover-a', 'lover-b'],
    })
    await transport.dispatch(room.id, { type: 'FINALIZE_NIGHT_CHECKPOINT' })
    await transport.dispatch(room.id, { type: 'CLOSE_DAY_VOTE' })
    await transport.dispatch(room.id, {
      type: 'SUBMIT_HUNTER_REVENGE',
      playerId: 'ignored-client-player',
      targetId: 'lover-a',
    })
    await transport.dispatch(room.id, { type: 'START_NEXT_NIGHT' })

    expect(rpc).toHaveBeenNthCalledWith(1, 'ms1g2_submit_cupid_pairing', {
      p_room_id: room.id,
      p_first_target_player_id: 'lover-a',
      p_second_target_player_id: 'lover-b',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'ms1g2_finalize_night_checkpoint', {
      p_room_id: room.id,
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'ms1g2_resolve_day_vote', {
      p_room_id: room.id,
    })
    expect(rpc).toHaveBeenNthCalledWith(4, 'ms1g2_submit_hunter_revenge', {
      p_room_id: room.id,
      p_target_player_id: 'lover-a',
    })
    expect(rpc).toHaveBeenNthCalledWith(5, 'ms1g2_start_next_night', {
      p_room_id: room.id,
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(
      /lover(true|=)|heartbreak|objective|protectorBlockable/i,
    )
  })
})
