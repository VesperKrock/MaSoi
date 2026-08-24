import { createJournalEvent } from '../journal/journal'
import { getNightRoleIds, roleDefinitions } from '../roles/role-definitions'
import {
  getEligibleDayTargets,
  getEligibleRoleTargets,
  getLivingHolders,
} from '../actions/target-rules'
import { resolveDayVote } from '../voting/day-vote'
import { systemRandom, type RandomSource } from '../voting/random'
import {
  analyzeWolfVotes,
  resolveInitialWolfVote,
  resolveWolfRevote,
} from '../voting/wolf-resolver'
import {
  expandRoleDeck,
  normalizePlayerName,
  validatePlayerName,
  validateRoomSetup,
  type RoomSetupInput,
} from './room-setup'
import type {
  FinalTargetResult,
  JournalEvent,
  JournalEventType,
  NightAction,
  NightCall,
  Player,
  PlayerId,
  RoleAssignment,
  RoleId,
  RoomCommand,
  RoomState,
  WolfPolicy,
} from './types'

export interface GameEnvironment {
  now: () => number
  nextId: () => string
  random: RandomSource
}

const aliases = [
  'Ếch',
  'Cáo',
  'Gấu',
  'Thỏ',
  'Mèo',
  'Rái Cá',
  'Gấu Mèo',
  'Cánh Cụt',
  'Hươu',
  'Sóc',
  'Cú',
  'Nhím',
  'Hải Ly',
  'Chồn',
  'Voi',
  'Koala',
]

export const defaultGameEnvironment: GameEnvironment = {
  now: () => Date.now(),
  nextId: () => crypto.randomUUID(),
  random: systemRandom,
}

function fail(message: string): never {
  throw new Error(message)
}

function appendEvent(
  state: RoomState,
  environment: GameEnvironment,
  type: JournalEventType,
  details: Partial<Omit<JournalEvent, 'id' | 'timestamp' | 'type'>> = {},
): void {
  state.journal.push(
    createJournalEvent(environment, {
      type,
      dayNumber: state.dayNumber,
      phase: state.phase,
      ...details,
    }),
  )
}

function createPlayers(playerCount: number): Player[] {
  return Array.from({ length: playerCount }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
    alias: aliases[index],
    alive: true,
  }))
}

function createAssignments(players: readonly Player[]): RoleAssignment[] {
  const wolfCount = players.length >= 9 ? 3 : players.length >= 6 ? 2 : 1

  return players.map((player, index) => ({
    playerId: player.id,
    roleId:
      index < wolfCount
        ? ('werewolf' as const)
        : index === wolfCount
          ? ('seer' as const)
          : ('villager' as const),
  }))
}

const roomCodeDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

export function generateSixDigitRoomCode(
  random: RandomSource,
  reservedCodes: ReadonlySet<string> = new Set(),
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from({ length: 6 }, () =>
      random.pick(roomCodeDigits),
    ).join('')
    if (!reservedCodes.has(code)) return code
  }
  return fail('Không thể tạo mã phòng local không trùng sau 100 lần thử.')
}

export function createProductRoom(
  setup: RoomSetupInput,
  roomCode: string,
  environment: GameEnvironment = defaultGameEnvironment,
): RoomState {
  const validation = validateRoomSetup(setup)
  if (!validation.valid) fail(validation.errors.join(' '))
  if (!/^\d{6}$/.test(roomCode)) {
    fail('Mã phòng phải chứa đúng 6 chữ số.')
  }

  const selectedRoleIds = expandRoleDeck(setup.roleComposition)
  const state: RoomState = {
    schemaVersion: 2,
    roomId: environment.nextId(),
    roomCode,
    revision: 0,
    createdAt: environment.now(),
    lifecycle: 'LOBBY',
    phase: 'SETUP',
    dayNumber: 1,
    players: [],
    roleAssignments: [],
    roleRevealConfirmedPlayerIds: [],
    config: {
      seatCount: setup.seatCount,
      roleComposition: structuredClone(setup.roleComposition),
      wolfPolicy: setup.wolfPolicy,
      nightRoleIds: getNightRoleIds(selectedRoleIds),
      revoteDurationMs: 10_000,
    },
    night: null,
    dayVote: null,
    journal: [],
  }
  appendEvent(state, environment, 'ROOM_CREATED', {
    metadata: {
      roomCode,
      seatCount: setup.seatCount,
      roleComposition: setup.roleComposition,
      wolfPolicy: setup.wolfPolicy,
    },
  })
  return state
}

