import type {
  JournalEvent,
  JournalEventType,
  Phase,
  PlayerId,
  RoleId,
} from '../game/types'

export interface JournalContext {
  nextId: () => string
  now: () => number
}

export interface JournalEventInput {
  type: JournalEventType
  dayNumber: number
  phase: Phase
  actorPlayerId?: PlayerId
  actorRoleId?: RoleId
  targetPlayerId?: PlayerId
  resolution?: string
  metadata?: Record<string, unknown>
}

export function createJournalEvent(
  context: JournalContext,
  input: JournalEventInput,
): JournalEvent {
  return {
    id: context.nextId(),
    timestamp: context.now(),
    ...input,
  }
}
