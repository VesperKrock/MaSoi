import { describe, expect, it } from 'vitest'
import { createDemoRoom } from '../game/room-engine'
import type { MatchOutcome, RoomState } from '../game/types'
import {
  finalRevealPageSize,
  getOutcomePresentation,
  projectEndMatch,
} from './end-match'

const labels: Record<MatchOutcome, string> = {
  FOOL: 'THẰNG NGỐ CHIẾN THẮNG',
  WOLF: 'MA SÓI CHIẾN THẮNG',
  COUPLE: 'CẶP ĐÔI CHIẾN THẮNG',
  SERIAL_KILLER: 'SÁT NHÂN HÀNG LOẠT CHIẾN THẮNG',
  VILLAGE: 'DÂN LÀNG CHIẾN THẮNG',
  DRAW: 'Cả làng bị xóa sổ.',
}

function finishedState(): RoomState {
  const state = createDemoRoom(7)
  state.players = Array.from({ length: 7 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
    alias: `Người chơi ${index + 1}`,
    alive: index < 3,
  }))
  state.roleAssignments = [
    ['player-1', 'cupid'],
    ['player-2', 'half-wolf'],
    ['player-3', 'traitor'],
    ['player-4', 'fool'],
    ['player-5', 'werewolf'],
    ['player-6', 'seer'],
    ['player-7', 'villager'],
  ].map(([playerId, roleId]) => ({
    playerId,
    roleId: roleId as RoomState['roleAssignments'][number]['roleId'],
  }))
  state.factionTransitions = {
    halfWolves: {
      'player-2': { playerId: 'player-2', status: 'TRANSFORMED' },
    },
    traitors: {
      'player-3': { playerId: 'player-3', status: 'CONVERTED_VILLAGE' },
    },
  }
  state.cupidLovers = {
    couple: {
      id: 'couple-1',
      cupidPlayerId: 'player-1',
      loverPlayerIds: ['player-2', 'player-3'],
      pairedNightNumber: 1,
      pairedAt: 1,
    },
    loverRevealAcknowledgedPlayerIds: [],
    objective: {
      cupidPlayerId: 'player-1',
      status: 'ACTIVE',
      changedAt: 1,
    },
  }
  state.lifecycle = 'FINISHED'
  state.phase = 'ENDED'
  state.matchResult = {
    outcome: 'COUPLE',
    finishedAt: 2,
    finishedPhase: 'DAY',
    dayNumber: 1,
    trigger: 'DAY_STABILIZED',
    subjectPlayerIds: ['player-1', 'player-2', 'player-3'],
  }
  return state
}

describe('MS-1H1 end-match projection', () => {
  it('maps all six persisted outcomes to locked Vietnamese copy', () => {
    for (const [outcome, title] of Object.entries(labels)) {
      expect(getOutcomePresentation(outcome as MatchOutcome).title).toBe(title)
    }
    expect(getOutcomePresentation('DRAW').isDraw).toBe(true)
  })

  it('projects original roles, subjects, runtime notes, and Lovers only after FINISHED', () => {
    const state = finishedState()
    state.lifecycle = 'IN_GAME'
    state.phase = 'DAY'
    expect(projectEndMatch(state)).toBeUndefined()

    state.lifecycle = 'FINISHED'
    state.phase = 'ENDED'
    const projection = projectEndMatch(state)
    expect(projection?.subjects.map((player) => player.id)).toEqual([
      'player-1',
      'player-2',
      'player-3',
    ])
    expect(projection?.roster.find((entry) => entry.player.id === 'player-2')).toMatchObject({
      roleId: 'half-wolf',
      runtimeNote: 'HALF_WOLF_TRANSFORMED',
      loverPartnerPlayerId: 'player-3',
    })
    expect(projection?.roster.find((entry) => entry.player.id === 'player-3')).toMatchObject({
      roleId: 'traitor',
      runtimeNote: 'TRAITOR_CONVERTED_VILLAGE',
      loverPartnerPlayerId: 'player-2',
    })
    expect(projection?.couple).toEqual({
      cupidPlayerId: 'player-1',
      loverPlayerIds: ['player-2', 'player-3'],
    })
    expect(state.roleAssignments.find((entry) => entry.playerId === 'player-2')?.roleId).toBe('half-wolf')
    expect(state.roleAssignments.find((entry) => entry.playerId === 'player-3')?.roleId).toBe('traitor')
  })

  it('locks final reveal pagination to at most eight Players per page', () => {
    expect(finalRevealPageSize).toBe(8)
    expect(Math.ceil(16 / finalRevealPageSize)).toBe(2)
  })
})