export function createDemoRoom(
  playerCount = 6,
  wolfPolicy: WolfPolicy = 'RANDOM_ON_TIE',
  environment: GameEnvironment = defaultGameEnvironment,
): RoomState {
  if (playerCount < 3 || playerCount > aliases.length) {
    fail(`Số người chơi phải từ 3 đến ${aliases.length}.`)
  }

  const players = createPlayers(playerCount)
  const roleAssignments = createAssignments(players)
  const roleIds = roleAssignments.map((assignment) => assignment.roleId)
  const roleComposition = roleIds.reduce<Partial<Record<RoleId, number>>>(
    (composition, roleId) => {
      composition[roleId] = (composition[roleId] ?? 0) + 1
      return composition
    },
    {},
  )
  const state: RoomState = {
    schemaVersion: 2,
    roomId: `DEV-${environment.nextId().slice(0, 6).toUpperCase()}`,
    roomCode: '000000',
    revision: 0,
    createdAt: environment.now(),
    lifecycle: 'IN_GAME',
    phase: 'SETUP',
    dayNumber: 1,
    players,
    roleAssignments,
    roleRevealConfirmedPlayerIds: players.map((player) => player.id),
    config: {
      seatCount: playerCount,
      roleComposition,
      wolfPolicy,
      nightRoleIds: getNightRoleIds(roleIds),
      revoteDurationMs: 10_000,
    },
    night: null,
    dayVote: null,
    journal: [],
  }

  appendEvent(state, environment, 'ROOM_CREATED', {
    metadata: { playerCount, wolfPolicy, developmentRoom: true },
  })
  for (const assignment of roleAssignments) {
    appendEvent(state, environment, 'ROLE_ASSIGNED', {
      actorPlayerId: assignment.playerId,
      actorRoleId: assignment.roleId,
    })
  }

  return state
}

function createNightCalls(state: RoomState): NightCall[] {
  // Intentionally uses configured roles, never living holders. This is the
  // secrecy boundary that keeps dead roles in every nightly ritual.
  return state.config.nightRoleIds.map((roleId) => ({
    roleId,
    status: 'NOT_CALLED',
  }))
}

function joinPlayer(
  state: RoomState,
  playerId: PlayerId,
  name: string,
  environment: GameEnvironment,
): void {
  if (state.lifecycle !== 'LOBBY') {
    fail('Phòng đã khóa hoặc ván chơi đã bắt đầu.')
  }
  if (state.players.length >= state.config.seatCount) {
    fail('Phòng đã đủ người.')
  }
  if (state.players.some((player) => player.id === playerId)) {
    fail('Thiết bị này đã có ghế trong phòng.')
  }
  const nameError = validatePlayerName(state, name)
  if (nameError) fail(nameError)

  const player: Player = {
    id: playerId,
    seat: state.players.length + 1,
    alias: normalizePlayerName(name),
    alive: true,
  }
  state.players.push(player)
  appendEvent(state, environment, 'PLAYER_JOINED', {
    actorPlayerId: player.id,
    metadata: { seat: player.seat, displayName: player.alias },
  })
}

function shuffleRoleDeck(
  roleIds: readonly RoleId[],
  random: RandomSource,
): RoleId[] {
  const remaining = [...roleIds]
  const shuffled: RoleId[] = []
  while (remaining.length > 0) {
    const selected = random.pick(remaining)
    const index = remaining.indexOf(selected)
    shuffled.push(selected)
    remaining.splice(index, 1)
  }
  return shuffled
}

