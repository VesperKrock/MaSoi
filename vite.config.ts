import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/MaSoi/' : '/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
