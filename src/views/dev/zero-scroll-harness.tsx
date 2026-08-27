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

const finalRoleIds = [
  'werewolf',
  'fool',
  'serial-killer',
  'cupid',
  'half-wolf',
  'traitor',
  'witch',
  'protector',
  'seer',
  'hunter',
  'mayor',
  'villager',
  'villager',
  'villager',
  'werewolf',
  'villager',
] as const

function finishedSnapshot(playerCount: 7 | 16): PlayerRoomSnapshot {
  const finalPlayers = players.slice(0, playerCount).map((player, index) => ({
    ...player,
    alias: index === 0 ? 'Nguyễn Hoàng Bảo Châu' : `Người chơi ${index + 1}`,
    alive: index % 3 === 0,
  }))
  return {
    ...baseSnapshot,
    lifecycle: 'FINISHED',
    phase: 'ENDED',
    seatCount: playerCount,
    self: finalPlayers[0],
    players: finalPlayers,
    nightAction: undefined,
    dayVote: undefined,
    loverRelationship: undefined,
    matchResult: { outcome: 'FOOL' },
    endMatch: {
      outcome: 'FOOL',
      subjects: [finalPlayers[1]],
      roster: finalPlayers.map((player, index) => ({
        player,
        roleId: finalRoleIds[index],
        runtimeNote:
          finalRoleIds[index] === 'half-wolf'
            ? 'HALF_WOLF_TRANSFORMED'
            : finalRoleIds[index] === 'traitor'
              ? 'TRAITOR_CONVERTED_VILLAGE'
              : undefined,
        loverPartnerPlayerId:
          index === 6
            ? finalPlayers[7]?.id
            : index === 7
              ? finalPlayers[6]?.id
              : undefined,
      })),
      couple:
        playerCount === 16
          ? {
              cupidPlayerId: finalPlayers[3].id,
              loverPlayerIds: [finalPlayers[6].id, finalPlayers[7].id],
            }
          : undefined,
    },
  }
}

