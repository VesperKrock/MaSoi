import type { RoleId } from '../roles/classic-catalog'
import type { PersistedNightResolution } from '../gameplay/night-resolution'
import type { FactionTransitionState } from '../gameplay/faction-transitions'
import type { CupidLoverState } from '../gameplay/lovers'
import type { MatchResult } from '../gameplay/global-win'
import type {
  WitchDecision,
  PersistedWitchCheckpoint,
  WitchResources,
} from '../gameplay/witch-checkpoint'

export type { RoleId } from '../roles/classic-catalog'
export type { PersistedNightResolution } from '../gameplay/night-resolution'
export type { CupidLoverState } from '../gameplay/lovers'
export type { MatchOutcome, MatchResult } from '../gameplay/global-win'
export type {
  WitchCheckpointResult,
  WitchDecision,
  PersistedWitchCheckpoint,
  WitchResources,
} from '../gameplay/witch-checkpoint'
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
  kind:
    | 'WOLF_VOTE'
    | 'SELECT_TARGET'
    | 'HUNTER_PRELOCK'
    | 'SERIAL_KILLER_ATTACK'
    | 'WITCH_DECISION'
    | 'CUPID_PAIRING'
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
  witch?: {
    resurrectionCandidateIds: PlayerId[]
    poisonCandidateIds: PlayerId[]
    resurrectionAvailable: boolean
    poisonAvailable: boolean
    attackedThisNight: boolean
    decision?: WitchDecision
  }
  cupid?: {
    selectedTargetIds: PlayerId[]
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
  deadlineAt: number
  closedAt?: number
  totals?: Record<PlayerId, number>
  result?: DayVoteResult
  hangingEffect?: DayEffect
  consequenceEffects?: DayEffect[]
  hunterRevenge?: HunterDayRevenge
}

export interface DayEffect {
  id: string
  sourceType:
    | 'DAY_HANGING'
    | 'HUNTER_REVENGE_SHOT'
    | 'LOVER_HEARTBREAK'
  sourceRoleId?: 'hunter' | 'cupid'
  actorPlayerId?: PlayerId
  sourcePlayerId?: PlayerId
  coupleId?: string
  category: 'DAY_LETHAL_EFFECT' | 'NON_VILLAIN_LETHAL_EFFECT'
  targetPlayerId: PlayerId
  lethal: true
  protectorBlockable: false
  witchInteractable?: false
  finalized: true
}

export interface HunterDayRevenge {
  hunterPlayerId: PlayerId
  status: 'PENDING' | 'RESOLVED'
  targetPlayerId?: PlayerId | null
  resolvedAt?: number
  effect?: DayEffect
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
  | 'WOLF_ATTACK_CREATED'
  | 'WOLF_ATTACK_BLOCKED'
  | 'WOLF_ATTACK_IMMUNE'
  | 'SERIAL_KILLER_TARGET_LOCKED'
  | 'SERIAL_KILLER_ATTACK_CREATED'
  | 'SERIAL_KILLER_ATTACK_BLOCKED'
  | 'NIGHT_DEATH_CANDIDATE_CREATED'
  | 'NIGHT_RESOLUTION_COMPLETED'
  | 'HUNTER_TARGET_LOCKED'
  | 'HUNTER_SHOT_CREATED'
  | 'HUNTER_SHOT_ACTIVATED'
  | 'HUNTER_SHOT_CANCELED'
  | 'HUNTER_SHOT_VICTIM_RESCUED'
  | 'WITCH_DECISION_SUBMITTED'
  | 'WITCH_RESURRECTION_USED'
  | 'WITCH_POISON_USED'
  | 'WITCH_CHECKPOINT_COMPLETED'
  | 'NIGHT_DEATH_FINALIZED'
  | 'MORNING_STARTED'
  | 'DAY_VOTE_OPENED'
  | 'DAY_VOTE_CHANGED'
  | 'DAY_VOTE_CLOSED'
  | 'HANGING_RESULT'
  | 'DAY_HANGING_CREATED'
  | 'HUNTER_HANGING_REVEALED'
  | 'HUNTER_REVENGE_RESOLVED'
  | 'NEXT_NIGHT_STARTED'
  | 'HALF_WOLF_BITE_SCHEDULED'
  | 'HALF_WOLF_TRANSFORMED'
  | 'HALF_WOLF_TRANSFORMATION_CANCELED'
  | 'TRAITOR_CONVERTED_TO_VILLAGE'
  | 'CUPID_PAIR_CREATED'
  | 'LOVER_REVEAL_ACKNOWLEDGED'
  | 'LOVER_HEARTBREAK_CREATED'
  | 'CUPID_OBJECTIVE_FALLBACK'
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
  nightResolution?: PersistedNightResolution | null
  witchResources?: WitchResources | null
  witchCheckpoint?: PersistedWitchCheckpoint | null
  dayVote: DayVoteState | null
  factionTransitions?: FactionTransitionState
  cupidLovers?: CupidLoverState
  matchResult?: MatchResult | null
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
  | { type: 'CAST_WOLF_VOTE'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'CONFIRM_NIGHT_ACTION'; playerId: PlayerId }
  | { type: 'SUBMIT_TARGET_ACTION'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'SUBMIT_SEER_INSPECTION'; playerId: PlayerId; targetId: PlayerId }
  | { type: 'ACKNOWLEDGE_SEER_RESULT'; playerId: PlayerId }
  | { type: 'SUBMIT_PROTECTOR_TARGET'; playerId: PlayerId; targetId: PlayerId }
  | {
      type: 'SUBMIT_CUPID_PAIRING'
      playerId: PlayerId
      targetIds: [PlayerId, PlayerId]
    }
  | { type: 'ACKNOWLEDGE_LOVER_REVEAL'; playerId: PlayerId }
  | {
      type: 'CAST_HUNTER_PRELOCK'
      playerId: PlayerId
      targetId: PlayerId | null
    }
  | { type: 'CONFIRM_HUNTER_PRELOCK'; playerId: PlayerId }
  | {
      type: 'CAST_SERIAL_KILLER_ATTACK'
      playerId: PlayerId
      targetId: PlayerId | null
    }
  | { type: 'CONFIRM_SERIAL_KILLER_ATTACK'; playerId: PlayerId }
  | { type: 'RESOLVE_WOLF_VOTE'; atDeadline?: boolean }
  | { type: 'COMPLETE_NIGHT_CALL'; roleId: RoleId }
  | { type: 'RESOLVE_NIGHT_EFFECTS' }
  | {
      type: 'SUBMIT_WITCH_DECISION'
      playerId: PlayerId
      resurrectionTargetId: PlayerId | null
      poisonTargetId: PlayerId | null
    }
  | { type: 'FINALIZE_NIGHT_CHECKPOINT' }
  | { type: 'START_DAY' }
  | { type: 'OPEN_DAY_VOTE' }
  | { type: 'CAST_DAY_VOTE'; playerId: PlayerId; targetId: PlayerId | null }
  | { type: 'CLOSE_DAY_VOTE' }
  | {
      type: 'SUBMIT_HUNTER_REVENGE'
      playerId: PlayerId
      targetId: PlayerId | null
    }
  | { type: 'START_NEXT_NIGHT' }
  | {
      type: 'MODERATOR_SET_ALIVE'
      playerId: PlayerId
      alive: boolean
      reason?: string
    }