function lockAndAssignRoles(
  state: RoomState,
  environment: GameEnvironment,
): void {
  if (state.lifecycle !== 'LOBBY') {
    fail('Chỉ được khóa một phòng đang ở Lobby.')
  }
  const setupValidation = validateRoomSetup({
    seatCount: state.config.seatCount,
    roleComposition: state.config.roleComposition,
    wolfPolicy: state.config.wolfPolicy,
  })
  if (!setupValidation.valid) fail(setupValidation.errors.join(' '))
  if (state.players.length !== state.config.seatCount) {
    fail(
      `Cần đủ ${state.config.seatCount} người trước khi khóa phòng và chia vai.`,
    )
  }
  if (state.roleAssignments.length > 0) {
    fail('Vai trò đã được chia; không thể chia lại.')
  }

  const roleDeck = shuffleRoleDeck(
    expandRoleDeck(state.config.roleComposition),
    environment.random,
  )
  state.roleAssignments = state.players.map((player, index) => ({
    playerId: player.id,
    roleId: roleDeck[index],
  }))
  state.roleRevealConfirmedPlayerIds = []
  state.lifecycle = 'ROLE_REVEAL'
  appendEvent(state, environment, 'ROOM_LOCKED', {
    metadata: { assignedCount: state.roleAssignments.length },
  })
  for (const assignment of state.roleAssignments) {
    appendEvent(state, environment, 'ROLE_ASSIGNED', {
      actorPlayerId: assignment.playerId,
      actorRoleId: assignment.roleId,
    })
  }
}

function getActiveAction(state: RoomState): NightAction {
  const activeRoleId = state.night?.activeRoleId
  if (!activeRoleId) {
    return fail('Không có lượt gọi đêm đang mở.')
  }

  const action = state.night?.actionsByRole[activeRoleId]
  if (!action || action.status !== 'OPEN') {
    return fail('Lượt gọi hiện tại không có hành động đang mở.')
  }
  return action
}

function getCall(state: RoomState, roleId: RoleId): NightCall {
  const call = state.night?.calls.find((entry) => entry.roleId === roleId)
  return call ?? fail('Role này không nằm trong nghi thức đêm đã cấu hình.')
}

function allActorsConfirmed(action: NightAction): boolean {
  return action.eligibleActorIds.every((actorId) =>
    action.confirmedActorIds.includes(actorId),
  )
}

function finishCall(
  state: RoomState,
  roleId: RoleId,
  environment: GameEnvironment,
): void {
  const call = getCall(state, roleId)
  call.status = 'COMPLETED'
  call.completedAt = environment.now()
  if (state.night?.activeRoleId === roleId) {
    state.night.activeRoleId = null
  }
}

function finalizeWolfAction(
  state: RoomState,
  action: NightAction,
  result: FinalTargetResult,
  environment: GameEnvironment,
  randomCandidateIds: readonly PlayerId[] = [],
): void {
  action.status = 'COMPLETED'
  action.result = result
  action.completedAt = environment.now()

  if (result.random) {
    appendEvent(state, environment, 'WOLF_RANDOM_RESOLUTION', {
      actorRoleId: 'werewolf',
      targetPlayerId: result.targetId ?? undefined,
      resolution: result.reason,
      metadata: { candidateIds: randomCandidateIds },
    })
  }

  appendEvent(state, environment, 'TARGET_SELECTED', {
    actorRoleId: 'werewolf',
    targetPlayerId: result.targetId ?? undefined,
    resolution: result.reason,
    metadata: { random: result.random },
  })
  appendEvent(state, environment, 'FINAL_RESULT', {
    actorRoleId: 'werewolf',
    targetPlayerId: result.targetId ?? undefined,
    resolution: result.reason,
    metadata: { random: result.random },
  })
  finishCall(state, 'werewolf', environment)
}

function startNight(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'SETUP' && state.phase !== 'DAY') {
    fail('Chỉ có thể bắt đầu đêm từ khâu chuẩn bị hoặc ban ngày.')
  }
  if (state.lifecycle === 'ROLE_REVEAL') {
    if (
      state.players.some(
        (player) => !state.roleRevealConfirmedPlayerIds.includes(player.id),
      )
    ) {
      fail('Chờ tất cả người chơi xác nhận đã nhớ vai trò.')
    }
    state.lifecycle = 'IN_GAME'
  } else if (state.lifecycle !== 'IN_GAME') {
    fail('Phòng chưa sẵn sàng bắt đầu ván chơi.')
  }

  const previousPhase = state.phase
  if (previousPhase === 'DAY') {
    state.dayNumber += 1
  }
  state.phase = 'NIGHT'
  state.dayVote = null
  state.night = {
    number: state.dayNumber,
    calls: createNightCalls(state),
    activeRoleId: null,
    actionsByRole: {},
  }
  appendEvent(state, environment, 'PHASE_CHANGED', {
    resolution: 'NIGHT',
    metadata: { from: previousPhase, to: 'NIGHT' },
  })
}

