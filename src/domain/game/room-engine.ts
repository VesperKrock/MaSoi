import { createRequestId } from '../../lib/request-id'
import { createJournalEvent } from '../journal/journal'
import {
  getNightRoleIds,
  getPreWitchNightRoleIds,
  roleDefinitions,
} from '../roles/role-definitions'
import {
  getEligibleDayTargets,
  getEligibleRoleTargets,
  getEligibleWolfGroupActors,
  getEligibleWolfTargets,
  getLivingHolders,
  getRoleIdForPlayer,
} from '../actions/target-rules'
import { detectForSeer } from '../gameplay/night-rules'
import {
  createHalfWolfBiteEffect,
  createWolfAttackEffect,
  getNightResolutionReadiness,
} from '../gameplay/night-resolution'
import {
  createInitialFactionTransitionState,
  isHalfWolfTransformed,
  reconcileFactionTransitions,
  scheduleHalfWolfTransformation,
  type FactionReconciliationStage,
} from '../gameplay/faction-transitions'
import { resolveNightEffectsWithHunter } from '../gameplay/hunter-night'
import {
  acknowledgeLoverReveal,
  createInitialCupidLoverState,
  fallbackCupidWithoutPair,
  pairLovers,
  reconcileCupidObjective,
  stabilizeDeathConsequences,
} from '../gameplay/lovers'
import {
  finalizeWitchCheckpoint,
  getWitchCapabilities,
  validateWitchDecision,
} from '../gameplay/witch-checkpoint'
import {
  createDayHangingEffect,
  createHunterRevengeEffect,
  dayVoteDurationMs,
  getDayVoteWeight,
  resolveDayVote,
} from '../voting/day-vote'
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
  nextId: createRequestId,
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
    nightResolution: null,
    witchResources: null,
    witchCheckpoint: null,
    dayVote: null,
    factionTransitions: createInitialFactionTransitionState([]),
    cupidLovers: createInitialCupidLoverState([], environment.now()),
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
    nightResolution: null,
    witchResources: null,
    witchCheckpoint: null,
    dayVote: null,
    factionTransitions: createInitialFactionTransitionState(roleAssignments),
    cupidLovers: createInitialCupidLoverState(
      roleAssignments,
      environment.now(),
    ),
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
  state.factionTransitions = createInitialFactionTransitionState(
    state.roleAssignments,
  )
  state.cupidLovers = createInitialCupidLoverState(
    state.roleAssignments,
    environment.now(),
  )
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

function applyFactionReconciliation(
  state: RoomState,
  stage: FactionReconciliationStage,
  environment: GameEnvironment,
): void {
  const result = reconcileFactionTransitions({
    state: state.factionTransitions,
    assignments: state.roleAssignments,
    players: state.players,
    nightNumber: state.dayNumber,
    stage,
    now: environment.now(),
  })
  state.factionTransitions = result.state
  for (const event of result.events) {
    appendEvent(state, environment, event.type, {
      targetPlayerId: event.playerId,
      actorRoleId:
        event.type === 'TRAITOR_CONVERTED_TO_VILLAGE'
          ? 'traitor'
          : 'half-wolf',
      resolution:
        event.type === 'HALF_WOLF_TRANSFORMED'
          ? `WOLF_FROM_NIGHT_${event.nightNumber}`
          : event.reason,
    })
  }
}

function applyCupidObjectiveReconciliation(
  state: RoomState,
  environment: GameEnvironment,
): void {
  if (!state.cupidLovers) return
  const previous = state.cupidLovers.objective?.status
  const next = reconcileCupidObjective(
    state.cupidLovers,
    state.players.filter((player) => player.alive).map((player) => player.id),
    environment.now(),
  )
  state.cupidLovers = next
  if (
    previous !== 'FALLBACK_VILLAGE' &&
    next.objective?.status === 'FALLBACK_VILLAGE'
  ) {
    appendEvent(state, environment, 'CUPID_OBJECTIVE_FALLBACK', {
      actorPlayerId: next.objective.cupidPlayerId,
      actorRoleId: 'cupid',
      resolution: next.objective.reason,
      metadata: { originalRoleUnchanged: true },
    })
  }
}

