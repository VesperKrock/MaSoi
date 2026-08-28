import {
  applyRoomCommand,
  defaultGameEnvironment,
  type GameEnvironment,
} from '../game/room-engine'
import type {
  NightAction,
  PlayerId,
  RoomCommand,
  RoomState,
} from '../game/types'
import { createInitialFactionTransitionState } from '../gameplay/faction-transitions'
import { createInitialCupidLoverState } from '../gameplay/lovers'
import type { OfflineSessionState } from './offline-session'

export interface OfflineAuthorityInput {
  cupidTargetIds: PlayerId[]
  witchResurrectionTargetId: PlayerId | null
  witchPoisonTargetId: PlayerId | null
  dayVoterId: PlayerId | null
}

export type OfflineAuthorityCommand =
  | { type: 'BEGIN_OFFLINE_MATCH' }
  | { type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' }
  | { type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' }
  | { type: 'SUBMIT_OFFLINE_NIGHT_TARGET'; targetId: PlayerId | null }
  | { type: 'TOGGLE_OFFLINE_CUPID_TARGET'; playerId: PlayerId }
  | { type: 'CONFIRM_OFFLINE_CUPID_PAIR' }
  | { type: 'ACKNOWLEDGE_OFFLINE_LOVERS' }
  | { type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' }
  | {
      type: 'SET_OFFLINE_WITCH_RESURRECTION_TARGET'
      playerId: PlayerId | null
    }
  | { type: 'SET_OFFLINE_WITCH_POISON_TARGET'; playerId: PlayerId | null }
  | { type: 'CONFIRM_OFFLINE_WITCH_DECISION' }
  | { type: 'FINALIZE_OFFLINE_NIGHT' }
  | { type: 'START_OFFLINE_DAY' }
  | { type: 'OPEN_OFFLINE_DAY_VOTE' }
  | { type: 'SET_OFFLINE_DAY_VOTER'; playerId: PlayerId }
  | {
      type: 'CAST_OFFLINE_DAY_VOTE'
      voterId: PlayerId
      targetId: PlayerId | null
    }
  | { type: 'CLOSE_OFFLINE_DAY_VOTE' }
  | {
      type: 'SUBMIT_OFFLINE_HUNTER_REVENGE'
      targetId: PlayerId | null
    }
  | { type: 'START_OFFLINE_NEXT_NIGHT' }

export function createOfflineAuthorityInput(): OfflineAuthorityInput {
  return {
    cupidTargetIds: [],
    witchResurrectionTargetId: null,
    witchPoisonTargetId: null,
    dayVoterId: null,
  }
}

function createEnvironment(
  state: OfflineSessionState,
  now: number,
): GameEnvironment {
  let sequence = 0
  const revision = state.authority?.revision ?? 0
  return {
    now: () => now,
    nextId: () => `offline-${now}-${revision}-${++sequence}`,
    random: defaultGameEnvironment.random,
  }
}

function createAuthorityRoom(
  state: OfflineSessionState,
  now: number,
): RoomState {
  const players = state.playerNames.map((alias, index) => ({
    id: `offline-player-${index + 1}`,
    seat: index + 1,
    alias,
    alive: true,
  }))
  const assignments = structuredClone(state.roleAssignments)
  return {
    schemaVersion: 2,
    roomId: 'OFFLINE-MODERATOR',
    roomCode: 'OFFLINE',
    revision: 0,
    createdAt: now,
    lifecycle: 'IN_GAME',
    phase: 'SETUP',
    dayNumber: 1,
    players,
    roleAssignments: assignments,
    roleRevealConfirmedPlayerIds: players.map((player) => player.id),
    config: {
      seatCount: state.seatCount,
      roleComposition: structuredClone(state.roleComposition),
      wolfPolicy: 'RANDOM_ON_TIE',
      // Offline deliberately calls every configured non-Villager. Passive
      // roles have shared NONE definitions and therefore create no action.
      nightRoleIds: [...state.nightOne.callPlan],
      revoteDurationMs: 10_000,
    },
    night: null,
    nightResolution: null,
    witchResources: null,
    witchCheckpoint: null,
    dayVote: null,
    factionTransitions: createInitialFactionTransitionState(assignments),
    cupidLovers: createInitialCupidLoverState(assignments, now),
    matchResult: null,
    // These engine facts remain internal authority state. Offline Journal is
    // intentionally not exposed as a product surface in O2.
    journal: [],
  }
}

function applyCommands(
  room: RoomState,
  commands: readonly RoomCommand[],
  environment: GameEnvironment,
): RoomState {
  return commands.reduce(
    (current, command) => applyRoomCommand(current, command, environment),
    room,
  )
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Không thể áp dụng thao tác Offline.'
  const translated: Record<string, string> = {
    WITCH_HAS_NO_LIVING_ACTOR: 'Phù Thủy đã chết nên không thể dùng bình.',
    WITCH_RESURRECTION_UNAVAILABLE: 'Bình cứu không còn khả dụng.',
    WITCH_ATTACKED_CANNOT_RESURRECT:
      'Phù Thủy bị tấn công trong Đêm này nên không thể dùng bình cứu.',
    WITCH_RESURRECTION_TARGET_NOT_CURRENT_CANDIDATE:
      'Mục tiêu cứu không phải ứng viên tử vong hiện tại.',
    WITCH_POISON_UNAVAILABLE: 'Bình độc không còn khả dụng.',
    WITCH_POISON_FORBIDDEN_NIGHT_ONE: 'Không được dùng bình độc trong Đêm 1.',
    WITCH_POISON_SELF_TARGET: 'Phù Thủy không thể tự dùng bình độc.',
    WITCH_POISON_TARGET_NOT_LIVING: 'Mục tiêu bình độc phải còn sống.',
  }
  return translated[error.message] ?? error.message
}

function success(
  state: OfflineSessionState,
  authority: RoomState,
  now: number,
  authorityInput: OfflineAuthorityInput = state.authorityInput,
): OfflineSessionState {
  return {
    ...state,
    phase: authority.lifecycle === 'FINISHED' ? 'FINISHED' : 'MATCH',
    authority,
    authorityInput,
    blockingError: null,
    updatedAt: now,
  }
}

function requireAuthority(state: OfflineSessionState): RoomState {
  if (!state.authority) throw new Error('Ván Offline chưa được khởi tạo.')
  return state.authority
}

function activeNightAction(room: RoomState): NightAction | undefined {
  const roleId = room.night?.activeRoleId
  return roleId ? room.night?.actionsByRole[roleId] : undefined
}

function applyTargetAction(
  room: RoomState,
  targetId: PlayerId | null,
  environment: GameEnvironment,
): RoomState {
  const action = activeNightAction(room)
  if (!action || action.status !== 'OPEN') {
    throw new Error('Lượt gọi hiện tại không có hành động hợp lệ.')
  }
  const actorId = action.eligibleActorIds[0]
  if (!actorId) throw new Error('Role hiện tại không có người còn sống để hành động.')

  if (action.kind === 'WOLF_VOTE') {
    if (targetId === null) throw new Error('Ma Sói bắt buộc chọn một mục tiêu.')
    if (!action.eligibleTargetIds.includes(targetId)) {
      throw new Error('Mục tiêu Ma Sói không hợp lệ.')
    }
    const commands: RoomCommand[] = action.eligibleActorIds.flatMap(
      (wolfActorId) => [
        { type: 'CAST_WOLF_VOTE', playerId: wolfActorId, targetId },
        { type: 'CONFIRM_NIGHT_ACTION', playerId: wolfActorId },
      ],
    )
    commands.push({ type: 'RESOLVE_WOLF_VOTE' })
    return applyCommands(room, commands, environment)
  }

  if (action.kind === 'SELECT_TARGET') {
    if (targetId === null) throw new Error('Role này bắt buộc chọn một mục tiêu.')
    return applyRoomCommand(
      room,
      action.roleId === 'seer'
        ? { type: 'SUBMIT_SEER_INSPECTION', playerId: actorId, targetId }
        : action.roleId === 'protector'
          ? { type: 'SUBMIT_PROTECTOR_TARGET', playerId: actorId, targetId }
          : { type: 'SUBMIT_TARGET_ACTION', playerId: actorId, targetId },
      environment,
    )
  }

  if (action.kind === 'HUNTER_PRELOCK') {
    return applyCommands(
      room,
      [
        { type: 'CAST_HUNTER_PRELOCK', playerId: actorId, targetId },
        { type: 'CONFIRM_HUNTER_PRELOCK', playerId: actorId },
      ],
      environment,
    )
  }

  if (action.kind === 'SERIAL_KILLER_ATTACK') {
    return applyCommands(
      room,
      [
        { type: 'CAST_SERIAL_KILLER_ATTACK', playerId: actorId, targetId },
        { type: 'CONFIRM_SERIAL_KILLER_ATTACK', playerId: actorId },
      ],
      environment,
    )
  }

  throw new Error('Hành động này dùng bộ điều khiển riêng.')
}

export function reduceOfflineAuthority(
  state: OfflineSessionState,
  command: OfflineAuthorityCommand,
  now: number,
): OfflineSessionState {
  const environment = createEnvironment(state, now)
  try {
    if (command.type === 'BEGIN_OFFLINE_MATCH') {
      if (state.phase !== 'NIGHT_1_READY' || state.authority) return state
      if (state.roleAssignments.length !== state.seatCount) {
        throw new Error('Phải xác định đủ vai trước khi bắt đầu ván.')
      }
      const room = applyRoomCommand(
        createAuthorityRoom(state, now),
        { type: 'START_NIGHT' },
        environment,
      )
      return success(state, room, now, createOfflineAuthorityInput())
    }

    const room = requireAuthority(state)

    if (command.type === 'CALL_NEXT_OFFLINE_NIGHT_ROLE') {
      if (room.phase !== 'NIGHT' || !room.night) return state
      if (room.night.activeRoleId) {
        throw new Error('Hãy hoàn tất lượt gọi hiện tại trước.')
      }
      const nextCall = room.night.calls.find(
        (call) => call.status === 'NOT_CALLED',
      )
      if (!nextCall) throw new Error('Đã gọi đủ mọi role trong Đêm này.')
      let nextRoom = room
      if (
        nextCall.roleId === 'witch' &&
        nextRoom.nightResolution?.nightNumber !== nextRoom.dayNumber
      ) {
        nextRoom = applyRoomCommand(
          nextRoom,
          { type: 'RESOLVE_NIGHT_EFFECTS' },
          environment,
        )
      }
      nextRoom = applyRoomCommand(
        nextRoom,
        { type: 'CALL_NIGHT_ROLE', roleId: nextCall.roleId },
        environment,
      )
      return success(state, nextRoom, now, createOfflineAuthorityInput())
    }

    if (command.type === 'COMPLETE_ACTIVE_OFFLINE_RITUAL') {
      const roleId = room.night?.activeRoleId
      if (!roleId) throw new Error('Không có lượt gọi đang mở.')
      const action = room.night?.actionsByRole[roleId]
      if (action?.status === 'OPEN') {
        throw new Error('Role còn sống phải hoàn tất hành động hợp lệ.')
      }
      return success(
        state,
        applyRoomCommand(
          room,
          { type: 'COMPLETE_NIGHT_CALL', roleId },
          environment,
        ),
        now,
      )
    }

    if (command.type === 'SUBMIT_OFFLINE_NIGHT_TARGET') {
      return success(
        state,
        applyTargetAction(room, command.targetId, environment),
        now,
        createOfflineAuthorityInput(),
      )
    }

    if (command.type === 'TOGGLE_OFFLINE_CUPID_TARGET') {
      const action = activeNightAction(room)
      if (
        action?.kind !== 'CUPID_PAIRING' ||
        !action.eligibleTargetIds.includes(command.playerId)
      ) {
        throw new Error('Mục tiêu Người Yêu không hợp lệ.')
      }
      const current = state.authorityInput.cupidTargetIds
      const selected = current.includes(command.playerId)
      const cupidTargetIds = selected
        ? current.filter((playerId) => playerId !== command.playerId)
        : current.length < 2
          ? [...current, command.playerId]
          : current
      return {
        ...state,
        authorityInput: { ...state.authorityInput, cupidTargetIds },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CONFIRM_OFFLINE_CUPID_PAIR') {
      const action = activeNightAction(room)
      const actorId = action?.eligibleActorIds[0]
      if (action?.kind !== 'CUPID_PAIRING' || !actorId) {
        throw new Error('Không có lượt ghép đôi đang mở.')
      }
      if (state.authorityInput.cupidTargetIds.length !== 2) {
        throw new Error('Cupid phải chọn đúng hai Người Yêu.')
      }
      const targetIds = state.authorityInput.cupidTargetIds as [
        PlayerId,
        PlayerId,
      ]
      return success(
        state,
        applyRoomCommand(
          room,
          { type: 'SUBMIT_CUPID_PAIRING', playerId: actorId, targetIds },
          environment,
        ),
        now,
        createOfflineAuthorityInput(),
      )
    }

    if (command.type === 'ACKNOWLEDGE_OFFLINE_LOVERS') {
      const loverIds = room.cupidLovers?.couple?.loverPlayerIds
      if (!loverIds) throw new Error('Chưa có cặp Người Yêu để xác nhận.')
      return success(
        state,
        applyCommands(
          room,
          loverIds.map((playerId) => ({
            type: 'ACKNOWLEDGE_LOVER_REVEAL' as const,
            playerId,
          })),
          environment,
        ),
        now,
      )
    }

    if (command.type === 'ACKNOWLEDGE_OFFLINE_SEER_RESULT') {
      const action = activeNightAction(room)
      const actorId = action?.eligibleActorIds[0]
      if (action?.roleId !== 'seer' || !action.seer || !actorId) {
        throw new Error('Không có kết quả Tiên Tri để xác nhận.')
      }
      return success(
        state,
        applyRoomCommand(
          room,
          { type: 'ACKNOWLEDGE_SEER_RESULT', playerId: actorId },
          environment,
        ),
        now,
      )
    }

    if (command.type === 'SET_OFFLINE_WITCH_RESURRECTION_TARGET') {
      const action = activeNightAction(room)
      if (action?.kind !== 'WITCH_DECISION' || !action.witch) {
        throw new Error('Không có checkpoint Phù Thủy đang mở.')
      }
      if (
        command.playerId !== null &&
        !action.witch.resurrectionCandidateIds.includes(command.playerId)
      ) {
        throw new Error('Mục tiêu cứu không hợp lệ.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          witchResurrectionTargetId: command.playerId,
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'SET_OFFLINE_WITCH_POISON_TARGET') {
      const action = activeNightAction(room)
      if (action?.kind !== 'WITCH_DECISION' || !action.witch) {
        throw new Error('Không có checkpoint Phù Thủy đang mở.')
      }
      if (
        command.playerId !== null &&
        !action.witch.poisonCandidateIds.includes(command.playerId)
      ) {
        throw new Error('Mục tiêu bình độc không hợp lệ.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          witchPoisonTargetId: command.playerId,
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CONFIRM_OFFLINE_WITCH_DECISION') {
      const action = activeNightAction(room)
      const actorId = action?.eligibleActorIds[0]
      if (action?.kind !== 'WITCH_DECISION' || !actorId) {
        throw new Error('Không có quyết định Phù Thủy đang mở.')
      }
      return success(
        state,
        applyRoomCommand(
          room,
          {
            type: 'SUBMIT_WITCH_DECISION',
            playerId: actorId,
            resurrectionTargetId:
              state.authorityInput.witchResurrectionTargetId,
            poisonTargetId: state.authorityInput.witchPoisonTargetId,
          },
          environment,
        ),
        now,
        createOfflineAuthorityInput(),
      )
    }

    if (command.type === 'FINALIZE_OFFLINE_NIGHT') {
      if (
        room.phase !== 'NIGHT' ||
        room.night?.calls.some((call) => call.status !== 'COMPLETED')
      ) {
        throw new Error('Phải hoàn tất mọi lượt gọi trước khi chốt Đêm.')
      }
      let nextRoom = room
      if (nextRoom.nightResolution?.nightNumber !== nextRoom.dayNumber) {
        nextRoom = applyRoomCommand(
          nextRoom,
          { type: 'RESOLVE_NIGHT_EFFECTS' },
          environment,
        )
      }
      nextRoom = applyRoomCommand(
        nextRoom,
        { type: 'FINALIZE_NIGHT_CHECKPOINT' },
        environment,
      )
      return success(state, nextRoom, now)
    }

    if (command.type === 'START_OFFLINE_DAY') {
      return success(
        state,
        applyRoomCommand(room, { type: 'START_DAY' }, environment),
        now,
      )
    }

    if (command.type === 'OPEN_OFFLINE_DAY_VOTE') {
      return success(
        state,
        applyRoomCommand(room, { type: 'OPEN_DAY_VOTE' }, environment),
        now,
        createOfflineAuthorityInput(),
      )
    }

    if (command.type === 'SET_OFFLINE_DAY_VOTER') {
      if (
        room.phase !== 'DAY' ||
        room.dayVote?.status !== 'OPEN' ||
        !room.players.some(
          (player) => player.id === command.playerId && player.alive,
        )
      ) {
        throw new Error('Chỉ chọn người còn sống để ghi phiếu.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayVoterId: command.playerId,
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CAST_OFFLINE_DAY_VOTE') {
      return success(
        state,
        applyRoomCommand(
          room,
          {
            type: 'CAST_DAY_VOTE',
            playerId: command.voterId,
            targetId: command.targetId,
          },
          environment,
        ),
        now,
        { ...state.authorityInput, dayVoterId: null },
      )
    }

    if (command.type === 'CLOSE_OFFLINE_DAY_VOTE') {
      const livingIds = room.players
        .filter((player) => player.alive)
        .map((player) => player.id)
      if (
        !room.dayVote ||
        livingIds.some(
          (playerId) =>
            !Object.prototype.hasOwnProperty.call(room.dayVote?.votes, playerId),
        )
      ) {
        throw new Error('Phải ghi nhận phiếu hoặc bỏ phiếu trắng cho mọi người còn sống.')
      }
      return success(
        state,
        applyRoomCommand(room, { type: 'CLOSE_DAY_VOTE' }, environment),
        now,
      )
    }

    if (command.type === 'SUBMIT_OFFLINE_HUNTER_REVENGE') {
      const hunterPlayerId = room.dayVote?.hunterRevenge?.hunterPlayerId
      if (!hunterPlayerId) throw new Error('Không có lượt trả thù của Thợ Săn.')
      return success(
        state,
        applyRoomCommand(
          room,
          {
            type: 'SUBMIT_HUNTER_REVENGE',
            playerId: hunterPlayerId,
            targetId: command.targetId,
          },
          environment,
        ),
        now,
      )
    }

    if (command.type === 'START_OFFLINE_NEXT_NIGHT') {
      return success(
        state,
        applyRoomCommand(room, { type: 'START_NEXT_NIGHT' }, environment),
        now,
        createOfflineAuthorityInput(),
      )
    }

    return state
  } catch (error) {
    return {
      ...state,
      blockingError: errorMessage(error),
      updatedAt: now,
    }
  }
}