function callNightRole(
  state: RoomState,
  roleId: RoleId,
  environment: GameEnvironment,
): void {
  if (state.phase !== 'NIGHT' || !state.night) {
    fail('Chỉ gọi role trong phase đêm.')
  }
  if (state.night.activeRoleId) {
    fail('Hãy hoàn tất lượt gọi hiện tại trước khi gọi role tiếp theo.')
  }

  const call = getCall(state, roleId)
  if (call.status !== 'NOT_CALLED') {
    fail('Role này đã được gọi trong đêm hiện tại.')
  }
  const nextCall = state.night.calls.find(
    (entry) => entry.status === 'NOT_CALLED',
  )
  if (nextCall?.roleId !== roleId) {
    fail('Hãy gọi role theo thứ tự nghi thức đã cấu hình.')
  }

  call.status = 'CALLED'
  call.calledAt = environment.now()
  state.night.activeRoleId = roleId
  appendEvent(state, environment, 'ROLE_CALLED', { actorRoleId: roleId })

  const definition = roleDefinitions[roleId]
  if (!definition) {
    fail('Mechanics của role này chưa được triển khai trong MS-0B.')
  }
  const eligibleActorIds = getLivingHolders(state, roleId)

  // A dead role deliberately produces no player action, but the call remains
  // active until the Moderator confirms it. No public state identifies why.
  if (eligibleActorIds.length === 0 || definition.actionType === 'NONE') {
    return
  }

  const eligibleTargetIds = getEligibleRoleTargets(state, roleId)
  const action: NightAction = {
    id: environment.nextId(),
    roleId,
    kind: definition.actionType,
    status: 'OPEN',
    eligibleActorIds,
    eligibleTargetIds,
    selections: {},
    confirmedActorIds: [],
    wolf:
      definition.actionType === 'WOLF_VOTE'
        ? { round: 'INITIAL', initialTiedTargetIds: [] }
        : undefined,
    openedAt: environment.now(),
  }
  state.night.actionsByRole[roleId] = action
  appendEvent(state, environment, 'ROLE_ACTION_OPENED', {
    actorRoleId: roleId,
    metadata: { actionId: action.id, eligibleActorCount: eligibleActorIds.length },
  })
}

function castWolfVote(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId | null,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'WOLF_VOTE' || !action.wolf) {
    fail('Đây không phải lượt bỏ phiếu của Ma Sói.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Người chơi không đủ điều kiện bỏ phiếu Ma Sói.')
  }
  if (action.confirmedActorIds.includes(playerId)) {
    fail('Phiếu đã được xác nhận và màn hình đã đóng.')
  }
  if (targetId !== null && !action.eligibleTargetIds.includes(targetId)) {
    fail('Mục tiêu không hợp lệ cho lượt Ma Sói.')
  }

  action.selections[playerId] = targetId
  appendEvent(
    state,
    environment,
    action.wolf.round === 'REVOTE'
      ? 'WOLF_REVOTE_CHANGED'
      : targetId === null
        ? 'WOLF_ABSTAIN'
        : 'WOLF_VOTE',
    {
      actorPlayerId: playerId,
      actorRoleId: 'werewolf',
      targetPlayerId: targetId ?? undefined,
      metadata: { round: action.wolf.round, abstain: targetId === null },
    },
  )
}

function confirmNightAction(
  state: RoomState,
  playerId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'WOLF_VOTE') {
    fail('Hành động chọn mục tiêu được xác nhận ngay khi gửi.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Người chơi không thuộc lượt hành động này.')
  }
  if (!Object.prototype.hasOwnProperty.call(action.selections, playerId)) {
    fail('Hãy chọn mục tiêu hoặc chọn không bỏ phiếu trước.')
  }
  if (!action.confirmedActorIds.includes(playerId)) {
    action.confirmedActorIds.push(playerId)
    appendEvent(state, environment, 'ROLE_ACTION_SUBMITTED', {
      actorPlayerId: playerId,
      actorRoleId: action.roleId,
      targetPlayerId: action.selections[playerId] ?? undefined,
      metadata: {
        actionId: action.id,
        round: action.wolf?.round,
        abstain: action.selections[playerId] === null,
      },
    })
  }
}

