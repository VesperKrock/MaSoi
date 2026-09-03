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
  nightTargetDraft: OfflineNightTargetDraft
  witchResurrectionTargetId: PlayerId | null
  witchPoisonTargetId: PlayerId | null
  dayDecision: OfflineDayDecision
}

export type OfflineNightTargetDraft =
  | { kind: 'UNSET' }
  | { kind: 'PLAYER'; playerId: PlayerId }
  | { kind: 'NOBODY' }

export type OfflineDayVerdict = 'SPARE' | 'EXECUTE'

export type OfflineDayDecision =
  | {
      stage: 'CANDIDATE_DRAFT'
      selection:
        | { kind: 'UNSET' }
        | { kind: 'PLAYER'; playerId: PlayerId }
        | { kind: 'NO_CANDIDATE' }
    }
  | {
      stage: 'LAST_WORDS'
      candidatePlayerId: PlayerId
      verdictDraft: OfflineDayVerdict | null
    }
  | {
      stage: 'VERDICT_CONFIRM'
      candidatePlayerId: PlayerId
      verdict: OfflineDayVerdict
    }

export type OfflineAuthorityCommand =
  | { type: 'BEGIN_OFFLINE_MATCH' }
  | { type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' }
  | { type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' }
  | { type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT'; targetId: PlayerId | null }
  | { type: 'CONFIRM_OFFLINE_NIGHT_TARGET' }
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
  | {
      type: 'SET_OFFLINE_DAY_CANDIDATE_DRAFT'
      playerId: PlayerId | null
    }
  | { type: 'SET_OFFLINE_DAY_NO_CANDIDATE_DRAFT' }
  | { type: 'LOCK_OFFLINE_DAY_CANDIDATE' }
  | { type: 'CONFIRM_OFFLINE_NO_CANDIDATE' }
  | { type: 'SET_OFFLINE_DAY_VERDICT_DRAFT'; verdict: OfflineDayVerdict }
  | { type: 'LOCK_OFFLINE_DAY_VERDICT' }
  | { type: 'RETURN_OFFLINE_DAY_VERDICT_DRAFT' }
  | { type: 'CONFIRM_OFFLINE_DAY_VERDICT' }
  | {
      type: 'SUBMIT_OFFLINE_HUNTER_REVENGE'
      targetId: PlayerId | null
    }
  | { type: 'START_OFFLINE_NEXT_NIGHT' }

export function createOfflineAuthorityInput(): OfflineAuthorityInput {
  return {
    cupidTargetIds: [],
    nightTargetDraft: { kind: 'UNSET' },
    witchResurrectionTargetId: null,
    witchPoisonTargetId: null,
    dayDecision: {
      stage: 'CANDIDATE_DRAFT',
      selection: { kind: 'UNSET' },
    },
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
  const knownRoles = new Map(
    state.roleAssignments.map((assignment) => [assignment.playerId, assignment.roleId]),
  )
  // Shared target/action code expects one server role per player. UNKNOWN
  // physical roles are projected as Villager until their ritual call confirms
  // the real assignment; Offline UI and persistence keep them undiscovered.
  const assignments = players.map((player) => ({
    playerId: player.id,
    roleId: knownRoles.get(player.id) ?? ('villager' as const),
  }))
  const allPhysicalRolesKnown = state.roleAssignments.length === state.seatCount
  return {
    schemaVersion: 2,
    roomId: 'OFFLINE-MODERATOR',
    roomCode: 'OFFLINE',
    revision: 0,
    createdAt: now,
    lifecycle: 'IN_GAME',
    phase: allPhysicalRolesKnown ? 'SETUP' : 'NIGHT',
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
      nightRoleIds: [...state.nightRitual.callPlan],
      revoteDurationMs: 10_000,
    },
    night: allPhysicalRolesKnown
      ? null
      : {
          number: 1,
          calls: state.nightRitual.callPlan.map((roleId) => ({
            roleId,
            status: 'NOT_CALLED' as const,
          })),
          activeRoleId: null,
          actionsByRole: {},
        },
    nightResolution: null,
    witchResources: null,
    witchCheckpoint: null,
    dayVote: null,
    dayVerdict: null,
    factionTransitions: createInitialFactionTransitionState(assignments),
    cupidLovers: createInitialCupidLoverState(assignments, now),
    matchResult: null,
    // Typed engine facts are the gameplay source for the private Offline Journal.
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
      if (state.phase !== 'PHYSICAL_DEAL' || state.authority) return state
      const initialRoom = createAuthorityRoom(state, now)
      const room = initialRoom.phase === 'SETUP'
        ? applyRoomCommand(initialRoom, { type: 'START_NIGHT' }, environment)
        : initialRoom
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

    if (command.type === 'SET_OFFLINE_NIGHT_TARGET_DRAFT') {
      const action = activeNightAction(room)
      if (!action || action.status !== 'OPEN') {
        throw new Error('Lượt gọi hiện tại không có hành động để chọn nháp.')
      }
      if (
        command.targetId !== null &&
        !action.eligibleTargetIds.includes(command.targetId)
      ) {
        throw new Error('Mục tiêu hành động không hợp lệ.')
      }
      if (
        command.targetId === null &&
        action.kind !== 'HUNTER_PRELOCK' &&
        action.kind !== 'SERIAL_KILLER_ATTACK'
      ) {
        throw new Error('Role này bắt buộc chọn một mục tiêu.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          nightTargetDraft: command.targetId === null
            ? { kind: 'NOBODY' }
            : { kind: 'PLAYER', playerId: command.targetId },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CONFIRM_OFFLINE_NIGHT_TARGET') {
      const draft = state.authorityInput.nightTargetDraft
      if (draft.kind === 'UNSET') {
        throw new Error('Hãy chọn mục tiêu trước khi xác nhận.')
      }
      return success(
        state,
        applyTargetAction(
          room,
          draft.kind === 'PLAYER' ? draft.playerId : null,
          environment,
        ),
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
        createOfflineAuthorityInput(),
      )
    }

    if (command.type === 'SET_OFFLINE_DAY_CANDIDATE_DRAFT') {
      if (
        room.phase !== 'DAY' ||
        room.dayVerdict ||
        state.authorityInput.dayDecision.stage !== 'CANDIDATE_DRAFT'
      ) {
        throw new Error('Không thể đổi người trăng trối ở bước hiện tại.')
      }
      if (
        command.playerId !== null &&
        !room.players.some((player) => player.id === command.playerId && player.alive)
      ) {
        throw new Error('Chỉ người còn sống mới được đưa lên trăng trối.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayDecision: {
            stage: 'CANDIDATE_DRAFT',
            selection: command.playerId
              ? { kind: 'PLAYER', playerId: command.playerId }
              : { kind: 'UNSET' },
          },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'SET_OFFLINE_DAY_NO_CANDIDATE_DRAFT') {
      if (
        room.phase !== 'DAY' ||
        room.dayVerdict ||
        state.authorityInput.dayDecision.stage !== 'CANDIDATE_DRAFT'
      ) {
        throw new Error('Không thể đổi người trăng trối ở bước hiện tại.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayDecision: {
            stage: 'CANDIDATE_DRAFT',
            selection: { kind: 'NO_CANDIDATE' },
          },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'LOCK_OFFLINE_DAY_CANDIDATE') {
      const decision = state.authorityInput.dayDecision
      if (
        room.phase !== 'DAY' ||
        room.dayVerdict ||
        decision.stage !== 'CANDIDATE_DRAFT' ||
        decision.selection.kind !== 'PLAYER'
      ) {
        throw new Error('Hãy chọn một người còn sống trước khi khóa trăng trối.')
      }
      return {
        ...state,
        offlineEvents: [
          ...state.offlineEvents,
          {
            id: `offline-day-candidate-${room.dayNumber}-${now}`,
            type: 'DAY_CANDIDATE_LOCKED',
            occurredAt: now,
            dayNumber: room.dayNumber,
            candidatePlayerId: decision.selection.playerId,
          },
        ],
        authorityInput: {
          ...state.authorityInput,
          dayDecision: {
            stage: 'LAST_WORDS',
            candidatePlayerId: decision.selection.playerId,
            verdictDraft: null,
          },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CONFIRM_OFFLINE_NO_CANDIDATE') {
      const decision = state.authorityInput.dayDecision
      if (
        room.phase !== 'DAY' ||
        room.dayVerdict ||
        decision.stage !== 'CANDIDATE_DRAFT' ||
        decision.selection.kind !== 'NO_CANDIDATE'
      ) {
        throw new Error('Hãy chọn “Không có ai” trước khi xác nhận.')
      }
      const next = success(
        state,
        applyRoomCommand(
          room,
          {
            type: 'RESOLVE_MODERATOR_DAY_VERDICT',
            candidatePlayerId: null,
            execute: false,
          },
          environment,
        ),
        now,
      )
      return {
        ...next,
        offlineEvents: [
          ...next.offlineEvents,
          {
            id: `offline-day-no-candidate-${room.dayNumber}-${now}`,
            type: 'DAY_NO_CANDIDATE',
            occurredAt: now,
            dayNumber: room.dayNumber,
          },
        ],
      }
    }

    if (command.type === 'SET_OFFLINE_DAY_VERDICT_DRAFT') {
      const decision = state.authorityInput.dayDecision
      if (room.dayVerdict || decision.stage !== 'LAST_WORDS') {
        throw new Error('Chưa khóa người trăng trối.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayDecision: { ...decision, verdictDraft: command.verdict },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'LOCK_OFFLINE_DAY_VERDICT') {
      const decision = state.authorityInput.dayDecision
      if (room.dayVerdict || decision.stage !== 'LAST_WORDS' || !decision.verdictDraft) {
        throw new Error('Hãy chọn THA hoặc XỬ trước khi tiếp tục.')
      }
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayDecision: {
            stage: 'VERDICT_CONFIRM',
            candidatePlayerId: decision.candidatePlayerId,
            verdict: decision.verdictDraft,
          },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'RETURN_OFFLINE_DAY_VERDICT_DRAFT') {
      const decision = state.authorityInput.dayDecision
      if (room.dayVerdict || decision.stage !== 'VERDICT_CONFIRM') return state
      return {
        ...state,
        authorityInput: {
          ...state.authorityInput,
          dayDecision: {
            stage: 'LAST_WORDS',
            candidatePlayerId: decision.candidatePlayerId,
            verdictDraft: decision.verdict,
          },
        },
        blockingError: null,
        updatedAt: now,
      }
    }

    if (command.type === 'CONFIRM_OFFLINE_DAY_VERDICT') {
      const decision = state.authorityInput.dayDecision
      if (room.dayVerdict || decision.stage !== 'VERDICT_CONFIRM') {
        throw new Error('Phán quyết chưa ở bước xác nhận cuối.')
      }
      const next = success(
        state,
        applyRoomCommand(
          room,
          {
            type: 'RESOLVE_MODERATOR_DAY_VERDICT',
            candidatePlayerId: decision.candidatePlayerId,
            execute: decision.verdict === 'EXECUTE',
          },
          environment,
        ),
        now,
      )
      if (decision.verdict === 'EXECUTE') return next
      return {
        ...next,
        offlineEvents: [
          ...next.offlineEvents,
          {
            id: `offline-day-spared-${room.dayNumber}-${now}`,
            type: 'DAY_CANDIDATE_SPARED',
            occurredAt: now,
            dayNumber: room.dayNumber,
            candidatePlayerId: decision.candidatePlayerId,
          },
        ],
      }
    }

    if (command.type === 'SUBMIT_OFFLINE_HUNTER_REVENGE') {
      const hunterPlayerId =
        room.dayVote?.hunterRevenge?.hunterPlayerId ??
        room.dayVerdict?.hunterRevenge?.hunterPlayerId
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