function applyDayHeartbreakConsequences(
  state: RoomState,
  initialFinalDeaths: readonly { playerId: PlayerId; sourceEffectIds: string[] }[],
  livingPlayerIdsBefore: readonly PlayerId[],
  environment: GameEnvironment,
): void {
  if (!state.dayVote) fail('Thiếu trạng thái bỏ phiếu ban ngày để ổn định hậu quả.')
  const initialDeathIds = new Set(
    initialFinalDeaths.map((death) => death.playerId),
  )
  const stabilized = stabilizeDeathConsequences({
    initialFinalDeaths,
    livingPlayerIdsBefore,
    couple: state.cupidLovers?.couple ?? null,
    nextEffectId: environment.nextId,
  })
  state.dayVote.consequenceEffects ??= []
  for (const effect of stabilized.heartbreakEffects) {
    state.dayVote.consequenceEffects.push(effect)
    const target = state.players.find(
      (player) => player.id === effect.targetPlayerId,
    )
    if (target) target.alive = false
    appendEvent(state, environment, 'LOVER_HEARTBREAK_CREATED', {
      actorPlayerId: effect.sourcePlayerId,
      targetPlayerId: effect.targetPlayerId,
      resolution: 'FINAL_DAY_CONSEQUENCE',
      metadata: {
        effectId: effect.id,
        coupleId: effect.coupleId,
        sourceType: effect.sourceType,
        protectorBlockable: false,
        witchInteractable: false,
      },
    })
    appendEvent(state, environment, 'PLAYER_DEATH', {
      actorPlayerId: effect.sourcePlayerId,
      targetPlayerId: effect.targetPlayerId,
      resolution: 'LOVER_HEARTBREAK',
      metadata: { sourceEffectId: effect.id, publicRoleReveal: false },
    })
  }
  for (const death of stabilized.finalDeaths) {
    if (initialDeathIds.has(death.playerId)) continue
    const target = state.players.find((player) => player.id === death.playerId)
    if (target) target.alive = false
  }
  applyFactionReconciliation(state, 'AFTER_DEATH', environment)
  applyCupidObjectiveReconciliation(state, environment)
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
    if (!state.dayVote || state.dayVote.status !== 'CLOSED') {
      fail('Phải hoàn tất bỏ phiếu ban ngày trước khi bắt đầu Đêm tiếp theo.')
    }
    if (state.dayVote.hunterRevenge?.status === 'PENDING') {
      fail('Phải chờ Thợ Săn hoàn tất phát bắn trả thù.')
    }
    state.dayNumber += 1
  }
  state.phase = 'NIGHT'
  applyFactionReconciliation(state, 'START_NIGHT', environment)
  state.dayVote = null
  state.nightResolution = null
  state.witchCheckpoint = null
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
  call.status = 'CALLED'
  call.calledAt = environment.now()
  state.night.activeRoleId = roleId
  appendEvent(state, environment, 'ROLE_CALLED', { actorRoleId: roleId })

  const definition = roleDefinitions[roleId]
  if (!definition) {
    fail('Mechanics của role này chưa được triển khai trong MS-0B.')
  }
  const witchCall = state.night.calls.find((entry) => entry.roleId === 'witch')
  if (
    definition.nightStage === 'PRE_WITCH' &&
    witchCall &&
    witchCall.status !== 'NOT_CALLED'
  ) {
    fail('Không thể mở role đầu Đêm sau khi checkpoint Phù Thủy đã mở.')
  }
  if (roleId === 'witch') {
    const incompletePreWitch = getPreWitchNightRoleIds(
      state.config.nightRoleIds,
    ).filter(
      (preWitchRoleId) =>
        state.night?.calls.find((entry) => entry.roleId === preWitchRoleId)
          ?.status !== 'COMPLETED',
    )
    if (incompletePreWitch.length > 0) {
      fail('Phải hoàn tất tất cả lượt gọi trước Phù Thủy.')
    }
    if (state.nightResolution?.nightNumber !== state.dayNumber) {
      fail('Phải phân giải hiệu ứng đầu Đêm trước khi gọi Phù Thủy.')
    }
  }

  const eligibleActorIds =
    roleId === 'werewolf'
      ? getEligibleWolfGroupActors(state)
      : getLivingHolders(state, roleId)

  if (roleId === 'witch' && !state.witchResources) {
    const witchPlayerId = state.roleAssignments.find(
      (assignment) => assignment.roleId === 'witch',
    )?.playerId
    if (!witchPlayerId) fail('Không tìm thấy holder Phù Thủy đã được chia vai.')
    state.witchResources = {
      witchPlayerId,
      resurrectionAvailable: true,
      poisonAvailable: true,
    }
  }

  if (roleId === 'cupid') {
    const cupidPlayerId = state.roleAssignments.find(
      (assignment) => assignment.roleId === 'cupid',
    )?.playerId
    if (!cupidPlayerId) fail('Không tìm thấy holder Thần Tình Yêu đã được chia vai.')
    if (state.dayNumber !== 1 || state.cupidLovers?.couple) {
      return
    }
    if (eligibleActorIds.length === 0) {
      state.cupidLovers = fallbackCupidWithoutPair(
        state.cupidLovers ?? createInitialCupidLoverState(state.roleAssignments),
        cupidPlayerId,
        environment.now(),
      )
      return
    }
  }

  // A dead role deliberately produces no player action, but the call remains
  // active until the Moderator confirms it. No public state identifies why.
  if (eligibleActorIds.length === 0 || definition.actionType === 'NONE') {
    return
  }

  if (roleId === 'witch') {
    const witchPlayerId = eligibleActorIds[0]
    const witchResources = state.witchResources
    if (!witchResources) fail('Thiếu tài nguyên Phù Thủy của ván hiện tại.')
    const capabilities = getWitchCapabilities({
      nightNumber: state.dayNumber,
      witchPlayerId,
      witchAliveBeforeNight: true,
      provisionalDeathCandidateIds:
        state.nightResolution?.provisionalDeathCandidateIds ?? [],
      players: state.players,
      resources: witchResources,
    })
    const action: NightAction = {
      id: environment.nextId(),
      roleId,
      kind: 'WITCH_DECISION',
      status: 'OPEN',
      eligibleActorIds,
      eligibleTargetIds: [
        ...new Set([
          ...capabilities.resurrectionCandidateIds,
          ...capabilities.poisonCandidateIds,
        ]),
      ],
      selections: {},
      confirmedActorIds: [],
      witch: {
        resurrectionCandidateIds: capabilities.resurrectionCandidateIds,
        poisonCandidateIds: capabilities.poisonCandidateIds,
        resurrectionAvailable: capabilities.canResurrect,
        poisonAvailable: capabilities.canPoison,
        attackedThisNight: capabilities.attackedThisNight,
      },
      openedAt: environment.now(),
    }
    state.night.actionsByRole.witch = action
    appendEvent(state, environment, 'ROLE_ACTION_OPENED', {
      actorRoleId: 'witch',
      metadata: { actionId: action.id, eligibleActorCount: 1 },
    })
    return
  }

  const eligibleTargetIds =
    roleId === 'werewolf'
      ? getEligibleWolfTargets(state)
      : getEligibleRoleTargets(state, roleId, eligibleActorIds[0])
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
    cupid:
      definition.actionType === 'CUPID_PAIRING'
        ? { selectedTargetIds: [] }
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

