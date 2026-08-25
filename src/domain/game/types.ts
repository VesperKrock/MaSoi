import type { RoleId } from '../roles/classic-catalog'

export type { RoleId } from '../roles/classic-catalog'
export type PlayerId = string
export type Phase = 'SETUP' | 'NIGHT' | 'DAY' | 'ENDED'
export type WolfPolicy = 'RANDOM_ON_TIE' | 'REVOTE_10S'
export type RoomLifecycle =
  | 'LOBBY'
  | 'ROLE_REVEAL'
  | 'IN_GAME'
  | 'FINISHED'

export interface Player {
  id: PlayerId
  seat: number
  alias: string
  alive: boolean
}

export interface RoleAssignment {
  playerId: PlayerId
  roleId: RoleId
}

export type NightCallStatus = 'NOT_CALLED' | 'CALLED' | 'COMPLETED'

export interface NightCall {
  roleId: RoleId
  status: NightCallStatus
  calledAt?: number
  completedAt?: number
}

export interface WolfActionDetails {
  round: 'INITIAL' | 'REVOTE'
  initialTiedTargetIds: PlayerId[]
  deadlineAt?: number
}

export interface FinalTargetResult {
  targetId: PlayerId | null
  random: boolean
  reason:
    | 'UNIQUE_TOP'
    | 'TIED_TOP_RANDOM'
    | 'ALL_ABSTAIN_RANDOM'
    | 'REVOTE_UNIQUE_TOP'
    | 'REVOTE_TIED_RANDOM'
    | 'REVOTE_ALL_ABSTAIN_RANDOM'
    | 'NO_ELIGIBLE_TARGET'
}

export interface NightAction {
  id: string
  roleId: RoleId
  kind: 'WOLF_VOTE' | 'SELECT_TARGET'
  status: 'OPEN' | 'COMPLETED' | 'CLOSED_BY_MODERATOR'
  eligibleActorIds: PlayerId[]
  eligibleTargetIds: PlayerId[]
  selections: Record<PlayerId, PlayerId | null>
  confirmedActorIds: PlayerId[]
  wolf?: WolfActionDetails
  seer?: {
    targetId: PlayerId
    result: 'WOLF' | 'NON_WOLF'
    acknowledged: boolean
  }
  result?: FinalTargetResult
  openedAt: number
  completedAt?: number
}

export interface NightState {
  number: number
  calls: NightCall[]
  activeRoleId: RoleId | null
  actionsByRole: Partial<Record<RoleId, NightAction>>
}

export interface DayVoteResult {
  kind: 'UNIQUE' | 'TIE' | 'NO_VOTES'
  targetIds: PlayerId[]
  counts: Record<PlayerId, number>
}

export interface DayVoteState {
  status: 'OPEN' | 'CLOSED'
  votes: Record<PlayerId, PlayerId | null>
  openedAt: number
  closedAt?: number
  result?: DayVoteResult
}

export type JournalEventType =
  | 'ROOM_CREATED'
  | 'PLAYER_JOINED'
  | 'ROOM_LOCKED'
  | 'ROLE_ASSIGNED'
  | 'ROLE_CALLED'
  | 'CALL_COMPLETED'
  | 'ROLE_ACTION_OPENED'
  | 'ROLE_ACTION_SUBMITTED'
  | 'TARGET_SELECTED'
  | 'WOLF_VOTE'
  | 'WOLF_ABSTAIN'
  | 'WOLF_TIE'
  | 'WOLF_REVOTE_STARTED'
  | 'WOLF_REVOTE_CHANGED'
  | 'WOLF_RANDOM_RESOLUTION'
  | 'WOLF_FINAL_TARGET'
  | 'SEER_INSPECTION'
  | 'SEER_RESULT_ACKNOWLEDGED'
  | 'PROTECTOR_INTENT'
  | 'DAY_VOTE_OPENED'
  | 'DAY_VOTE_CHANGED'
  | 'DAY_VOTE_CLOSED'
  | 'HANGING_RESULT'
  | 'PLAYER_DEATH'
  | 'MODERATOR_OVERRIDE'
  | 'PHASE_CHANGED'
  | 'FINAL_RESULT'
  | 'MATCH_ENDED'

export interface JournalEvent {
  id: string
  type: JournalEventType
  timestamp: number
  dayNumber: number
  phase: Phase
  actorPlayerId?: PlayerId
  actorRoleId?: RoleId
  targetPlayerId?: PlayerId
  resolution?: string
  metadata?: Record<string, unknown>
}

export interface RoomConfig {
  seatCount: number
  roleComposition: Partial<Record<RoleId, number>>
  wolfPolicy: WolfPolicy
  nightRoleIds: RoleId[]
  revoteDurationMs: number
}

export interface RoomState {
  schemaVersion: 2
  roomId: string
  roomCode: string
  revision: number
  createdAt: number
  lifecycle: RoomLifecycle
  phase: Phase
  dayNumber: number
  players: Player[]
  roleAssignments: RoleAssignment[]
  roleRevealConfirmedPlayerIds: PlayerId[]
  config: RoomConfig
  night: NightState | null
  dayVote: DayVoteState | null
  journal: JournalEvent[]
}

export type RoomCommand =
  | { type: 'RESET_ROOM'; playerCount: number; wolfPolicy: WolfPolicy }
  | { type: 'SET_WOLF_POLICY'; policy: WolfPolicy }
  | { type: 'JOIN_PLAYER'; playerId: PlayerId; name: string }
  | { type: 'LOCK_AND_ASSIGN_ROLES' }
  | { type: 'CONFIRM_ROLE_REVEAL'; playerId: PlayerId }
  | { type: 'START_NIGHT' }
  | { type: 'CALL_NIGHT_ROLE'; roleId: RoleId }
  | { type: 'CAST_WOLF_VOTE'; playerId: PlayerId; targetId: PlayerId | null }
  | { type: 'CONFIRM_NIGHT_ACTION'; playerId: PlayerId }
  | { type: 'SUBMIT_TARGET_ACTION'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'SUBMIT_SEER_INSPECTION'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'ACKNOWLEDGE_SEER_RESULT'; playerId: PlayerId }
  | { type: 'SUBMIT_PROTECTOR_TARGET'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'RESOLVE_WOLF_VOTE'; atDeadline?: boolean }
  | { type: 'COMPLETE_NIGHT_CALL'; roleId: RoleId }
  | { type: 'START_DAY' }
  | { type: 'OPEN_DAY_VOTE' }
  | { type: 'CAST_DAY_VOTE'; playerId: PlayerId; targetId: PlayerId | null }
  | { type: 'CLOSE_DAY_VOTE' }
  | {
      type: 'MODERATOR_SET_ALIVE'
      playerId: PlayerId
      alive: boolean
      reason?: string
    }
  | { type: 'END_MATCH' }
