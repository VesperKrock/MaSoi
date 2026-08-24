export type RoleMarketGroup =
  | 'VILLAGE'
  | 'WEREWOLF'
  | 'INDEPENDENT'
  | 'SPECIAL'

export type QuantityMode = 'MULTIPLE' | 'SINGLE'

export interface RoleCatalogEntryBase {
  id: string
  displayName: string
  assetFiles: readonly string[]
  marketGroup: RoleMarketGroup
  factionMeaning: string
  quantityMode: QuantityMode
  rulesText: string
  notes?: readonly string[]
  gameplaySupport: 'MS0A_IMPLEMENTED' | 'CATALOG_ONLY'
}

const assetRoot = '/assets/cards/classic/'

/**
 * Product Owner-approved Classic source of truth for MS-0B.
 *
 * The catalog deliberately contains exactly one identity per supplied JPG.
 * Quantity is setup metadata and is independent from the number of art files.
 */
export const classicRoleCatalog = [
  {
    id: 'villager',
    displayName: 'Dân Làng',
    assetFiles: ['Dân Làng.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'MULTIPLE',
    rulesText: 'Bạn là một Dân làng bình thường.',
    gameplaySupport: 'MS0A_IMPLEMENTED',
  },
  {
    id: 'protector',
    displayName: 'Bảo Vệ',
    assetFiles: ['Bảo Vệ.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'SINGLE',
    rulesText:
      'Mỗi đêm có thể bảo vệ một người. Không thể bảo vệ cùng một người hai đêm liên tiếp. Không thể bảo vệ Anh Hùng.',
    notes: ['Dangling reference: Anh Hùng không có trong bộ Classic hiện tại.'],
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'witch',
    displayName: 'Phù Thủy',
    assetFiles: ['Phù Thủy.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'SINGLE',
    rulesText:
      'Có một bình cứu và một bình giết. Bình cứu bị tiêu thụ dù mục tiêu nhận bảo vệ khác. Không thể dùng thuốc giết trong đêm đầu tiên.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'cupid',
    displayName: 'Thần Tình Yêu',
    assetFiles: ['Thần Tình Yêu.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng và Cặp Đôi',
    quantityMode: 'SINGLE',
    rulesText:
      'Trong đêm đầu tiên, chọn hai người làm tình nhân. Hai người sống chết có nhau.',
    notes: ['Faction Cặp Đôi chưa được áp vào win-condition enum.'],
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'mayor',
    displayName: 'Thị Trưởng',
    assetFiles: ['Thị Trưởng.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'SINGLE',
    rulesText:
      'Có hai phiếu bầu trong suốt trò chơi. Chỉ người chơi và Quản trò biết điều này.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'hunter',
    displayName: 'Thợ Săn',
    assetFiles: ['Thợ Săn.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'SINGLE',
    rulesText: 'Nếu chết, ngay lập tức chọn một người chết theo.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'seer',
    displayName: 'Tiên Tri',
    assetFiles: ['Tiên Tri.jpg'],
    marketGroup: 'VILLAGE',
    factionMeaning: 'Dân Làng',
    quantityMode: 'SINGLE',
    rulesText:
      'Mỗi đêm chọn một người để xem người đó là Ma Sói hay không.',
    gameplaySupport: 'MS0A_IMPLEMENTED',
  },
  {
    id: 'werewolf',
    displayName: 'Ma Sói',
    assetFiles: ['Ma Sói.jpg'],
    marketGroup: 'WEREWOLF',
    factionMeaning: 'Ma Sói',
    quantityMode: 'MULTIPLE',
    rulesText: 'Mỗi đêm, cùng các Ma Sói chọn một người để giết.',
    gameplaySupport: 'MS0A_IMPLEMENTED',
  },
  {
    id: 'traitor',
    displayName: 'Kẻ Phản Bội',
    assetFiles: ['Kẻ Phản Bội.jpg'],
    marketGroup: 'WEREWOLF',
    factionMeaning: 'Ma Sói',
    quantityMode: 'SINGLE',
    rulesText:
      'Thức dậy cùng Ma Sói và biết Ma Sói là ai nhưng không trực tiếp giết người. Tiên Tri soi vẫn ra Dân Làng.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'serial-killer',
    displayName: 'Sát Nhân Hàng Loạt',
    assetFiles: ['Sát Nhân Hàng Loạt.jpg'],
    marketGroup: 'INDEPENDENT',
    factionMeaning: 'Solo',
    quantityMode: 'SINGLE',
    rulesText:
      'Mỗi đêm có thể giết một người. Không thể bị Ma Sói giết.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'fool',
    displayName: 'Thằng Ngố',
    assetFiles: ['Thằng Ngố.jpg'],
    marketGroup: 'INDEPENDENT',
    factionMeaning: 'Thằng Ngố',
    quantityMode: 'SINGLE',
    rulesText:
      'Mục tiêu là lừa mọi người treo cổ mình. Nếu bị treo cổ, Thằng Ngố thắng.',
    gameplaySupport: 'CATALOG_ONLY',
  },
  {
    id: 'half-wolf',
    displayName: 'Bán Sói',
    assetFiles: ['Bán Sói.jpg'],
    marketGroup: 'SPECIAL',
    factionMeaning: 'Dân Làng hoặc Ma Sói',
    quantityMode: 'SINGLE',
    rulesText:
      'Bắt đầu là Dân Làng; nếu bị Ma Sói cắn thì trở thành Ma Sói.',
    notes: ['Transformation semantics được giữ nguyên, chưa triển khai.'],
    gameplaySupport: 'CATALOG_ONLY',
  },
] as const satisfies readonly RoleCatalogEntryBase[]

export type RoleId = (typeof classicRoleCatalog)[number]['id']
export type RoleCatalogEntry = (typeof classicRoleCatalog)[number]

export const classicRoleById = Object.fromEntries(
  classicRoleCatalog.map((entry) => [entry.id, entry]),
) as Record<RoleId, RoleCatalogEntry>

export const roleMarketGroupLabels: Record<RoleMarketGroup, string> = {
  VILLAGE: 'Phe Dân Làng',
  WEREWOLF: 'Phe Ma Sói',
  INDEPENDENT: 'Độc Lập',
  SPECIAL: 'Đặc Biệt / Chuyển Phe',
}

export const knownDanglingRoleReferences = [
  {
    displayName: 'Anh Hùng',
    referencedBy: ['protector'] as const,
  },
] as const

export function cardAssetUrl(filename: string): string {
  return `${assetRoot}${filename}`
}

export function canonicalRoleIdForAssetFilename(
  filename: string,
): RoleId | undefined {
  return classicRoleCatalog.find((entry) =>
    entry.assetFiles.some(
      (assetFilename) =>
        assetFilename.localeCompare(filename, 'vi', {
          sensitivity: 'accent',
        }) === 0,
    ),
  )?.id
}