function castHunterPrelock(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId | null,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'HUNTER_PRELOCK' || action.roleId !== 'hunter') {
    fail('Đây không phải lượt khóa mục tiêu của Thợ Săn.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Chỉ Thợ Săn còn sống mới được khóa mục tiêu.')
  }
  if (action.confirmedActorIds.includes(playerId)) {
    fail('Mục tiêu Thợ Săn đã được xác nhận.')
  }
  if (targetId !== null && !action.eligibleTargetIds.includes(targetId)) {
    fail('Mục tiêu Thợ Săn phải còn sống, cùng phòng và không phải chính mình.')
  }

  action.selections[playerId] = targetId
  appendEvent(state, environment, 'ROLE_ACTION_SUBMITTED', {
    actorPlayerId: playerId,
    actorRoleId: 'hunter',
    targetPlayerId: targetId ?? undefined,
    metadata: {
      actionId: action.id,
      prelockOnly: true,
      nobody: targetId === null,
      confirmed: false,
    },
  })
}

function confirmHunterPrelock(
  state: RoomState,
  playerId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'HUNTER_PRELOCK' || action.roleId !== 'hunter') {
    fail('Đây không phải lượt xác nhận của Thợ Săn.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Chỉ Thợ Săn còn sống mới được xác nhận mục tiêu.')
  }
  if (!Object.prototype.hasOwnProperty.call(action.selections, playerId)) {
    fail('Hãy chọn một người hoặc Không ai trước khi xác nhận.')
  }
  if (action.confirmedActorIds.includes(playerId)) return

  action.confirmedActorIds.push(playerId)
  action.status = 'COMPLETED'
  action.completedAt = environment.now()
  const targetId = action.selections[playerId]
  appendEvent(state, environment, 'HUNTER_TARGET_LOCKED', {
    actorPlayerId: playerId,
    actorRoleId: 'hunter',
    targetPlayerId: targetId ?? undefined,
    resolution: targetId === null ? 'NOBODY' : 'TARGET_LOCKED',
    metadata: { prelockOnly: true },
  })
  finishCall(state, 'hunter', environment)
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
  if (action.roleId === 'protector') {
    appendEvent(state, environment, 'PROTECTOR_INTENT', {
      actorPlayerId: playerId,
      actorRoleId: 'protector',
      targetPlayerId: targetId,
      metadata: { nightNumber: state.dayNumber, intentOnly: true },
    })
  }

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

function submitSeerInspection(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'SELECT_TARGET' || action.roleId !== 'seer') {
    fail('Đây không phải lượt kiểm tra của Tiên Tri.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Người chơi không đủ điều kiện kiểm tra.')
  }
  if (action.seer) {
    fail('Tiên Tri chỉ được kiểm tra một người mỗi đêm.')
  }
  const eligibleTargets = getEligibleRoleTargets(state, 'seer', playerId)
  if (!eligibleTargets.includes(targetId)) {
    fail('Mục tiêu không hợp lệ cho Tiên Tri.')
  }
  const targetRoleId = getRoleIdForPlayer(state, targetId)
  if (!targetRoleId) fail('Mục tiêu chưa có vai trò máy chủ.')

  action.selections[playerId] = targetId
  action.seer = {
    targetId,
    result: detectForSeer(targetRoleId, {
      halfWolfTransformed: isHalfWolfTransformed(
        state.factionTransitions,
        targetId,
      ),
    }),
    acknowledged: false,
  }
  appendEvent(state, environment, 'SEER_INSPECTION', {
    actorPlayerId: playerId,
    actorRoleId: 'seer',
    targetPlayerId: targetId,
    resolution: action.seer.result,
  })
}

function acknowledgeSeerResult(
  state: RoomState,
  playerId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.kind !== 'SELECT_TARGET' || action.roleId !== 'seer') {
    fail('Đây không phải lượt kết quả của Tiên Tri.')
  }
  if (!action.eligibleActorIds.includes(playerId) || !action.seer) {
    fail('Không có kết quả Tiên Tri để xác nhận.')
  }
  if (!action.confirmedActorIds.includes(playerId)) {
    action.confirmedActorIds.push(playerId)
  }
  action.seer.acknowledged = true
  action.status = 'COMPLETED'
  action.completedAt = environment.now()
  appendEvent(state, environment, 'SEER_RESULT_ACKNOWLEDGED', {
    actorPlayerId: playerId,
    actorRoleId: 'seer',
    targetPlayerId: action.seer.targetId,
    resolution: action.seer.result,
  })
  finishCall(state, 'seer', environment)
}

function submitProtectorTarget(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.roleId !== 'protector') {
    fail('Đây không phải lượt chọn của Bảo Vệ.')
  }
  submitTargetAction(state, playerId, targetId, environment)
}

