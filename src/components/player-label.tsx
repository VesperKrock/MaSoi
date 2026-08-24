import type { Player } from '../domain/game/types'

export function playerLabel(player: Player): string {
  return `${String(player.seat).padStart(2, '0')} — ${player.alias}`
}
