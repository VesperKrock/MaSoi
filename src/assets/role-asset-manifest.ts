import { publicAssetUrl } from '../lib/app-url'

/** Compatibility manifest for the three MS-0A mechanics.
 * The complete 12-role Classic source of truth lives in classic-catalog.ts.
 */
export const roleAssetManifest = {
  werewolf: publicAssetUrl('assets/cards/classic/Ma Sói.jpg'),
  seer: publicAssetUrl('assets/cards/classic/Tiên Tri.jpg'),
  villager: publicAssetUrl('assets/cards/classic/Dân Làng.jpg'),
} as const

export const backCardAsset: string | null = null