function submitCupidPairing(
  state: RoomState,
  playerId: PlayerId,
  targetIds: [PlayerId, PlayerId],
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (action.roleId !== 'cupid' || action.kind !== 'CUPID_PAIRING') {
    fail('Đây không phải lượt ghép đôi của Thần Tình Yêu.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Chỉ Thần Tình Yêu còn sống mới được ghép đôi.')
  }
  if (action.status !== 'OPEN' || action.confirmedActorIds.includes(playerId)) {
    fail('Cặp đôi Đêm đầu tiên đã được xác nhận.')
  }

  state.cupidLovers = pairLovers({
    state:
      state.cupidLovers ??
      createInitialCupidLoverState(state.roleAssignments, environment.now()),
    coupleId: environment.nextId(),
    cupidPlayerId: playerId,
    targetPlayerIds: targetIds,
    livingPlayerIds: state.players
      .filter((player) => player.alive)
      .map((player) => player.id),
    nightNumber: state.dayNumber,
    now: environment.now(),
  })
  action.cupid = { selectedTargetIds: [...targetIds] }
  action.confirmedActorIds.push(playerId)
  action.status = 'COMPLETED'
  action.completedAt = environment.now()
  appendEvent(state, environment, 'CUPID_PAIR_CREATED', {
    actorPlayerId: playerId,
    actorRoleId: 'cupid',
    resolution: 'PAIR_CREATED',
    metadata: {
      actionId: action.id,
      coupleId: state.cupidLovers.couple?.id,
      loverPlayerIds: [...targetIds],
      private: true,
    },
  })
  finishCall(state, 'cupid', environment)
}