function snapshotFor(surface: string): PlayerRoomSnapshot {
  if (surface === 'end-match-result') return finishedSnapshot(7)
  if (surface === 'end-match-roster') return finishedSnapshot(16)
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
  if (surface === 'hunter-action') {
    return {
      ...baseSnapshot,
      roleIdentity: {
        roleId: 'hunter',
        displayName: 'Thợ Săn',
        factionMeaning: 'Dân Làng',
        rulesText: 'Khóa trước một mục tiêu; chỉ bắn nếu chết cuối Đêm.',
        cardAsset: cardAssetUrl('Thợ Săn.jpg'),
      },
      nightAction: {
        id: 'qa-hunter-action',
        kind: 'HUNTER_PRELOCK',
        roleId: 'hunter',
        roleName: 'Thợ Săn',
        instructions: 'Khóa trước một người hoặc Không ai.',
        mode: 'HUNTER_PRELOCK',
        candidates: players.slice(1),
        hasSelected: false,
      },
    }
  }
  if (surface === 'serial-killer-action') {
    return {
      ...baseSnapshot,
      roleIdentity: {
        roleId: 'serial-killer',
        displayName: 'Sát Nhân Hàng Loạt',
        factionMeaning: 'Độc Lập',
        rulesText: 'Mỗi đêm chọn một người khác hoặc Không ai.',
        cardAsset: cardAssetUrl('Sát Nhân Hàng Loạt.jpg'),
      },
      nightAction: {
        id: 'qa-serial-killer-action',
        kind: 'SERIAL_KILLER_ATTACK',
        roleId: 'serial-killer',
        roleName: 'Sát Nhân Hàng Loạt',
        instructions: 'Chọn một người còn sống khác hoặc Không ai.',
        mode: 'SERIAL_KILLER_ATTACK',
        candidates: players.slice(1),
        hasSelected: false,
      },
    }
  }
  if (surface === 'cupid-action') {
    return {
      ...baseSnapshot,
      roleIdentity: {
        roleId: 'cupid',
        displayName: 'Thần Tình Yêu',
        factionMeaning: 'Dân Làng',
        rulesText: 'Đêm đầu tiên, ghép đôi hai người chơi khác nhau.',
        cardAsset: cardAssetUrl('Thần Tình Yêu.jpg'),
      },
      nightAction: {
        id: 'qa-cupid-action',
        kind: 'CUPID_PAIRING',
        roleId: 'cupid',
        roleName: 'Thần Tình Yêu',
        instructions: 'Chọn đúng hai người chơi để ghép đôi.',
        mode: 'CUPID_PAIRING',
        candidates: players.slice(1),
        selectedTargetIds: [],
        hasSelected: false,
      },
    }
  }
  if (surface === 'lover-reveal') {
    return {
      ...baseSnapshot,
      loverRelationship: {
        partner: players[1],
        revealPending: true,
      },
    }
  }
  if (surface === 'day-dead' || surface === 'day-living') {
    return {
      ...baseSnapshot,
      phase: 'DAY',
      self:
        surface === 'day-dead'
          ? { ...players[0], alive: false }
          : players[0],
      players:
        surface === 'day-dead'
          ? [{ ...players[0], alive: false }, ...players.slice(1)]
          : players,
    }
  }
  if (surface === 'witch-action' || surface === 'witch-poison-action') {
    const resurrectionAvailable = surface === 'witch-action'
    return {
      ...baseSnapshot,
      roleIdentity: {
        roleId: 'witch',
        displayName: 'Phù Thủy',
        factionMeaning: 'Dân Làng',
        rulesText: 'Một bình cứu và một bình độc cho cả ván.',
        cardAsset: cardAssetUrl('Phù Thủy.jpg'),
      },
      nightAction: {
        id: `qa-${surface}`,
        kind: 'WITCH_DECISION',
        roleId: 'witch',
        roleName: 'Phù Thủy',
        instructions: 'Chọn quyết định cuối Đêm.',
        mode: 'WITCH_DECISION',
        candidates: [],
        resurrectionCandidates: resurrectionAvailable ? players.slice(1) : [],
        poisonCandidates: players.slice(1),
        resurrectionAvailable,
        poisonAvailable: true,
        witchAttackedThisNight: !resurrectionAvailable,
        hasSelected: false,
      },
    }
  }
  if (surface === 'vote' || surface === 'day-vote') {
    return {
      ...baseSnapshot,
      phase: 'DAY',
      dayVote: {
        status: 'OPEN',
        candidates: players.slice(1),
        openedAt: Date.now(),
        deadlineAt: Date.now() + 30_000,
        totals: Object.fromEntries(players.slice(1).map((player, index) => [
          player.id,
          index % 3,
        ])),
      },
    }
  }
  if (surface === 'hunter-revenge') {
    return {
      ...baseSnapshot,
      phase: 'DAY',
      self: { ...players[0], alive: false },
      players: [{ ...players[0], alive: false }, ...players.slice(1)],
      roleIdentity: {
        roleId: 'hunter',
        displayName: 'Thợ Săn',
        factionMeaning: 'Dân Làng',
        rulesText: 'Nếu bị treo cổ, chọn một người đi cùng hoặc Không ai.',
        cardAsset: cardAssetUrl('Thợ Săn.jpg'),
      },
      dayVote: {
        status: 'CLOSED',
        candidates: [],
        openedAt: Date.now() - 31_000,
        deadlineAt: Date.now() - 1_000,
        totals: { [players[0].id]: 5 },
        result: {
          kind: 'UNIQUE',
          hangedPlayer: { ...players[0], alive: false },
          hunterRevealed: true,
          hunterRevengeStatus: 'PENDING',
        },
        hunterRevengeAction: {
          candidates: players.slice(1),
        },
      },
    }
  }
  if (surface === 'hunter-pending') {
    return {
      ...baseSnapshot,
      phase: 'DAY',
      dayVote: {
        status: 'CLOSED',
        candidates: [],
        openedAt: Date.now() - 31_000,
        deadlineAt: Date.now() - 1_000,
        totals: { [players[1].id]: 5 },
        result: {
          kind: 'UNIQUE',
          hangedPlayer: { ...players[1], alive: false },
          hunterRevealed: true,
          hunterRevengeStatus: 'PENDING',
        },
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
      homeHref="/?transport=local"
    />
  )
}
