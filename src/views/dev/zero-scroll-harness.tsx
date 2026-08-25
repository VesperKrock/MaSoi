import type { RoomCommand } from '../../domain/game/types'
import { cardAssetUrl } from '../../domain/roles/classic-catalog'
import type { PlayerRoomSnapshot } from '../../state/room-projection'
import type { RoomTransport } from '../../transport/room-transport'
import { JoinRoomView } from '../entry/join-room-view'
import { LandingView } from '../entry/landing-view'
import { PlayerView } from '../player/player-view'

const players = Array.from({ length: 16 }, (_, index) => ({
  id: `qa-player-${index + 1}`,
  seat: index + 1,
  alias: `Bạn ${index + 1}`,
  alive: true,
}))

const baseSnapshot: PlayerRoomSnapshot = {
  audience: 'PLAYER',
  revision: 1,
  roomId: 'qa-room',
  roomCode: '381624',
  lifecycle: 'IN_GAME',
  seatCount: 16,
  phase: 'NIGHT',
  dayNumber: 2,
  self: players[0],
  players,
  roleIdentity: {
    roleId: 'seer',
    displayName: 'Tiên Tri',
    factionMeaning: 'Dân Làng',
    rulesText: 'Mỗi đêm chọn một người để xem người đó là Ma Sói hay không.',
    cardAsset: cardAssetUrl('Tiên Tri.jpg'),
  },
  roleRevealPending: false,
}

const noOpDispatch = async (command: RoomCommand) => {
  void command
  return true
}

function snapshotFor(surface: string): PlayerRoomSnapshot {
  if (surface === 'lobby') {
    return {
      ...baseSnapshot,
      lifecycle: 'LOBBY',
      phase: 'SETUP',
      players: players.slice(0, 9),
      roleIdentity: undefined,
    }
  }
  if (surface === 'reveal') {
    return {
      ...baseSnapshot,
      lifecycle: 'ROLE_REVEAL',
      phase: 'SETUP',
      roleRevealPending: true,
    }
  }
  if (surface === 'action') {
    return {
      ...baseSnapshot,
      nightAction: {
        id: 'qa-action',
        kind: 'WOLF_VOTE',
        roleId: 'werewolf',
        roleName: 'Ma Sói',
        instructions: 'Chọn một người hoặc không chọn. Phiếu trắng là trung lập.',
        round: 'REVOTE',
        deadlineAt: Date.now() + 10_000,
        candidates: players.slice(1),
        currentTargetId: undefined,
        hasSelected: false,
      },
    }
  }
  if (surface === 'seer-select') {
    return {
      ...baseSnapshot,
      nightAction: {
        id: 'qa-seer-action',
        kind: 'SELECT_TARGET',
        roleId: 'seer',
        roleName: 'Tiên Tri',
        instructions: 'Chọn một người để kiểm tra.',
        mode: 'SEER_SELECT',
        candidates: players.slice(1),
        hasSelected: false,
      },
    }
  }
  if (surface === 'seer-result') {
    return {
      ...baseSnapshot,
      nightAction: {
        id: 'qa-seer-result',
        kind: 'SELECT_TARGET',
        roleId: 'seer',
        roleName: 'Tiên Tri',
        instructions: 'Ghi nhớ kết quả.',
        mode: 'SEER_RESULT',
        candidates: [],
        hasSelected: true,
        inspectedTarget: players[1],
        seerResult: 'NON_WOLF',
      },
    }
  }
  if (surface === 'protector-action') {
    return {
      ...baseSnapshot,
      nightAction: {
        id: 'qa-protector-action',
        kind: 'SELECT_TARGET',
        roleId: 'protector',
        roleName: 'Bảo Vệ',
        instructions: 'Chọn một người để bảo vệ đêm nay.',
        mode: 'PROTECTOR_SELECT',
        candidates: players.slice(0, 15),
        hasSelected: false,
      },
    }
  }
  if (surface === 'vote') {
    return {
      ...baseSnapshot,
      phase: 'DAY',
      dayVote: {
        status: 'OPEN',
        candidates: players.slice(1),
      },
    }
  }
  return baseSnapshot
}

const joinTransport = {
  validateRoomCode: async () => ({
    joinable: true as const,
    roomId: 'qa-room',
    roomCode: '381624',
  }),
} as unknown as RoomTransport

export function ZeroScrollHarness({ surface }: { surface: string }) {
  if (surface === 'landing') return <LandingView />
  if (surface === 'join' || surface === 'name-modal') {
    return <JoinRoomView transport={joinTransport} />
  }
  return (
    <PlayerView
      snapshot={snapshotFor(surface)}
      dispatch={noOpDispatch}
    />
  )
}
