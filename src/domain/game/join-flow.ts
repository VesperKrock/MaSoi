import type { RoomJoinability } from './room-setup'

export type JoinFlowState =
  | { step: 'CODE'; code: string; error?: string }
  | { step: 'NAME'; code: string; roomId: string; roomCode: string }

export function joinFlowAfterValidation(
  code: string,
  validation: RoomJoinability,
): JoinFlowState {
  if (!validation.joinable) {
    return { step: 'CODE', code, error: validation.message }
  }
  return {
    step: 'NAME',
    code,
    roomId: validation.roomId,
    roomCode: validation.roomCode,
  }
}
