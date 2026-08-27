import type {
  MatchOutcome,
  Player,
  PlayerId,
  RoleId,
  RoomState,
} from '../game/types'

export const finalRevealPageSize = 8

export type FinalRuntimeNote =
  | 'HALF_WOLF_TRANSFORMED'
  | 'TRAITOR_CONVERTED_VILLAGE'

export interface FinalRosterEntry {
  player: Player
  roleId: RoleId
  runtimeNote?: FinalRuntimeNote
  loverPartnerPlayerId?: PlayerId
}

export interface FinalCouple {
  cupidPlayerId: PlayerId
  loverPlayerIds: [PlayerId, PlayerId]
}

export interface EndMatchSnapshot {
  outcome: MatchOutcome
  subjects: Player[]
  roster: FinalRosterEntry[]
  couple?: FinalCouple
}

export interface OutcomePresentation {
  eyebrow: string
  title: string
  isDraw: boolean
}

const outcomePresentations: Record<MatchOutcome, OutcomePresentation> = {
  FOOL: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'THẰNG NGỐ CHIẾN THẮNG',
    isDraw: false,
  },
  WOLF: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'MA SÓI CHIẾN THẮNG',
    isDraw: false,
  },
  COUPLE: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'CẶP ĐÔI CHIẾN THẮNG',
    isDraw: false,
  },
  SERIAL_KILLER: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'SÁT NHÂN HÀNG LOẠT CHIẾN THẮNG',
    isDraw: false,
  },
  VILLAGE: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'DÂN LÀNG CHIẾN THẮNG',
    isDraw: false,
  },
  DRAW: {
    eyebrow: 'KẾT QUẢ CUỐI TRẬN',
    title: 'Cả làng bị xóa sổ.',
    isDraw: true,
  },
}

/** Presentation mapping only. Winner selection remains G2 server authority. */
export function getOutcomePresentation(
  outcome: MatchOutcome,
): OutcomePresentation {
  return outcomePresentations[outcome]
}

/** Local/dev projection equivalent of the FINISHED-only server payload. */
export function projectEndMatch(
  state: RoomState,
): EndMatchSnapshot | undefined {
  if (state.lifecycle !== 'FINISHED' || !state.matchResult) return undefined

  const playerById = new Map(state.players.map((player) => [player.id, player]))
  const couple = state.cupidLovers?.couple
  const loverPartnerById = new Map<PlayerId, PlayerId>()
  if (couple) {
    loverPartnerById.set(couple.loverPlayerIds[0], couple.loverPlayerIds[1])
    loverPartnerById.set(couple.loverPlayerIds[1], couple.loverPlayerIds[0])
  }

  const roster = state.roleAssignments
    .map((assignment): FinalRosterEntry | undefined => {
      const player = playerById.get(assignment.playerId)
      if (!player) return undefined
      const runtimeNote: FinalRuntimeNote | undefined =
        assignment.roleId === 'half-wolf' &&
        state.factionTransitions?.halfWolves[player.id]?.status === 'TRANSFORMED'
          ? 'HALF_WOLF_TRANSFORMED'
          : assignment.roleId === 'traitor' &&
              state.factionTransitions?.traitors[player.id]?.status ===
                'CONVERTED_VILLAGE'
            ? 'TRAITOR_CONVERTED_VILLAGE'
            : undefined
      return {
        player: structuredClone(player),
        roleId: assignment.roleId,
        runtimeNote,
        loverPartnerPlayerId: loverPartnerById.get(player.id),
      }
    })
    .filter((entry): entry is FinalRosterEntry => Boolean(entry))
    .sort((left, right) => left.player.seat - right.player.seat)

  return {
    outcome: state.matchResult.outcome,
    subjects: state.matchResult.subjectPlayerIds
      .map((playerId) => playerById.get(playerId))
      .filter((player): player is Player => Boolean(player))
      .map((player) => structuredClone(player)),
    roster,
    couple: couple
      ? {
          cupidPlayerId: couple.cupidPlayerId,
          loverPlayerIds: [...couple.loverPlayerIds] as [PlayerId, PlayerId],
        }
      : undefined,
  }
}