function acknowledgePrivateLoverReveal(
  state: RoomState,
  playerId: PlayerId,
  environment: GameEnvironment,
): void {
  const current = state.cupidLovers
  if (!current?.couple?.loverPlayerIds.includes(playerId)) {
    fail('Người chơi này không có thông tin Người Yêu riêng để xác nhận.')
  }
  const next = acknowledgeLoverReveal(current, playerId)
  if (next === current) return
  state.cupidLovers = next
  appendEvent(state, environment, 'LOVER_REVEAL_ACKNOWLEDGED', {
    actorPlayerId: playerId,
    resolution: 'PRIVATE_PARTNER_REMEMBERED',
    metadata: { coupleId: current.couple.id, private: true },
  })
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
  if (roleId === 'witch' && action?.status === 'OPEN') {
    fail('Phù Thủy còn sống phải xác nhận quyết định kết hợp trên thiết bị riêng.')
  }
  if (roleId === 'hunter' && action?.status === 'OPEN') {
    fail('Thợ Săn còn sống phải khóa và xác nhận mục tiêu trên thiết bị riêng.')
  }
  if (roleId === 'cupid' && action?.status === 'OPEN') {
    fail('Thần Tình Yêu còn sống trong Đêm 1 phải ghép đúng hai người.')
  }
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

function submitWitchDecision(
  state: RoomState,
  playerId: PlayerId,
  resurrectionTargetId: PlayerId | null,
  poisonTargetId: PlayerId | null,
  environment: GameEnvironment,
): void {
  const action = getActiveAction(state)
  if (
    action.roleId !== 'witch' ||
    action.kind !== 'WITCH_DECISION' ||
    !action.witch
  ) {
    fail('Đây không phải checkpoint hành động của Phù Thủy.')
  }
  if (!action.eligibleActorIds.includes(playerId)) {
    fail('Chỉ Phù Thủy còn sống mới được gửi quyết định này.')
  }
  if (action.confirmedActorIds.includes(playerId)) {
    fail('Quyết định Phù Thủy đã được xác nhận.')
  }
  if (!state.nightResolution || !state.witchResources) {
    fail('Thiếu dữ liệu phân giải đầu Đêm hoặc tài nguyên Phù Thủy.')
  }

  const capabilityInput = {
    nightNumber: state.dayNumber,
    witchPlayerId: playerId,
    witchAliveBeforeNight: true,
    provisionalDeathCandidateIds:
      state.nightResolution.provisionalDeathCandidateIds,
    players: state.players,
    resources: state.witchResources,
  }
  validateWitchDecision(
    {
      ...capabilityInput,
      preWitchEffects: state.nightResolution.effects,
      poisonEffectId: poisonTargetId ? 'validation-only' : undefined,
    },
    { resurrectionTargetId, poisonTargetId },
    getWitchCapabilities(capabilityInput),
  )

  action.witch.decision = { resurrectionTargetId, poisonTargetId }
  action.confirmedActorIds.push(playerId)
  action.status = 'COMPLETED'
  action.completedAt = environment.now()
  appendEvent(state, environment, 'WITCH_DECISION_SUBMITTED', {
    actorPlayerId: playerId,
    actorRoleId: 'witch',
    metadata: {
      usesResurrection: resurrectionTargetId !== null,
      usesPoison: poisonTargetId !== null,
    },
  })
  finishCall(state, 'witch', environment)
}

function resolveNightConsequences(
  state: RoomState,
  environment: GameEnvironment,
): void {
  if (state.lifecycle !== 'IN_GAME' || state.phase !== 'NIGHT' || !state.night) {
    fail('Chỉ có thể phân giải hiệu ứng trong Đêm của ván đang chơi.')
  }
  if (state.nightResolution?.nightNumber === state.dayNumber) return

  const readiness = getNightResolutionReadiness({
    configuredRoleIds: state.config.nightRoleIds,
    calls: state.night.calls,
  })
  if (!readiness.ready) {
    fail('Chưa hoàn tất các lượt gọi đóng góp cho phân giải Đêm.')
  }

  const wolfTargetId =
    state.night.actionsByRole.werewolf?.result?.targetId ?? undefined
  const protectorTargetId = Object.values(
    state.night.actionsByRole.protector?.selections ?? {},
  ).find((targetId): targetId is PlayerId => typeof targetId === 'string')
  const wolfTargetRoleId = wolfTargetId
    ? getRoleIdForPlayer(state, wolfTargetId)
    : undefined
  const effects = wolfTargetId
    ? [
        wolfTargetRoleId === 'half-wolf' &&
        !isHalfWolfTransformed(state.factionTransitions, wolfTargetId)
          ? createHalfWolfBiteEffect(
              environment.nextId(),
              wolfTargetId,
              state.dayNumber,
            )
          : createWolfAttackEffect(environment.nextId(), wolfTargetId),
      ]
    : []
  const hunterAction = state.night.actionsByRole.hunter
  const hunterPlayerId = hunterAction?.eligibleActorIds[0]
  const hunterHasSelection =
    hunterPlayerId !== undefined &&
    Object.prototype.hasOwnProperty.call(
      hunterAction?.selections ?? {},
      hunterPlayerId,
    )
  const hunterTargetId = hunterHasSelection
    ? hunterAction?.selections[hunterPlayerId]
    : undefined
  const result = resolveNightEffectsWithHunter(
    effects,
    protectorTargetId,
    hunterPlayerId && hunterHasSelection
      ? {
          hunterPlayerId,
          targetPlayerId: hunterTargetId ?? null,
        }
      : null,
    hunterTargetId ? environment.nextId() : undefined,
  )
  const resolvedAt = environment.now()

  state.nightResolution = {
    id: environment.nextId(),
    nightNumber: state.dayNumber,
    resolvedAt,
    ...result,
  }

  const successfulHalfWolfBite = result.effects.find(
    (effect) => effect.outcome === 'HALF_WOLF_BITE_SCHEDULED',
  )
  if (successfulHalfWolfBite) {
    const scheduled = scheduleHalfWolfTransformation({
      state: state.factionTransitions,
      assignments: state.roleAssignments,
      playerId: successfulHalfWolfBite.targetPlayerId,
      bittenNightNumber: state.dayNumber,
      now: resolvedAt,
    })
    state.factionTransitions = scheduled.state
    if (scheduled.scheduled) {
      appendEvent(state, environment, 'HALF_WOLF_BITE_SCHEDULED', {
        actorRoleId: 'werewolf',
        targetPlayerId: successfulHalfWolfBite.targetPlayerId,
        resolution: 'TRANSFORM_NEXT_NIGHT',
        metadata: {
          effectId: successfulHalfWolfBite.id,
          transformDueNightNumber: state.dayNumber + 1,
        },
      })
    }
  }

  for (const effect of result.effects) {
    appendEvent(
      state,
      environment,
      effect.sourceType === 'HUNTER_SHOT'
        ? 'HUNTER_SHOT_CREATED'
        : 'WOLF_ATTACK_CREATED',
      {
        actorRoleId: effect.sourceRoleId,
        targetPlayerId: effect.targetPlayerId,
        resolution: effect.outcome,
        metadata: {
          effectId: effect.id,
          sourceType: effect.sourceType,
          category: effect.category,
          lethal: effect.lethal,
          protectorBlockable: effect.protectorBlockable,
          activationCondition: effect.activationCondition,
          conversion: effect.conversion,
        },
      },
    )
    if (effect.outcome === 'BLOCKED_BY_PROTECTOR') {
      appendEvent(state, environment, 'WOLF_ATTACK_BLOCKED', {
        actorRoleId: 'werewolf',
        targetPlayerId: effect.targetPlayerId,
        resolution: effect.outcome,
        metadata: {
          effectId: effect.id,
          blockSourceType: effect.blockSourceType,
          blockSourceRoleId: effect.blockSourceRoleId,
        },
      })
    }
  }

  for (const playerId of result.provisionalDeathCandidateIds) {
    appendEvent(state, environment, 'NIGHT_DEATH_CANDIDATE_CREATED', {
      actorRoleId: result.effects.find(
        (effect) => effect.targetPlayerId === playerId,
      )?.sourceRoleId,
      targetPlayerId: playerId,
      resolution: 'PROVISIONAL_PRE_WITCH',
      metadata: {
        sourceEffectIds: result.effects
          .filter(
            (effect) =>
              effect.targetPlayerId === playerId &&
              effect.lethal &&
              effect.outcome === 'UNBLOCKED',
          )
          .map((effect) => effect.id),
      },
    })
  }

  appendEvent(state, environment, 'NIGHT_RESOLUTION_COMPLETED', {
    actorRoleId: 'werewolf',
    resolution: result.outcome,
    metadata: {
      resolutionId: state.nightResolution.id,
      effectCount: result.effects.length,
      provisionalDeathCandidateCount:
        result.provisionalDeathCandidateIds.length,
      finalDeathsApplied: false,
    },
  })
}

function finalizeNightCheckpoint(
  state: RoomState,
  environment: GameEnvironment,
): void {
  if (state.lifecycle !== 'IN_GAME' || state.phase !== 'NIGHT' || !state.night) {
    fail('Chỉ được chốt tử vong trong Đêm của ván đang chơi.')
  }
  if (state.witchCheckpoint?.nightNumber === state.dayNumber) return
  if (state.nightResolution?.nightNumber !== state.dayNumber) {
    fail('Phải phân giải hiệu ứng đầu Đêm trước khi chốt tử vong.')
  }

  const incompletePreWitchCalls = getPreWitchNightRoleIds(
    state.config.nightRoleIds,
  ).filter(
    (roleId) =>
      state.night?.calls.find((call) => call.roleId === roleId)?.status !==
      'COMPLETED',
  )
  if (incompletePreWitchCalls.length > 0) {
    fail('Phải hoàn tất tất cả nghi thức trước Phù Thủy trước khi chốt Đêm.')
  }

  const witchConfigured = state.config.nightRoleIds.includes('witch')
  const witchCall = state.night.calls.find((call) => call.roleId === 'witch')
  if (witchConfigured && witchCall?.status !== 'COMPLETED') {
    fail('Phải gọi và hoàn tất nghi thức Phù Thủy trước khi chốt Đêm.')
  }
  const witchPlayerId =
    state.roleAssignments.find((assignment) => assignment.roleId === 'witch')
      ?.playerId ?? null
  const witchAliveBeforeNight =
    witchPlayerId !== null &&
    state.players.find((player) => player.id === witchPlayerId)?.alive === true
  const decision = state.night.actionsByRole.witch?.witch?.decision ?? null
  const preliminaryResult = finalizeWitchCheckpoint({
    nightNumber: state.dayNumber,
    witchPlayerId,
    witchAliveBeforeNight,
    provisionalDeathCandidateIds:
      state.nightResolution.provisionalDeathCandidateIds,
    preWitchEffects: state.nightResolution.effects,
    players: state.players,
    resources: witchConfigured ? state.witchResources ?? null : null,
    decision,
    poisonEffectId: decision?.poisonTargetId
      ? environment.nextId()
      : undefined,
  })
  const hunterEffect = state.nightResolution.effects.find(
    (effect) => effect.sourceType === 'HUNTER_SHOT',
  )
  const suppressedEffectIds =
    hunterEffect &&
    decision?.resurrectionTargetId === hunterEffect.targetPlayerId &&
    preliminaryResult.conditionalEffectStates.some(
      (entry) =>
        entry.effectId === hunterEffect.id && entry.status === 'ACTIVATED',
    )
      ? [hunterEffect.id]
      : []
  const stabilized = stabilizeDeathConsequences({
    initialFinalDeaths: preliminaryResult.finalDeaths,
    livingPlayerIdsBefore: state.players
      .filter((player) => player.alive)
      .map((player) => player.id),
    couple: state.cupidLovers?.couple ?? null,
    hunter:
      hunterEffect?.activationCondition?.sourcePlayerId
        ? {
            hunterPlayerId: hunterEffect.activationCondition.sourcePlayerId,
            targetPlayerId: hunterEffect.targetPlayerId,
            effectId: hunterEffect.id,
          }
        : null,
    suppressedEffectIds,
    nextEffectId: environment.nextId,
  })
  const result = {
    ...preliminaryResult,
    finalDeaths: stabilized.finalDeaths,
    conditionalEffectStates: preliminaryResult.conditionalEffectStates.map(
      (entry) =>
        entry.effectId === hunterEffect?.id && stabilized.hunterShotActivated
          ? { ...entry, status: 'ACTIVATED' as const }
          : entry,
    ),
  }
  for (const heartbreak of stabilized.heartbreakEffects) {
    state.nightResolution.effects.push({
      ...heartbreak,
      outcome: 'UNBLOCKED',
    })
    appendEvent(state, environment, 'LOVER_HEARTBREAK_CREATED', {
      actorPlayerId: heartbreak.sourcePlayerId,
      targetPlayerId: heartbreak.targetPlayerId,
      resolution: 'FINAL_NIGHT_CONSEQUENCE',
      metadata: {
        effectId: heartbreak.id,
        coupleId: heartbreak.coupleId,
        sourceType: heartbreak.sourceType,
        protectorBlockable: false,
        witchInteractable: false,
      },
    })
  }
  state.witchResources = result.resourcesAfter
  state.witchCheckpoint = {
    id: environment.nextId(),
    nightNumber: state.dayNumber,
    finalizedAt: environment.now(),
    ...result,
  }

  for (const activation of result.conditionalEffectStates) {
    const effect = state.nightResolution.effects.find(
      (entry) => entry.id === activation.effectId,
    )
    if (effect) effect.activationStatus = activation.status
    appendEvent(
      state,
      environment,
      activation.status === 'ACTIVATED'
        ? 'HUNTER_SHOT_ACTIVATED'
        : 'HUNTER_SHOT_CANCELED',
      {
        actorRoleId: 'hunter',
        targetPlayerId: effect?.targetPlayerId,
        resolution: activation.status,
        metadata: { effectId: activation.effectId },
      },
    )
    if (
      activation.status === 'ACTIVATED' &&
      effect &&
      decision?.resurrectionTargetId !== null &&
      decision?.resurrectionTargetId !== undefined &&
      effect.targetPlayerId === decision.resurrectionTargetId
    ) {
      appendEvent(state, environment, 'HUNTER_SHOT_VICTIM_RESCUED', {
        actorRoleId: 'hunter',
        targetPlayerId: effect.targetPlayerId,
        resolution: 'CURRENT_NIGHT_RESCUE',
        metadata: { effectId: activation.effectId },
      })
    }
  }

  for (const playerId of result.rescuedPlayerIds) {
    appendEvent(state, environment, 'WITCH_RESURRECTION_USED', {
      actorRoleId: 'witch',
      targetPlayerId: playerId,
      resolution: 'CURRENT_NIGHT_RESCUE',
    })
  }
  if (result.poisonEffect) {
    appendEvent(state, environment, 'WITCH_POISON_USED', {
      actorRoleId: 'witch',
      targetPlayerId: result.poisonEffect.targetPlayerId,
      resolution: result.poisonEffect.outcome,
      metadata: {
        effectId: result.poisonEffect.id,
        category: result.poisonEffect.category,
        protectorBlockable: false,
      },
    })
  }
  for (const death of result.finalDeaths) {
    const player = state.players.find((entry) => entry.id === death.playerId)
    if (player) player.alive = false
    appendEvent(state, environment, 'NIGHT_DEATH_FINALIZED', {
      targetPlayerId: death.playerId,
      resolution: 'FINAL_NIGHT_DEATH',
      metadata: { sourceEffectIds: death.sourceEffectIds },
    })
    appendEvent(state, environment, 'PLAYER_DEATH', {
      targetPlayerId: death.playerId,
      resolution: 'NIGHT_CHECKPOINT',
      metadata: { sourceEffectIds: death.sourceEffectIds },
    })
  }
  applyFactionReconciliation(state, 'AFTER_DEATH', environment)
  applyCupidObjectiveReconciliation(state, environment)
  appendEvent(state, environment, 'WITCH_CHECKPOINT_COMPLETED', {
    actorRoleId: witchConfigured ? 'witch' : undefined,
    resolution: 'FINALIZED',
    metadata: {
      finalDeathCount: result.finalDeaths.length,
      phaseTransitioned: false,
    },
  })
}

function startDay(state: RoomState, environment: GameEnvironment): void {
  if (state.phase === 'DAY') return
  if (state.phase !== 'NIGHT' || !state.night) {
    fail('Chỉ chuyển sang ngày từ phase đêm.')
  }
  if (state.night.calls.some((call) => call.status !== 'COMPLETED')) {
    fail('Phải gọi và hoàn tất tất cả role đêm đã cấu hình.')
  }
  if (state.witchCheckpoint?.nightNumber !== state.dayNumber) {
    fail('Phải hoàn tất checkpoint tử vong Đêm trước khi chuyển phase.')
  }
  state.phase = 'DAY'
  state.dayVote = null
  appendEvent(state, environment, 'MORNING_STARTED', {
    resolution: 'DAY_DISCUSSION',
    metadata: {
      finalDeathPlayerIds:
        state.witchCheckpoint?.finalDeaths.map((death) => death.playerId) ?? [],
      voteOpened: false,
    },
  })
  appendEvent(state, environment, 'PHASE_CHANGED', {
    resolution: 'DAY',
    metadata: { from: 'NIGHT', to: 'DAY' },
  })
}

function openDayVote(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'DAY') {
    fail('Chỉ mở bỏ phiếu treo cổ vào ban ngày.')
  }
  if (state.dayVote) {
    fail('Mỗi Ngày chỉ có một lượt bỏ phiếu treo cổ.')
  }
  const openedAt = environment.now()
  state.dayVote = {
    status: 'OPEN',
    votes: {},
    openedAt,
    deadlineAt: openedAt + dayVoteDurationMs,
  }
  appendEvent(state, environment, 'DAY_VOTE_OPENED', {
    metadata: {
      durationMs: dayVoteDurationMs,
      deadlineAt: state.dayVote.deadlineAt,
    },
  })
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
  if (environment.now() >= state.dayVote.deadlineAt) {
    fail('Thời hạn bỏ phiếu ban ngày đã kết thúc.')
  }
  const player = state.players.find((entry) => entry.id === playerId)
  if (!player?.alive) {
    fail('Chỉ người chơi còn sống mới được bỏ phiếu.')
  }
  if (targetId !== null && !getEligibleDayTargets(state, playerId).includes(targetId)) {
    fail('Mục tiêu treo cổ không hợp lệ.')
  }
  const previousTargetId = state.dayVote.votes[playerId]
  const nextTargetId = previousTargetId === targetId ? null : targetId
  state.dayVote.votes[playerId] = nextTargetId
  appendEvent(state, environment, 'DAY_VOTE_CHANGED', {
    actorPlayerId: playerId,
    targetPlayerId: nextTargetId ?? undefined,
    metadata: { previousTargetId, abstain: nextTargetId === null },
  })
}

