import { describe, expect, it } from 'vitest'
import {
  moderatorSnapshotFromPayload,
  playerSnapshotFromPayload,
} from './supabase-room-transport'

const room = {
  id: '00000000-0000-4000-8000-000000000001',
  code: '012345',
  seatCount: 3,
  status: 'IN_GAME',
  phase: 'NIGHT',
  dayNumber: 2,
  wolfPolicy: 'RANDOM_ON_TIE',
  revision: 12,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
}

const players = [
  { id: 'half', seat: 1, displayName: 'Bán', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'traitor', seat: 2, displayName: 'Phản', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
  { id: 'seer', seat: 3, displayName: 'Tiên', revealConfirmed: true, joinedAt: room.createdAt, alive: true },
]

const assignments = [
  { playerId: 'half', roleId: 'half-wolf', assignedAt: room.createdAt },
  { playerId: 'traitor', roleId: 'traitor', assignedAt: room.createdAt },
  { playerId: 'seer', roleId: 'seer', assignedAt: room.createdAt },
]

describe('MS-1E Supabase transition projections', () => {
  it('hydrates compact transition truth for Moderator ownership', () => {
    const snapshot = moderatorSnapshotFromPayload({
      room,
      roleConfig: { 'half-wolf': 1, traitor: 1, seer: 1 },
      players,
      assignments,
      alivePlayerIds: ['half', 'traitor', 'seer'],
      factionTransitions: {
        halfWolves: {
          half: {
            playerId: 'half',
            status: 'TRANSFORMED',
            bittenNightNumber: 1,
            transformDueNightNumber: 2,
            bittenAt: room.createdAt,
            transformedAt: room.updatedAt,
          },
        },
        traitors: {
          traitor: {
            playerId: 'traitor',
            status: 'CONVERTED_VILLAGE',
            convertedAt: room.updatedAt,
            conversionReason: 'NO_LIVING_BITE_CAPABLE_WOLF',
          },
        },
      },
      nightResolution: {
        id: 'resolution',
        nightNumber: 2,
        outcome: 'BITE_SCHEDULED',
        resolvedAt: room.updatedAt,
        provisionalDeathCandidateIds: [],
        effects: [
          {
            id: 'bite',
            sourceType: 'WOLF_ATTACK',
            sourceRoleId: 'werewolf',
            category: 'HOSTILE_VILLAIN_ATTACK',
            targetPlayerId: 'half',
            lethal: false,
            protectorBlockable: true,
            outcome: 'HALF_WOLF_BITE_SCHEDULED',
            conversion: {
              kind: 'HALF_WOLF_TRANSFORMATION',
              dueNightNumber: 3,
            },
          },
        ],
      },
    })
    expect(snapshot.audience).toBe('MODERATOR')
    if (snapshot.audience !== 'MODERATOR') return
    expect(snapshot.state.factionTransitions).toMatchObject({
      halfWolves: { half: { status: 'TRANSFORMED' } },
      traitors: { traitor: { status: 'CONVERTED_VILLAGE' } },
    })
    expect(snapshot.state.nightResolution).toMatchObject({
      outcome: 'BITE_SCHEDULED',
      effects: [
        {
          outcome: 'HALF_WOLF_BITE_SCHEDULED',
          conversion: { dueNightNumber: 3 },
        },
      ],
    })
  })

  it('never accepts faction-transition state into a Player projection', () => {
    const payload = {
      room,
      self: players[0],
      players,
      assignment: assignments[0],
      alivePlayerIds: ['half', 'traitor', 'seer'],
      factionTransitions: {
        halfWolves: { half: { playerId: 'half', status: 'TRANSFORMED' } },
      },
    }
    const snapshot = playerSnapshotFromPayload(payload)
    expect(snapshot).not.toHaveProperty('factionTransitions')
    expect(JSON.stringify(snapshot)).not.toContain('TRANSFORMED')
  })
})
