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
  seatCount: 7,
  status: 'IN_GAME',
  phase: 'DAY',
  dayNumber: 1,
  wolfPolicy: 'RANDOM_ON_TIE',
  revision: 12,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
}

const players = [
  { id: 'player-a', seat: 1, displayName: 'An', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'player-b', seat: 2, displayName: 'Bình', revealConfirmed: true, joinedAt: room.createdAt, alive: false },
  { id: 'player-c', seat: 3, displayName: 'Châu', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
]

const dayVote = {
  id: 'vote-1',
  status: 'RESOLVED',
  openedAt: '2026-08-26T00:01:00.000Z',
  deadlineAt: '2026-08-26T00:01:30.000Z',
  resolvedAt: '2026-08-26T00:01:31.000Z',
  totals: { 'player-b': 2 },
  result: { kind: 'UNIQUE', hangedPlayerId: 'player-b', hunterRevealed: true },
  hangingEffect: {
    id: 'effect-hang',
    sourceType: 'DAY_HANGING',
    targetPlayerId: 'player-b',
  },
  hunterRevenge: {
    hunterPlayerId: 'player-b',
    status: 'PENDING',
  },
}

describe('MS-1D2 Supabase transport projections', () => {
  it('hydrates Moderator operational result without inventing raw ballots', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { villager: 1, hunter: 1, mayor: 1 },
      players,
      assignments: [
        { playerId: 'player-a', roleId: 'mayor', assignedAt: room.createdAt },
        { playerId: 'player-b', roleId: 'hunter', assignedAt: room.createdAt },
        { playerId: 'player-c', roleId: 'villager', assignedAt: room.createdAt },
      ],
      alivePlayerIds: ['player-a', 'player-c'],
      dayVote,
    })
    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') return
    expect(snapshot.state.dayVote).toMatchObject({
      status: 'CLOSED',
      totals: { 'player-b': 2 },
      result: { kind: 'UNIQUE', targetIds: ['player-b'] },
      hunterRevenge: { hunterPlayerId: 'player-b', status: 'PENDING' },
    })
    expect(snapshot.state.dayVote?.votes).toEqual({})
  })

  it('hydrates only own selection, anonymous totals, and private Hunter revenge action', () => {
    const snapshot = playerSnapshotFromPayload({
      room,
      self: players[1],
      players,
      assignment: { playerId: 'player-b', roleId: 'hunter', assignedAt: room.createdAt },
      alivePlayerIds: ['player-a', 'player-c'],
      dayVote: {
        status: 'RESOLVED',
        openedAt: dayVote.openedAt,
        deadlineAt: dayVote.deadlineAt,
        candidates: [],
        totals: dayVote.totals,
        result: {
          kind: 'UNIQUE',
          hangedPlayer: players[1],
          hunterRevealed: true,
          hunterRevengeStatus: 'PENDING',
        },
        hunterRevengeAction: { candidates: [players[0], players[2]] },
      },
    })
    expect(snapshot.dayVote).toMatchObject({
      totals: { 'player-b': 2 },
      result: { hunterRevealed: true, hunterRevengeStatus: 'PENDING' },
      hunterRevengeAction: { candidates: [{ id: 'player-a' }, { id: 'player-c' }] },
    })
    expect(snapshot.dayVote).not.toHaveProperty('votes')
    expect(snapshot).not.toHaveProperty('assignments')
  })

  it('routes D2 commands to minimal RPC signatures without caller weight/result inputs', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'auth-a' } } },
          error: null,
        }),
      },
      rpc,
    } as unknown as SupabaseClient
    const transport = new SupabaseRoomTransport(client)
    await transport.dispatch(room.id, {
      type: 'CAST_DAY_VOTE', playerId: 'ignored-client-player', targetId: 'player-b',
    })
    await transport.dispatch(room.id, {
      type: 'SUBMIT_HUNTER_REVENGE', playerId: 'ignored-client-player', targetId: null,
    })
    await transport.dispatch(room.id, { type: 'CLOSE_DAY_VOTE' })
    await transport.dispatch(room.id, { type: 'START_NEXT_NIGHT' })

    expect(rpc).toHaveBeenNthCalledWith(1, 'ms1g2_cast_day_vote', {
      p_room_id: room.id,
      p_target_player_id: 'player-b',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'ms1g2_submit_hunter_revenge', {
      p_room_id: room.id,
      p_target_player_id: null,
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'ms1g2_resolve_day_vote', {
      p_room_id: room.id,
    })
    expect(rpc).toHaveBeenNthCalledWith(4, 'ms1g2_start_next_night', {
      p_room_id: room.id,
    })
  })
})