function closeDayVote(state: RoomState, environment: GameEnvironment): void {
  if (state.phase !== 'DAY' || !state.dayVote) {
    fail('Không có lượt bỏ phiếu ban ngày đang mở.')
  }
  if (state.dayVote.status === 'CLOSED') return
  const closedAt = environment.now()
  if (closedAt < state.dayVote.deadlineAt) {
    fail('Chưa hết 30 giây bỏ phiếu; Quản trò không thể chốt sớm.')
  }
  const livingIds = state.players
    .filter((player) => player.alive)
    .map((player) => player.id)
  const weights = Object.fromEntries(
    livingIds.map((playerId) => [
      playerId,
      getDayVoteWeight(getRoleIdForPlayer(state, playerId)),
    ]),
  )
  const result = resolveDayVote(
    state.dayVote.votes,
    livingIds,
    livingIds,
    weights,
  )
  state.dayVote.status = 'CLOSED'
  state.dayVote.closedAt = closedAt
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
  if (result.kind === 'UNIQUE') {
    const targetId = result.targetIds[0]
    const target = state.players.find((player) => player.id === targetId)
    if (!target?.alive) fail('Mục tiêu treo cổ không còn hợp lệ.')
    const effect = createDayHangingEffect(environment.nextId(), targetId)
    state.dayVote.hangingEffect = effect
    target.alive = false
    appendEvent(state, environment, 'DAY_HANGING_CREATED', {
      targetPlayerId: targetId,
      resolution: 'FINAL',
      metadata: {
        sourceType: effect.sourceType,
        protectorBlockable: false,
        witchInteractable: false,
      },
    })
    appendEvent(state, environment, 'PLAYER_DEATH', {
      targetPlayerId: targetId,
      resolution: 'DAY_HANGING',
      metadata: { sourceEffectId: effect.id },
    })
    applyDayHeartbreakConsequences(
      state,
      [{ playerId: targetId, sourceEffectIds: [effect.id] }],
      livingIds,
      environment,
    )
    if (getRoleIdForPlayer(state, targetId) === 'hunter') {
      state.dayVote.hunterRevenge = {
        hunterPlayerId: targetId,
        status: 'PENDING',
      }
      appendEvent(state, environment, 'HUNTER_HANGING_REVEALED', {
        actorRoleId: 'hunter',
        actorPlayerId: targetId,
        resolution: 'REVENGE_PENDING',
      })
    }
  }
}