function submitTargetAction(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'SELECT_TARGET') {
    fail('Lượt này không dùng hành động chọn mục tiêu thông thường.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Người chơi không thuộc lượt hành động này.')
  }
  if (action.confirmedActorIds.includes(playerId)) {
    fail('Hành động đã được xác nhận.')
  }
  const eligibleTargets = getEligibleRoleTargets(state, action.roleId, playerId)
  if (!eligibleTargets.includes(targetId)) {
    fail('Mục tiêu không hợp lệ.')
  }

  action.selections[playerId] = targetId
  action.confirmedActorIds.push(playerId)
  appendEvent(state, environment, 'ROLE_ACTION_SUBMITTED', {
    actorPlayerId: playerId,
    actorRoleId: action.roleId,
    targetPlayerId: targetId,
    metadata: { actionId: action.id },
  })
  appendEvent(state, environment, 'TARGET_SELECTED', {
    actorPlayerId: playerId,
    actorRoleId: action.roleId,
    targetPlayerId: targetId,
  })

  if (allActorsConfirmed(action)) {
    action.status = 'COMPLETED'
    action.completedAt = environment.now()
    appendEvent(state, environment, 'FINAL_RESULT', {
      actorRoleId: action.roleId,
      targetPlayerId: targetId,
      resolution: 'ACTION_COMPLETE',
      metadata: { selections: action.selections },
    })
    finishCall(state, action.roleId, environment)
  }
}

function resolveWolfVote(
  state: RoomState,
  atDeadline: boolean,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'WOLF_VOTE' || !action.wolf) {
    fail('Không có lượt Ma Sói để phân giải.')
  }

  if (action.wolf.round === 'INITIAL') {
    if (!allActorsConfirmed(action)) {
      fail('Chưa đủ Ma Sói xác nhận lựa chọn.')
    }
    const resolution = resolveInitialWolfVote({
      policy: state.config.wolfPolicy,
      votes: action.selections,
      actorIds: action.eligibleActorIds,
      eligibleTargetIds: action.eligibleTargetIds,
      random: environment.random,
    })

    if (resolution.status === 'REVOTE_REQUIRED') {
      appendEvent(state, environment, 'WOLF_TIE', {
        actorRoleId: 'werewolf',
        resolution: 'INITIAL_TIE',
        metadata: { tiedTargetIds: resolution.tiedTargetIds },
      })
      action.wolf = {
        round: 'REVOTE',
        initialTiedTargetIds: resolution.tiedTargetIds,
        deadlineAt: environment.now() + state.config.revoteDurationMs,
      }
      action.eligibleTargetIds = resolution.tiedTargetIds
      action.selections = {}
      action.confirmedActorIds = []
      appendEvent(state, environment, 'WOLF_REVOTE_STARTED', {
        actorRoleId: 'werewolf',
        metadata: {
          candidateIds: resolution.tiedTargetIds,
          durationMs: state.config.revoteDurationMs,
          deadlineAt: action.wolf.deadlineAt,
        },
      })
      return
    }

    if (resolution.result.reason === 'TIED_TOP_RANDOM') {
      appendEvent(state, environment, 'WOLF_TIE', {
        actorRoleId: 'werewolf',
        resolution: 'INITIAL_TIE',
      })
    }
    const initialAnalysis = analyzeWolfVotes(
      action.selections,
      action.eligibleActorIds,
      action.eligibleTargetIds,
    )
    const randomCandidateIds =
      resolution.result.reason === 'TIED_TOP_RANDOM'
        ? initialAnalysis.leaders
        : resolution.result.reason === 'ALL_ABSTAIN_RANDOM'
          ? action.eligibleTargetIds
          : []
    finalizeWolfAction(
      state,
      action,
      resolution.result,
      environment,
      randomCandidateIds,
    )
    return
  }

  const deadlineReached =
    atDeadline &&
    action.wolf.deadlineAt !== undefined &&
    environment.now() >= action.wolf.deadlineAt
  if (!allActorsConfirmed(action) && !deadlineReached) {
    fail('Chỉ có thể chốt sớm khi mọi Ma Sói đã xác nhận, hoặc khi hết 10 giây.')
  }

  const result = resolveWolfRevote({
    votes: action.selections,
    actorIds: action.eligibleActorIds,
    initialTiedTargetIds: action.wolf.initialTiedTargetIds,
    random: environment.random,
  })
  if (result.reason === 'REVOTE_TIED_RANDOM') {
    appendEvent(state, environment, 'WOLF_TIE', {
      actorRoleId: 'werewolf',
      resolution: 'REVOTE_TIE_AT_RESOLUTION',
      metadata: { tiedTargetIds: action.wolf.initialTiedTargetIds },
    })
  }
  const revoteAnalysis = analyzeWolfVotes(
    action.selections,
    action.eligibleActorIds,
    action.wolf.initialTiedTargetIds,
  )
  const randomCandidateIds =
    result.reason === 'REVOTE_TIED_RANDOM'
      ? revoteAnalysis.leaders
      : result.reason === 'REVOTE_ALL_ABSTAIN_RANDOM'
        ? action.wolf.initialTiedTargetIds
        : []
  finalizeWolfAction(
    state,
    action,
    result,
    environment,
    randomCandidateIds,
  )
}

