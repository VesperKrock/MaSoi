export interface RandomSource {
  pick<T>(values: readonly T[]): T
}

export const systemRandom: RandomSource = {
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error('Không thể chọn ngẫu nhiên từ danh sách rỗng.')
    }

    const buffer = new Uint32Array(1)
    crypto.getRandomValues(buffer)
    return values[buffer[0] % values.length]
  },
}

export function fixedRandom(index = 0): RandomSource {
  return {
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new Error('Không thể chọn ngẫu nhiên từ danh sách rỗng.')
      }
      return values[Math.min(index, values.length - 1)]
    },
  }
}
