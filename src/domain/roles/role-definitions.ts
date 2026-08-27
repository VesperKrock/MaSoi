import type { RoleId } from './classic-catalog'

export interface RoleDefinition {
  id: RoleId
  displayName: string
  team: 'WEREWOLF' | 'VILLAGE' | 'SOLO'
  cardAsset: string | null
  actsAtNight: boolean
  nightOrder: number | null
  firstNightOnly: boolean
  actionType:
    | 'WOLF_VOTE'
    | 'SELECT_TARGET'
    | 'HUNTER_PRELOCK'
    | 'SERIAL_KILLER_ATTACK'
    | 'WITCH_DECISION'
    | 'CUPID_PAIRING'
    | 'NONE'
  targetRule: 'LIVING_NON_WOLF' | 'LIVING_OTHER' | 'LIVING_ANY' | 'NONE'
  nightStage: 'PRE_WITCH' | 'FINAL_CHECKPOINT' | null
  description: string
  instructions: string
}

export const roleDefinitions: Partial<Record<RoleId, RoleDefinition>> = {
  cupid: {
    id: 'cupid',
    displayName: 'Thần Tình Yêu',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 5,
    firstNightOnly: true,
    actionType: 'CUPID_PAIRING',
    targetRule: 'LIVING_OTHER',
    nightStage: 'PRE_WITCH',
    description:
      'Đêm đầu tiên ghép đúng hai người yêu nhau; quan hệ không đổi role hay phe.',
    instructions:
      'Chọn đúng hai người còn sống, khác nhau và không phải chính bạn.',
  },
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
    nightStage: 'PRE_WITCH',
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
    nightStage: 'PRE_WITCH',
    description: 'Mỗi đêm chọn một người để Quản trò kiểm tra.',
    instructions: 'Chọn một người để kiểm tra.',
  },
  protector: {
    id: 'protector',
    displayName: 'Bảo Vệ',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 30,
    firstNightOnly: false,
    actionType: 'SELECT_TARGET',
    targetRule: 'LIVING_ANY',
    nightStage: 'PRE_WITCH',
    description: 'Mỗi đêm chọn một người để bảo vệ.',
    instructions: 'Chọn một người để bảo vệ đêm nay.',
  },
  'serial-killer': {
    id: 'serial-killer',
    displayName: 'Sát Nhân Hàng Loạt',
    team: 'SOLO',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 35,
    firstNightOnly: false,
    actionType: 'SERIAL_KILLER_ATTACK',
    targetRule: 'LIVING_OTHER',
    nightStage: 'PRE_WITCH',
    description:
      'Mỗi đêm chọn một người khác hoặc Không ai; đòn tấn công có thể bị Bảo Vệ chặn.',
    instructions:
      'Chọn một người còn sống khác hoặc Không ai, rồi xác nhận quyết định.',
  },
  hunter: {
    id: 'hunter',
    displayName: 'Thợ Săn',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 40,
    firstNightOnly: false,
    actionType: 'HUNTER_PRELOCK',
    targetRule: 'LIVING_OTHER',
    nightStage: 'PRE_WITCH',
    description:
      'Mỗi đêm khóa trước một mục tiêu hoặc Không ai; chỉ bắn nếu chết cuối Đêm.',
    instructions:
      'Khóa trước một người hoặc Không ai. Lựa chọn này chưa gây sát thương.',
  },
  witch: {
    id: 'witch',
    displayName: 'Phù Thủy',
    team: 'VILLAGE',
    cardAsset: null,
    actsAtNight: true,
    nightOrder: 50,
    firstNightOnly: false,
    actionType: 'WITCH_DECISION',
    targetRule: 'NONE',
    nightStage: 'FINAL_CHECKPOINT',
    description: 'Điểm kiểm tra cuối Đêm: cứu nạn nhân hiện tại và/hoặc dùng độc.',
    instructions: 'Có thể dùng tối đa một bình cứu và một bình độc theo luật hiện tại.',
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
    nightStage: null,
    description: 'Cùng dân làng tìm ra Ma Sói.',
    instructions: 'Quan sát, thảo luận và bỏ phiếu vào ban ngày.',
  },
}

export function getPreWitchNightRoleIds(
  roleIds: readonly RoleId[],
): RoleId[] {
  return getNightRoleIds(roleIds).filter(
    (roleId) => roleDefinitions[roleId]?.nightStage === 'PRE_WITCH',
  )
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
