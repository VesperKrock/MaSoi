import { describe, expect, it } from 'vitest'
import {
  createOfflineSessionState,
  reduceOfflineSession,
} from './offline-session'
import {
  clearOfflineSession,
  inspectOfflineSession,
  loadOfflineSession,
  legacyOfflineSessionStorageKey,
  offlineSessionStorageKey,
  offlineSessionV3StorageKey,
  offlineSessionV2StorageKey,
  saveOfflineSession,
  type OfflineStorage,
} from './offline-storage'

class MemoryStorage implements OfflineStorage {
  values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

describe('MS-O1 offline persistence', () => {
  it('restores the exact setup, deal and mid-discovery state', () => {
    const storage = new MemoryStorage()
    let state = createOfflineSessionState(1)
    for (let index = 0; index < 7; index += 1) {
      state = reduceOfflineSession(
        state,
        { type: 'SET_PLAYER_NAME', index, name: `Người ${index + 1}` },
        index + 2,
      )
    }
    expect(saveOfflineSession(storage, state)).toBe(true)
    expect(loadOfflineSession(storage)).toEqual(state)

    state = reduceOfflineSession(
      state,
      { type: 'CONTINUE_TO_PHYSICAL_DEAL' },
      20,
    )
    expect(saveOfflineSession(storage, state)).toBe(true)
    expect(loadOfflineSession(storage)).toEqual(state)

    state = reduceOfflineSession(
      state,
      { type: 'BEGIN_NIGHT_ONE_DISCOVERY' },
      21,
    )
    state = reduceOfflineSession(
      state,
      { type: 'TOGGLE_HOLDER', playerId: 'offline-player-4' },
      22,
    )
    expect(saveOfflineSession(storage, state)).toBe(true)
    expect(loadOfflineSession(storage)).toEqual(state)
  })

  it('uses a versioned namespace isolated from Online room storage', () => {
    const storage = new MemoryStorage()
    const onlineKey = 'masoi.ms0b.rooms.v1'
    storage.setItem(onlineKey, '{"online":"untouched"}')
    saveOfflineSession(storage, createOfflineSessionState(1))

    expect(offlineSessionStorageKey).toBe(
      'masoi.offline-moderator.session.v4',
    )
    expect(offlineSessionStorageKey).not.toBe(onlineKey)
    expect(storage.getItem(onlineKey)).toBe('{"online":"untouched"}')
  })

  it('fails corrupt or unsupported persisted data safely without falling back', () => {
    const storage = new MemoryStorage()
    storage.setItem(offlineSessionStorageKey, '{bad json')
    expect(loadOfflineSession(storage)).toBeNull()
    expect(inspectOfflineSession(storage).status).toBe('CORRUPT')
    storage.setItem(
      offlineSessionStorageKey,
      JSON.stringify({ ...createOfflineSessionState(1), schemaVersion: 99 }),
    )
    expect(loadOfflineSession(storage)).toBeNull()
  })

  it('migrates the O1 v1 candidate without discarding its exact discovery state', () => {
    const storage = new MemoryStorage()
    const current = createOfflineSessionState(1)
    const legacy = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => key !== 'authority' && key !== 'authorityInput',
      ),
    )
    storage.setItem(
      legacyOfflineSessionStorageKey,
      JSON.stringify({ ...legacy, schemaVersion: 1 }),
    )

    expect(loadOfflineSession(storage)).toMatchObject({
      schemaVersion: 4,
      phase: 'SETUP',
      playerNames: current.playerNames,
      roleComposition: current.roleComposition,
      authority: null,
      offlineEvents: [],
    })
  })

  it('migrates v2 authority and synthesizes durable role-discovery truth', () => {
    const storage = new MemoryStorage()
    const current = {
      ...createOfflineSessionState(20),
      phase: 'NIGHT_1_DISCOVERY' as const,
      playerNames: Array.from({ length: 7 }, (_, index) => `Người ${index + 1}`),
      roleAssignments: [
        { playerId: 'offline-player-1', roleId: 'werewolf' as const },
        { playerId: 'offline-player-2', roleId: 'werewolf' as const },
      ],
      nightOne: {
        callPlan: ['werewolf' as const, 'seer' as const],
        callIndex: 1,
        activeStep: {
          kind: 'HOLDER_DISCOVERY' as const,
          roleId: 'seer' as const,
          requiredHolderCount: 1,
        },
        draftHolderIds: [],
      },
    }
    const withoutEvents = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== 'offlineEvents'),
    )
    storage.setItem(
      offlineSessionV2StorageKey,
      JSON.stringify({ ...withoutEvents, schemaVersion: 2 }),
    )

