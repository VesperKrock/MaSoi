import type { RoleId } from './classic-catalog'

export interface RoleDefinition {
  id: RoleId
  displayName: string
  team: 'WEREWOLF' | 'VILLAGE'
  cardAsset: string | null
  actsAtNight: boolean
  nightOrder: number | null
  firstNightOnly: boolean
  actionType: 'WOLF_VOTE' | 'SELECT_TARGET' | 'NONE'
  targetRule: 'LIVING_NON_WOLF' | 'LIVING_OTHER' | 'NONE'
  description: string
  instructions: string
}

export const roleDefinitions: Partial<Record<RoleId, RoleDefinition>> = {
  werewolf: {
    id: 'werewolf',
    displayName: 'Ma Sói',
    team: 'WEREWOLF',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 10,
    firstNightOnly: false,
    actionType: 'WOLF_VOTE',
    targetRule: 'LIVING_NON_WOLF',
    description: 'Thức dậy cùng bầy sói và chọn một nạn nhân.',
    instructions: 'Chọn một người hoặc không chọn. Phiếu trắng là trung lập.',
  },
  seer: {
    id: 'seer',
    displayName: 'Tiên Tri',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 20,
    firstNightOnly: false,
    actionType: 'SELECT_TARGET',
    targetRule: 'LIVING_OTHER',
    description: 'Mỗi đêm chọn một người để Quản trò kiểm tra.',
    instructions: 'Chọn một người rồi úp điện thoại xuống.',
  },
  villager: {
    id: 'villager',
    displayName: 'Dân Làng',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: false,
    nightOrder: null,
    firstNightOnly: false,
    actionType: 'NONE',
    targetRule: 'NONE',
    description: 'Cùng dân làng tìm ra Ma Sói.',
    instructions: 'Quan sát, thảo luận và bỏ phiếu vào ban ngày.',
  },
}

export function getNightRoleIds(roleIds: readonly RoleId[]): RoleId[] {
  return [...new Set(roleIds)]
    .filter((roleId) => roleDefinitions[roleId]?.actsAtNight)
    .sort(
      (left, right) =>
        (roleDefinitions[left]?.nightOrder ?? 0) -
        (roleDefinitions[right]?.nightOrder ?? 0),
    )
}
