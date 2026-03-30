import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['openclaw-web-api/tests/**/*.test.ts'],
    globals: true,
  },
})