function completeNightCall(
  state: RoomState,
  roleId: RoleId,
  environment: GameEnvironment,
): void {
  if (state.phase !== 'NIGHT' || state.night?.activeRoleId !== roleId) {
    fail('Role này không phải lượt gọi hiện tại.')
  }
  const action = state.night.actionsByRole[roleId]
  if (action?.kind === 'WOLF_VOTE' && action.status === 'OPEN') {
    fail('Hãy phân giải phiếu Ma Sói trước khi đóng lượt gọi.')
  }
  if (action?.status === 'OPEN') {
    action.status = 'CLOSED_BY_MODERATOR'
    action.completedAt = environment.now()
    appendEvent(state, environment, 'FINAL_RESULT', {
      actorRoleId: roleId,
      resolution: 'CLOSED_BY_MODERATOR',
    })
  }
  finishCall(state, roleId, environment)
}

function startDay(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'NIGHT' || !state.night) {
    fail('Chỉ chuyển sang ngày từ phase đêm.')
  }
  if (state.night.calls.some((call) => call.status !== 'COMPLETED')) {
    fail('Phải gọi và hoàn tất tất cả role đêm đã cấu hình.')
  }
  state.phase = 'DAY'
  appendEvent(state, environment, 'PHASE_CHANGED', {
    resolution: 'DAY',
    metadata: { from: 'NIGHT', to: 'DAY' },
  })
}

function openDayVote(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'DAY') {
    fail('Chỉ mở bỏ phiếu treo cổ vào ban ngày.')
  }
  if (state.dayVote?.status === 'OPEN') {
    fail('Bỏ phiếu ban ngày đang mở.')
  }
  state.dayVote = {
    status: 'OPEN',
    votes: {},
    openedAt: environment.now(),
  }
  appendEvent(state, environment, 'DAY_VOTE_OPENED')
}

function castDayVote(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId | null,
  environment: GameEnvironment,
): void {
  if (state.phase !== 'DAY' || state.dayVote?.status !== 'OPEN') {
    fail('Bỏ phiếu ban ngày chưa mở.')
  }
  const player = state.players.find((entry) => entry.id === playerId)
  if (!player?.alive) {
    fail('Chỉ người chơi còn sống mới được bỏ phiếu.')
  }
  if (targetId !== null && !getEligibleDayTargets(state, playerId).includes(targetId)) {
    fail('Mục tiêu treo cổ không hợp lệ.')
  }
  const previousTargetId = state.dayVote.votes[playerId]
  state.dayVote.votes[playerId] = targetId
  appendEvent(state, environment, 'DAY_VOTE_CHANGED', {
    actorPlayerId: playerId,
    targetPlayerId: targetId ?? undefined,
    metadata: { previousTargetId, abstain: targetId === null },
  })
}

function closeDayVote(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'DAY' || state.dayVote?.status !== 'OPEN') {
    fail('Không có lượt bỏ phiếu ban ngày đang mở.')
  }
  const livingIds = state.players
    .filter((player) => player.alive)
    .map((player) => player.id)
  const result = resolveDayVote(state.dayVote.votes, livingIds, livingIds)
  state.dayVote.status = 'CLOSED'
  state.dayVote.closedAt = environment.now()
  state.dayVote.result = result
  appendEvent(state, environment, 'DAY_VOTE_CLOSED', {
    metadata: { voteCount: Object.keys(state.dayVote.votes).length },
  })
  appendEvent(state, environment, 'HANGING_RESULT', {
    targetPlayerId:
      result.kind === 'UNIQUE' ? result.targetIds[0] : undefined,
    resolution: result.kind,
    metadata: { targetIds: result.targetIds, counts: result.counts },
  })
}