    const migrated = loadOfflineSession(storage)
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      phase: 'NIGHT_1_DISCOVERY',
      roleAssignments: current.roleAssignments,
    })
    expect(migrated?.offlineEvents).toEqual([{
      id: 'offline-migrated-role-discovery-werewolf',
      type: 'ROLE_IDENTITY_DISCOVERED',
      occurredAt: 18,
      roleId: 'werewolf',
      holderPlayerIds: ['offline-player-1', 'offline-player-2'],
    }])
  })

  it('migrates v3 Day ballots to a duplicate-free Moderator verdict boundary', () => {
    const storage = new MemoryStorage()
    const base = createOfflineSessionState(100)
    const players = Array.from({ length: 7 }, (_, index) => ({
      id: `offline-player-${index + 1}`,
      seat: index + 1,
      alias: `Người ${index + 1}`,
      alive: index !== 1,
    }))
    const authority = {
      schemaVersion: 2,
      roomId: 'OFFLINE-MODERATOR',
      roomCode: 'OFFLINE',
      revision: 9,
      createdAt: 10,
      lifecycle: 'IN_GAME',
      phase: 'DAY',
      dayNumber: 2,
      players,
      roleAssignments: players.map((player, index) => ({
        playerId: player.id,
        roleId: index === 0 ? 'werewolf' : index === 1 ? 'hunter' : 'villager',
      })),
      roleRevealConfirmedPlayerIds: players.map((player) => player.id),
      config: {
        seatCount: 7,
        roleComposition: { werewolf: 1, hunter: 1, villager: 5 },
        wolfPolicy: 'RANDOM_ON_TIE',
        nightRoleIds: ['werewolf', 'hunter'],
        revoteDurationMs: 10_000,
      },
      night: null,
      dayVote: {
        status: 'CLOSED',
        votes: { 'offline-player-1': 'offline-player-2' },
        openedAt: 80,
        deadlineAt: 90,
        closedAt: 91,
        result: {
          kind: 'UNIQUE',
          targetIds: ['offline-player-2'],
          counts: { 'offline-player-2': 2 },
        },
        hangingEffect: {
          id: 'hang-1',
          sourceType: 'DAY_HANGING',
          category: 'DAY_LETHAL_EFFECT',
          targetPlayerId: 'offline-player-2',
          lethal: true,
          protectorBlockable: false,
          finalized: true,
        },
        hunterRevenge: {
          hunterPlayerId: 'offline-player-2',
          status: 'PENDING',
        },
      },
      journal: [
        { id: 'open', type: 'DAY_VOTE_OPENED', timestamp: 80, dayNumber: 2, phase: 'DAY' },
        { id: 'vote', type: 'DAY_VOTE_CHANGED', timestamp: 81, dayNumber: 2, phase: 'DAY' },
        { id: 'hang', type: 'DAY_HANGING_CREATED', timestamp: 91, dayNumber: 2, phase: 'DAY', targetPlayerId: 'offline-player-2' },
      ],
    }
    storage.setItem(offlineSessionV3StorageKey, JSON.stringify({
      ...base,
      schemaVersion: 3,
      phase: 'MATCH',
      playerNames: players.map((player) => player.alias),
      roleAssignments: authority.roleAssignments,
      authority,
      authorityInput: {
        cupidTargetIds: [],
        witchResurrectionTargetId: null,
        witchPoisonTargetId: null,
        dayVoterId: 'offline-player-1',
      },
    }))

    const migrated = inspectOfflineSession(storage)
    expect(migrated.sourceVersion).toBe(3)
    expect(migrated.state?.schemaVersion).toBe(4)
    expect(migrated.state?.authority?.dayVote).toBeNull()
    expect(migrated.state?.authority?.dayVerdict).toMatchObject({
      outcome: 'EXECUTED',
      candidatePlayerId: 'offline-player-2',
      hunterRevenge: { status: 'PENDING' },
    })
    expect(migrated.state?.authority?.journal.map((event) => event.type)).toEqual([
      'DAY_HANGING_CREATED',
    ])
    expect(migrated.state?.offlineEvents).toContainEqual(expect.objectContaining({
      type: 'DAY_CANDIDATE_LOCKED',
      candidatePlayerId: 'offline-player-2',
    }))

    const openStorage = new MemoryStorage()
    const openSnapshot = JSON.parse(storage.getItem(offlineSessionV3StorageKey) ?? '{}')
    openSnapshot.authority.players[1].alive = true
    openSnapshot.authority.dayVote = {
      status: 'OPEN',
      votes: { 'offline-player-1': 'offline-player-2' },
      openedAt: 80,
      deadlineAt: 110,
    }
    openSnapshot.authority.journal = [
      { id: 'open', type: 'DAY_VOTE_OPENED', timestamp: 80, dayNumber: 2, phase: 'DAY' },
      { id: 'vote', type: 'DAY_VOTE_CHANGED', timestamp: 81, dayNumber: 2, phase: 'DAY' },
    ]
    openStorage.setItem(offlineSessionV3StorageKey, JSON.stringify(openSnapshot))
    const openMigrated = loadOfflineSession(openStorage)
    expect(openMigrated?.authority?.dayVote).toBeNull()
    expect(openMigrated?.authority?.dayVerdict).toBeNull()
    expect(openMigrated?.authority?.players[1].alive).toBe(true)
    expect(openMigrated?.authority?.journal).toEqual([])
    expect(openMigrated?.authorityInput.dayDecision).toEqual({
      stage: 'CANDIDATE_DRAFT',
      selection: { kind: 'UNSET' },
    })
  })

  it('clears Offline versions only and leaves Online storage untouched', () => {
    const storage = new MemoryStorage()
    const onlineKey = 'masoi.ms0b.rooms.v1'
    storage.setItem(onlineKey, '{"online":"untouched"}')
    storage.setItem(offlineSessionStorageKey, '{}')
    storage.setItem(offlineSessionV3StorageKey, '{}')
    storage.setItem(offlineSessionV2StorageKey, '{}')
    storage.setItem(legacyOfflineSessionStorageKey, '{}')

    expect(clearOfflineSession(storage)).toBe(true)
    expect(storage.getItem(offlineSessionStorageKey)).toBeNull()
    expect(storage.getItem(offlineSessionV3StorageKey)).toBeNull()
    expect(storage.getItem(offlineSessionV2StorageKey)).toBeNull()
    expect(storage.getItem(legacyOfflineSessionStorageKey)).toBeNull()
    expect(storage.getItem(onlineKey)).toBe('{"online":"untouched"}')
  })
})
