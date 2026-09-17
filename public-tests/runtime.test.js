/* Copyright 2013 - 2026 Waiterio LLC */

import { describe, expect, it } from 'vitest'

import { initTourRunner } from '../TourRunner.js'

describe('@tutorializer/tours public package', () => {
  it('initializes checked-in tour data in the browser', () => {
    const tours = {
      onboarding: {
        name: 'onboarding',
        steps: [],
      },
    }

    initTourRunner(tours)

    expect(window.tours).toBe(tours)
  })
})