function setPlayerAlive(
  state: RoomState,
  playerId: PlayerId,
  alive: boolean,
  reason: string | undefined,
  environment: GameEnvironment,
): void {
  const player = state.players.find((entry) => entry.id === playerId)
  if (!player) {
    fail('Không tìm thấy người chơi.')
  }
  if (player.alive === alive) {
    fail(`Người chơi đã ở trạng thái ${alive ? 'còn sống' : 'đã chết'}.`)
  }
  const from = player.alive ? 'alive' : 'dead'
  const to = alive ? 'alive' : 'dead'
  player.alive = alive
  appendEvent(state, environment, 'MODERATOR_OVERRIDE', {
    targetPlayerId: playerId,
    resolution: `${from}->${to}`,
    metadata: { from, to, reason: reason?.trim() || undefined },
  })
  if (!alive) {
    appendEvent(state, environment, 'PLAYER_DEATH', {
      targetPlayerId: playerId,
      resolution: 'MODERATOR_OVERRIDE',
      metadata: { reason: reason?.trim() || undefined },
    })
  }
}

export function applyRoomCommand(
  currentState: RoomState,
  command: RoomCommand,
  environment: GameEnvironment = defaultGameEnvironment,
): RoomState {
  if (command.type === 'RESET_ROOM') {
    const reset = createDemoRoom(
      command.playerCount,
      command.wolfPolicy,
      environment,
    )
    reset.revision = currentState.revision + 1
    return reset
  }

  const state = structuredClone(currentState)
  state.revision += 1

  switch (command.type) {
    case 'SET_WOLF_POLICY':
      if (
        state.night?.activeRoleId === 'werewolf' &&
        state.night.actionsByRole.werewolf?.status === 'OPEN'
      ) {
        fail('Không đổi chính sách khi lượt Ma Sói đang mở.')
      }
      state.config.wolfPolicy = command.policy
      break
    case 'JOIN_PLAYER':
      joinPlayer(state, command.playerId, command.name, environment)
      break
    case 'LOCK_AND_ASSIGN_ROLES':
      lockAndAssignRoles(state, environment)
      break
    case 'CONFIRM_ROLE_REVEAL':
      if (state.lifecycle !== 'ROLE_REVEAL') {
        fail('Phòng không ở bước xem vai trò.')
      }
      if (!state.players.some((player) => player.id === command.playerId)) {
        fail('Không tìm thấy người chơi.')
      }
      if (!state.roleRevealConfirmedPlayerIds.includes(command.playerId)) {
        state.roleRevealConfirmedPlayerIds.push(command.playerId)
      }
      break
    case 'START_NIGHT':
      startNight(state, environment)
      break
    case 'CALL_NIGHT_ROLE':
      callNightRole(state, command.roleId, environment)
      break
    case 'CAST_WOLF_VOTE':
      castWolfVote(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'CONFIRM_NIGHT_ACTION':
      confirmNightAction(state, command.playerId, environment)
      break
    case 'SUBMIT_TARGET_ACTION':
      submitTargetAction(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'RESOLVE_WOLF_VOTE':
      resolveWolfVote(state, command.atDeadline ?? false, environment)
      break
    case 'COMPLETE_NIGHT_CALL':
      completeNightCall(state, command.roleId, environment)
      break
    case 'START_DAY':
      startDay(state, environment)
      break
    case 'OPEN_DAY_VOTE':
      openDayVote(state, environment)
      break
    case 'CAST_DAY_VOTE':
      castDayVote(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'CLOSE_DAY_VOTE':
      closeDayVote(state, environment)
      break
    case 'MODERATOR_SET_ALIVE':
      setPlayerAlive(
        state,
        command.playerId,
        command.alive,
        command.reason,
        environment,
      )
      break
    case 'END_MATCH': {
      const from = state.phase
      state.phase = 'ENDED'
      state.lifecycle = 'FINISHED'
      appendEvent(state, environment, 'MATCH_ENDED', {
        metadata: { from },
      })
      break
    }
  }

  return state
}
