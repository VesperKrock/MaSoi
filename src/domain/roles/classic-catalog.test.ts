import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  canonicalRoleIdForAssetFilename,
  classicRoleCatalog,
  knownDanglingRoleReferences,
} from './classic-catalog'

const approvedAssetInventory = [
  'Bán Sói.jpg',
  'Bảo Vệ.jpg',
  'Dân Làng.jpg',
  'Kẻ Phản Bội.jpg',
  'Ma Sói.jpg',
  'Phù Thủy.jpg',
  'Sát Nhân Hàng Loạt.jpg',
  'Thần Tình Yêu.jpg',
  'Thằng Ngố.jpg',
  'Thị Trưởng.jpg',
  'Thợ Săn.jpg',
  'Tiên Tri.jpg',
].sort((left, right) => left.localeCompare(right, 'vi'))

describe('Classic canonical catalog', () => {
  it('matches the Product Owner-approved 12-JPG physical inventory exactly', () => {
    const assetDirectory = resolve(process.cwd(), 'public/assets/cards/classic')
    const physicalFiles = readdirSync(assetDirectory)
      .filter((filename) => filename.toLocaleLowerCase().endsWith('.jpg'))
      .sort((left, right) => left.localeCompare(right, 'vi'))
    const catalogFiles = classicRoleCatalog
      .flatMap((role) => [...role.assetFiles])
      .sort((left, right) => left.localeCompare(right, 'vi'))

    expect(physicalFiles).toEqual(approvedAssetInventory)
    expect(catalogFiles).toEqual(approvedAssetInventory)
    expect(
      physicalFiles.every((filename) =>
        canonicalRoleIdForAssetFilename(filename),
      ),
    ).toBe(true)
  })

  it('contains exactly 12 complete, unique role identities', () => {
    expect(classicRoleCatalog).toHaveLength(12)
    expect(new Set(classicRoleCatalog.map((role) => role.id)).size).toBe(12)
    expect(
      new Set(
        classicRoleCatalog.flatMap((role) => [...role.assetFiles]),
      ).size,
    ).toBe(12)

    for (const role of classicRoleCatalog) {
      expect(role.id).toBeTruthy()
      expect(role.displayName).toBeTruthy()
      expect(role.marketGroup).toBeTruthy()
      expect(role.factionMeaning).toBeTruthy()
      expect(role.quantityMode).toMatch(/^(MULTIPLE|SINGLE)$/)
      expect(role.rulesText).toBeTruthy()
      expect(role.assetFiles).toHaveLength(1)
    }
  })

  it('allows multiples only for Villager and Werewolf', () => {
    expect(
      classicRoleCatalog
        .filter((role) => role.quantityMode === 'MULTIPLE')
        .map((role) => role.id),
    ).toEqual(['villager', 'werewolf'])
    expect(
      classicRoleCatalog.filter((role) => role.quantityMode === 'SINGLE'),
    ).toHaveLength(10)
  })

  it('records only the dangling reference that remains on Bảo Vệ', () => {
    expect(knownDanglingRoleReferences).toEqual([
      { displayName: 'Anh Hùng', referencedBy: ['protector'] },
    ])
    expect(classicRoleCatalog.map((role) => role.displayName)).not.toContain(
      'Anh Hùng',
    )
  })
})
