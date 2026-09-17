/* Copyright 2013 - 2026 Waiterio LLC */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['public-tests/**/*.test.js'],
  },
})