function submitHunterRevenge(
  state: RoomState,
  playerId: PlayerId,
  targetId: PlayerId | null,
  environment: GameEnvironment,
): void {
  if (state.phase !== 'DAY' || state.dayVote?.status !== 'CLOSED') {
    fail('Phát bắn trả thù chỉ tồn tại sau kết quả treo cổ hiện tại.')
  }
  const revenge = state.dayVote.hunterRevenge
  if (!revenge || revenge.hunterPlayerId !== playerId) {
    fail('Chỉ Thợ Săn vừa bị treo cổ mới được trả thù.')
  }
  if (revenge.status === 'RESOLVED') {
    if (revenge.targetPlayerId === targetId) return
    fail('Phát bắn trả thù đã được giải quyết.')
  }
  if (targetId !== null) {
    const livingPlayerIdsBefore = state.players
      .filter((player) => player.alive)
      .map((player) => player.id)
    const target = state.players.find((player) => player.id === targetId)
    if (!target?.alive || target.id === playerId) {
      fail('Mục tiêu trả thù không hợp lệ.')
    }
    const effect = createHunterRevengeEffect(
      environment.nextId(),
      playerId,
      targetId,
    )
    target.alive = false
    revenge.effect = effect
    appendEvent(state, environment, 'PLAYER_DEATH', {
      actorPlayerId: playerId,
      actorRoleId: 'hunter',
      targetPlayerId: targetId,
      resolution: 'HUNTER_REVENGE_SHOT',
      metadata: { sourceEffectId: effect.id, protectorBlockable: false },
    })
    applyDayHeartbreakConsequences(
      state,
      [{ playerId: targetId, sourceEffectIds: [effect.id] }],
      livingPlayerIdsBefore,
      environment,
    )
  }
  revenge.status = 'RESOLVED'
  revenge.targetPlayerId = targetId
  revenge.resolvedAt = environment.now()
  appendEvent(state, environment, 'HUNTER_REVENGE_RESOLVED', {
    actorPlayerId: playerId,
    actorRoleId: 'hunter',
    targetPlayerId: targetId ?? undefined,
    resolution: targetId ? 'TARGET_KILLED' : 'NOBODY',
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
    applyFactionReconciliation(state, 'AFTER_DEATH', environment)
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
    case 'SUBMIT_SEER_INSPECTION':
      submitSeerInspection(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'ACKNOWLEDGE_SEER_RESULT':
      acknowledgeSeerResult(state, command.playerId, environment)
      break
    case 'SUBMIT_PROTECTOR_TARGET':
      submitProtectorTarget(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'SUBMIT_CUPID_PAIRING':
      submitCupidPairing(
        state,
        command.playerId,
        command.targetIds,
        environment,
      )
      break
    case 'ACKNOWLEDGE_LOVER_REVEAL':
      acknowledgePrivateLoverReveal(state, command.playerId, environment)
      break
    case 'CAST_HUNTER_PRELOCK':
      castHunterPrelock(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'CONFIRM_HUNTER_PRELOCK':
      confirmHunterPrelock(state, command.playerId, environment)
      break
    case 'SUBMIT_WITCH_DECISION':
      submitWitchDecision(
        state,
        command.playerId,
        command.resurrectionTargetId,
        command.poisonTargetId,
        environment,
      )
      break
    case 'RESOLVE_WOLF_VOTE':
      resolveWolfVote(state, command.atDeadline ?? false, environment)
      break
    case 'COMPLETE_NIGHT_CALL':
      completeNightCall(state, command.roleId, environment)
      break
    case 'RESOLVE_NIGHT_EFFECTS':
      resolveNightConsequences(state, environment)
      break
    case 'FINALIZE_NIGHT_CHECKPOINT':
      finalizeNightCheckpoint(state, environment)
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
    case 'SUBMIT_HUNTER_REVENGE':
      submitHunterRevenge(
        state,
        command.playerId,
        command.targetId,
        environment,
      )
      break
    case 'START_NEXT_NIGHT':
      if (state.phase === 'NIGHT') break
      startNight(state, environment)
      appendEvent(state, environment, 'NEXT_NIGHT_STARTED', {
        resolution: `NIGHT_${state.dayNumber}`,
        metadata: { automaticRoleCall: false },
      })
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
