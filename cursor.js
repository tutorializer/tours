/* Copyright 2013 - 2024 Waiterio LLC */
import translate from './translate.js'

let cursorX = 0
let cursorY = 0
let cursorElement = null
let hoveredElement = null
let focusedElement = null
let audioContext = null
let escapeHandler = null
let options = {}

const getSpeed = () => options.speed || 1

const CURSOR_TYPES = {
  arrow: {
    color: 'var(--color-orange, #f5a623)',
    textShadow: '0 0 2px white, 0 0 2px white',
    size: 36,
    svg: color => `
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.44 0 .66-.53.35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"
          fill="${color}" stroke="white" stroke-width="1.5" />
      </svg>`,
  },
  hand: {
    color: 'var(--color-orange, #f5a623)',
    textShadow: '0 0 2px white, 0 0 2px white',
    size: 40,
    svg: color => `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 1C10.9 1 10 1.9 10 3v8.2L7.7 8.9a1.5 1.5 0 1 0-2.1 2.1l6 6c.4.4.9.6 1.4.6h3.5c2.5 0 4.5-2 4.5-4.5V9c0-1.1-.9-2-2-2s-2 .9-2 2v-.5c0-1.1-.9-2-2-2s-2 .9-2 2V3c0-1.1-.9-2-2-2z"
          fill="${color}" stroke="var(--color-base)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>`,
  },
}

const getCursorType = () => {
  if (options.cursorType) return options.cursorType
  if (options.device === 'smartphone') return 'hand'
  return 'arrow'
}

const getCursorConfig = () =>
  CURSOR_TYPES[getCursorType()] || CURSOR_TYPES.arrow

const getAudioContext = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
  }
  return audioContext
}

export const warmupAudio = async () => {
  const ctx = getAudioContext()
  // Resume if suspended — don't block indefinitely since the iframe
  // may lack a user gesture, causing resume() to never resolve.
  if (ctx.state === 'suspended') {
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise(resolve => {
        setTimeout(resolve, 500)
      }),
    ])
  }
  // Play silent sound to warm up audio pipeline
  const oscillator = ctx.createOscillator()
  const gainNode = ctx.createGain()
  gainNode.gain.value = 0
  oscillator.connect(gainNode)
  gainNode.connect(ctx.destination)
  oscillator.start()
  oscillator.stop(ctx.currentTime + 0.01)
}

const playAppearSound = () =>
  new Promise(resolve => {
    const ctx = getAudioContext()

    // Ascending sparkle tones
    const frequencies = [600, 900, 1200]
    frequencies.forEach((freq, index) => {
      const oscillator = ctx.createOscillator()
      oscillator.type = 'sine'
      oscillator.frequency.value = freq

      const gainNode = ctx.createGain()
      const startTime = ctx.currentTime + index * 0.05
      gainNode.gain.setValueAtTime(0, startTime)
      gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.02)
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.15)

      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)

      oscillator.start(startTime)
      oscillator.stop(startTime + 0.15)
    })

    // Subtle shimmer noise
    const bufferSize = ctx.sampleRate * 0.1
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)

    for (let i = 0; i < bufferSize; i += 1) {
      const envelope = Math.sin((i / bufferSize) * Math.PI)
      data[i] = (Math.random() * 2 - 1) * envelope * 0.3
    }

    const noiseSource = ctx.createBufferSource()
    noiseSource.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 3000

    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.1

    noiseSource.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)

    noiseSource.start()

    // Resolve after sound completes (~250ms for sparkle tones)
    setTimeout(resolve, 250)
  })

const playPuffSound = () =>
  new Promise(resolve => {
    const ctx = getAudioContext()

    // Descending tone for "puff" effect
    const oscillator = ctx.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(400, ctx.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(
      100,
      ctx.currentTime + 0.15,
    )

    // Noise for the airy "puff"
    const bufferSize = ctx.sampleRate * 0.15
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)

    for (let i = 0; i < bufferSize; i += 1) {
      const envelope = Math.exp(-i / (bufferSize * 0.3))
      data[i] = (Math.random() * 2 - 1) * envelope
    }

    const noiseSource = ctx.createBufferSource()
    noiseSource.buffer = buffer

    // Filter for softer noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1500

    // Gain nodes
    const oscGain = ctx.createGain()
    oscGain.gain.setValueAtTime(0.2, ctx.currentTime)
    oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15)

    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.3

    // Connect oscillator
    oscillator.connect(oscGain)
    oscGain.connect(ctx.destination)

    // Connect noise
    noiseSource.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)

    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.15)
    noiseSource.start()

    // Resolve after sound completes
    setTimeout(resolve, 150)
  })

const playClickSound = () =>
  new Promise(resolve => {
    const ctx = getAudioContext()
    const bufferSize = ctx.sampleRate * 0.015 // 15ms
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)

    // Generate noise burst for click
    for (let i = 0; i < bufferSize; i += 1) {
      const envelope = Math.exp(-i / (bufferSize * 0.1))
      data[i] = (Math.random() * 2 - 1) * envelope
    }

    const noiseSource = ctx.createBufferSource()
    noiseSource.buffer = buffer

    // Filter to shape the click sound
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 2000
    filter.Q.value = 1

    const gainNode = ctx.createGain()
    gainNode.gain.value = 0.4

    noiseSource.connect(filter)
    filter.connect(gainNode)
    gainNode.connect(ctx.destination)

    noiseSource.start()

    // Resolve after sound completes
    setTimeout(resolve, 15)
  })

const showText = ({
  text,
  fontStyle,
  transformStart,
  transformEnd,
  duration = 1500,
  fadeOpacity = true,
}) =>
  new Promise(resolve => {
    const effectiveDuration = duration / getSpeed()
    const textElement = document.createElement('div')
    textElement.textContent = text
    textElement.style.position = 'absolute'
    textElement.style.left = `${cursorX + 20}px`
    textElement.style.top = `${cursorY}px`
    textElement.style.zIndex = '999999'
    textElement.style.pointerEvents = 'none'
    textElement.style.fontWeight = 'bold'
    textElement.style.fontSize = '14px'
    textElement.style.color = getCursorConfig().color
    textElement.style.textShadow = getCursorConfig().textShadow
    textElement.style.opacity = '1'
    textElement.style.transition = `opacity ${effectiveDuration}ms ease, transform ${effectiveDuration}ms ease`
    textElement.style.transform = transformStart

    if (fontStyle) {
      textElement.style.fontStyle = fontStyle
    }

    document.body.appendChild(textElement)

    requestAnimationFrame(() => {
      if (fadeOpacity) {
        textElement.style.opacity = '0'
      }
      textElement.style.transform = transformEnd
    })

    setTimeout(() => {
      textElement.remove()
      resolve()
    }, effectiveDuration)
  })

const showClickText = () => {
  const key = options.device === 'smartphone' ? 'Tap' : 'Click'
  return showText({
    text: translate(key, options.language),
    transformStart: 'translateY(0)',
    transformEnd: 'translateY(-20px)',
  })
}

const showPuffText = () =>
  showText({
    text: translate('Pufff', options.language),
    fontStyle: 'italic',
    transformStart: 'scale(1)',
    transformEnd: 'scale(1.5)',
  })

const showWatchMeText = (entranceText = 'Watch me') =>
  new Promise(resolve => {
    const text = translate(entranceText, options.language)
    const textElement = document.createElement('div')
    textElement.textContent = text
    textElement.style.position = 'absolute'
    textElement.style.left = `${cursorX + 28}px`
    textElement.style.top = `${cursorY - 4}px`
    textElement.style.zIndex = '999999'
    textElement.style.pointerEvents = 'none'
    textElement.style.fontWeight = 'bold'
    textElement.style.fontSize = '14px'
    textElement.style.color = getCursorConfig().color
    textElement.style.textShadow = getCursorConfig().textShadow
    textElement.style.opacity = '0'
    textElement.style.transform = 'translateX(-8px) scale(0.5)'
    textElement.style.transition =
      'opacity 300ms ease-out, transform 350ms cubic-bezier(0.25, 0, 0.2, 1)'

    document.body.appendChild(textElement)

    // Scale up overshooting to 1.3
    requestAnimationFrame(() => {
      textElement.style.opacity = '1'
      textElement.style.transform = 'translateX(0) scale(1.3)'
    })

    // Settle back to 1.0
    setTimeout(() => {
      textElement.style.transition =
        'transform 250ms cubic-bezier(0.25, 1, 0.5, 1)'
      textElement.style.transform = 'translateX(0) scale(1)'
    }, 350 / getSpeed())

    // Hold, then fade out upward
    setTimeout(() => {
      textElement.style.transition =
        'opacity 400ms ease-in, transform 400ms ease-in'
      textElement.style.opacity = '0'
      textElement.style.transform = 'translateY(-12px) scale(0.9)'

      setTimeout(() => {
        textElement.remove()
        resolve()
      }, 400 / getSpeed())
    }, 1200 / getSpeed())
  })

export const pause = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

export const setOptions = newOptions => {
  options = newOptions || {}
}

export const getOptions = () => options

// Build the cursor DOM node. Extracted so the deliberate entrance (showCursor)
// and the silent mid-tour recovery (ensureCursor) create an identical element.
const createCursorElement = () => {
  const element = document.createElement('div')
  element.id = 'cursor'
  element.style.position = 'absolute'
  element.style.left = '0px'
  element.style.top = '0px'
  element.style.willChange = 'transform'
  const cursorConfig = getCursorConfig()
  element.style.width = `${cursorConfig.size}px`
  element.style.height = `${cursorConfig.size}px`
  element.style.zIndex = '999999'
  element.style.pointerEvents = 'none'
  element.innerHTML = cursorConfig.svg(cursorConfig.color)
  return element
}

// Guarantee the cursor exists in the CURRENT document before any operation that
// dereferences it. A full page load inside the app iframe — the tutorial login
// chain does logout -> autosubmit login -> destination — replaces the JS realm,
// so the module-level cursorElement resets to null in the document that then
// answers the next tour step. moveCursor/clickCursor/dragCursor would throw
// "Cannot read properties of null (reading 'animate')" and fail the tour at its
// first cursor-touching step (observed: step 2 "click #navigation-reminders").
// Rebuild it silently — no entrance animation or sound, those belong to the
// deliberate showCursor at tour start — at the last known position, so the tour
// continues on the page it navigated to.
//
// isConnected also catches a stale handle: an element created in a document that
// has since been replaced is rebuilt in the live one rather than animated where
// nobody can see it.
export const ensureCursor = () => {
  if (cursorElement && cursorElement.isConnected) {
    return cursorElement
  }
  cursorElement = createCursorElement()
  cursorElement.style.transform = `translate(${cursorX}px, ${cursorY}px)`
  cursorElement.style.opacity = '1'
  document.body.appendChild(cursorElement)
  return cursorElement
}

export const showCursor = async (x, y) => {
  if (!(x && y)) {
    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight
    x = windowWidth / 2
    y = windowHeight * 0.75
  }

  cursorX = x
  cursorY = y

  if (cursorElement && cursorElement.isConnected) {
    cursorElement.style.transform = `translate(${x}px, ${y}px)`
    return
  }

  const entrance = options.entrance !== undefined ? options.entrance : true

  const cursorConfig = getCursorConfig()
  cursorElement = createCursorElement()

  // Add escape key handler to stop tour
  escapeHandler = event => {
    if (event.key === 'Escape' && window.stopTutorial) {
      window.stopTutorial()
    }
  }
  document.addEventListener('keydown', escapeHandler)

  if (entrance === false) {
    // Skip entrance animation — just show cursor immediately
    cursorElement.style.transform = `translate(${x}px, ${y}px)`
    cursorElement.style.opacity = '1'
    document.body.appendChild(cursorElement)
    return
  }

  cursorElement.style.transform = `translate(${x}px, ${y}px) scale(0)`
  cursorElement.style.opacity = '0'
  cursorElement.style.filter = `drop-shadow(0 0 0px ${cursorConfig.color})`
  document.body.appendChild(cursorElement)

  // Entrance animation: scale up with glow + sound simultaneously, then settle
  const entranceAnimation = new Promise(resolve => {
    requestAnimationFrame(() => {
      cursorElement.style.transition =
        'transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1), ' +
        'opacity 300ms ease-out, ' +
        'filter 500ms ease-out'
      cursorElement.style.transform = `translate(${x}px, ${y}px) scale(1.3)`
      cursorElement.style.opacity = '1'
      cursorElement.style.filter = `drop-shadow(0 0 12px ${cursorConfig.color})`

      setTimeout(() => {
        cursorElement.style.transition =
          'transform 300ms cubic-bezier(0.25, 1, 0.5, 1), filter 400ms ease-out'
        cursorElement.style.transform = `translate(${x}px, ${y}px) scale(1)`
        cursorElement.style.filter = `drop-shadow(0 0 0px ${cursorConfig.color})`

        setTimeout(() => {
          cursorElement.style.transition = ''
          cursorElement.style.filter = ''
          resolve()
        }, 400 / getSpeed())
      }, 500 / getSpeed())
    })
  })

  await Promise.all([entranceAnimation, playAppearSound()])
  await pause(300 / getSpeed())

  // Show entrance text: custom string or default "Watch me", skip if entrance is not a truthy string and not true
  const entranceText = typeof entrance === 'string' ? entrance : 'Watch me'
  await showWatchMeText(entranceText)
}

const clearHover = () => {
  if (hoveredElement) {
    hoveredElement.removeAttribute('data-cursor-hover')
    hoveredElement.dispatchEvent(
      new MouseEvent('mouseleave', { bubbles: true, cancelable: true }),
    )
    hoveredElement = null
  }
}

const triggerHover = element => {
  if (hoveredElement && hoveredElement !== element) {
    clearHover()
  }

  hoveredElement = element
  element.setAttribute('data-cursor-hover', 'true')
  element.dispatchEvent(
    new MouseEvent('mouseenter', { bubbles: true, cancelable: true }),
  )
  element.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
  )
}

const clearFocus = () => {
  if (focusedElement) {
    focusedElement.removeAttribute('data-cursor-focus')
    focusedElement = null
  }
}

const triggerFocus = element => {
  if (focusedElement && focusedElement !== element) {
    clearFocus()
  }

  focusedElement = element
  element.setAttribute('data-cursor-focus', 'true')
}

const easeOutCubic = t => 1 - (1 - t) ** 3

const quadraticBezier = (t, p0, p1, p2) => {
  const mt = 1 - t
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2
}

const getArcControlPoint = (x0, y0, x1, y1) => {
  const dx = x1 - x0
  const dy = y1 - y0
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance < 50) {
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
  }

  const arcHeight = Math.min(Math.max(distance * 0.3, 15), 225)

  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2

  // Perpendicular direction to movement vector
  let px = -dy / distance
  let py = dx / distance

  // Ensure arc curves in the direction of vertical movement:
  // upward when going up, downward when going down
  if (py * dy < 0) {
    px = -px
    py = -py
  }

  return { cx: mx + px * arcHeight, cy: my + py * arcHeight }
}

export const moveCursor = (
  xDestination,
  yDestination,
  scale = 1,
  straight = false,
) =>
  new Promise(resolve => {
    clearHover()
    ensureCursor()

    const xStart = cursorX
    const yStart = cursorY

    cursorX = xDestination
    cursorY = yDestination

    const dx = xDestination - xStart
    const dy = yDestination - yStart
    const distance = Math.sqrt(dx * dx + dy * dy)

    // Scale duration with distance: 800ms base, grows for longer moves
    const duration = Math.min(800 + distance * 0.8, 2500) / getSpeed()

    if (distance === 0) {
      // Even on a no-op move, normalize the inline transform so callers that
      // animate scale (e.g. dragCursor pressing the cursor down) get a
      // predictable final style.
      cursorElement.style.transform = `translate(${xDestination}px, ${yDestination}px) scale(${scale})`
      resolve()
      return
    }

    // For drag motions a straight line reads as "dragging across"; the arc
    // path is only natural for free-cursor moves between clicks.
    const { cx, cy } = straight
      ? { cx: (xStart + xDestination) / 2, cy: (yStart + yDestination) / 2 }
      : getArcControlPoint(xStart, yStart, xDestination, yDestination)

    // Use Web Animations API (runs on compositor thread, smooth under load)
    const numKeyframes = 20
    const keyframes = []
    for (let i = 0; i <= numKeyframes; i += 1) {
      const rawT = i / numKeyframes
      const t = easeOutCubic(rawT)
      const x = quadraticBezier(t, xStart, cx, xDestination)
      const y = quadraticBezier(t, yStart, cy, yDestination)
      keyframes.push({ transform: `translate(${x}px, ${y}px) scale(${scale})` })
    }

    const animation = cursorElement.animate(keyframes, {
      duration,
      easing: 'linear', // easing already baked into keyframe positions
      fill: 'forwards',
    })

    animation.onfinish = () => {
      cursorElement.style.transform = `translate(${xDestination}px, ${yDestination}px) scale(${scale})`
      animation.cancel()
      resolve()
    }
  })

// Resolve once an element's viewport position has stopped changing (scroll
// settled + layout shifts done), or after a safety timeout. Prevents the
// cursor from being positioned against a still-moving target.
export const waitForRectStable = (
  element,
  { frames = 3, timeout = 1200 } = {},
) =>
  new Promise(resolve => {
    let lastTop = null
    let lastLeft = null
    let stable = 0
    let elapsed = 0

    const tick = () => {
      const r = element.getBoundingClientRect()
      if (
        lastTop !== null &&
        Math.abs(r.top - lastTop) < 0.5 &&
        Math.abs(r.left - lastLeft) < 0.5
      ) {
        stable += 1
        if (stable >= frames) {
          resolve()
          return
        }
      } else {
        stable = 0
      }
      lastTop = r.top
      lastLeft = r.left
      elapsed += 16
      if (elapsed >= timeout) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })

export const moveToSelector = async selector => {
  // Find all matching elements and pick the first visible one
  const elements = document.querySelectorAll(selector)
  let element = null

  // Find the first element with non-zero dimensions (visible)
  Array.from(elements).some(el => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      element = el
      return true
    }
    return false
  })

  if (!element) {
    console.warn(
      `moveToSelector: no visible element found for selector "${selector}"`,
    )
    return
  }

  // Wait for the element to stop moving before reading its position. The
  // cursor is positioned in viewport coordinates but lives on document.body,
  // so it does NOT follow the app's inner scroll container — if we read the
  // rect while a scroll animation is still running or the freshly-navigated
  // page is still laying out, the cursor gets pinned to a stale spot (e.g.
  // over the Quotes row instead of the guest-name input) while the element
  // settles elsewhere. Re-read the rect only once it's stable.
  await waitForRectStable(element)
  const rect = element.getBoundingClientRect()

  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height * 0.75

  await moveCursor(x, y)
  triggerHover(element)
}

// Helper to find first visible element matching selector
const findVisibleElement = selector => {
  const elements = document.querySelectorAll(selector)
  let found = null
  Array.from(elements).some(el => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      found = el
      return true
    }
    return false
  })
  return found
}

export const clickCursor = async selector => {
  // Prefer finding the element by selector (resilient to position changes
  // during cursor animation, e.g. from React re-renders shifting layout).
  // Fall back to elementFromPoint for backward compatibility.
  let element = selector ? findVisibleElement(selector) : null
  element ||= document.elementFromPoint(cursorX, cursorY)

  if (!element) {
    console.warn('clickCursor: no element found at cursor position')
    return
  }

  ensureCursor()

  const eventOptions = {
    bubbles: true,
    cancelable: true,
    clientX: cursorX,
    clientY: cursorY,
    button: 0,
  }

  // Click animation: press down, ripple, release
  const clickAnimation = new Promise(resolve => {
    // Press down
    cursorElement.style.transition =
      'transform 100ms cubic-bezier(0.4, 0, 1, 1)'
    cursorElement.style.transform = `translate(${cursorX}px, ${cursorY}px) scale(0.75)`

    // Spawn ripple
    const ripple = document.createElement('div')
    ripple.style.position = 'absolute'
    ripple.style.left = `${cursorX}px`
    ripple.style.top = `${cursorY}px`
    ripple.style.width = '0px'
    ripple.style.height = '0px'
    ripple.style.borderRadius = '50%'
    ripple.style.border = `2px solid ${getCursorConfig().color}`
    ripple.style.opacity = '0.8'
    ripple.style.pointerEvents = 'none'
    ripple.style.zIndex = '999998'
    ripple.style.transform = 'translate(-50%, -50%)'
    ripple.style.transition =
      'width 400ms ease-out, height 400ms ease-out, opacity 400ms ease-out'
    document.body.appendChild(ripple)

    requestAnimationFrame(() => {
      ripple.style.width = '40px'
      ripple.style.height = '40px'
      ripple.style.opacity = '0'
    })

    setTimeout(() => {
      ripple.remove()
    }, 400)

    // Release back up with bounce
    setTimeout(() => {
      cursorElement.style.transition =
        'transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1)'
      cursorElement.style.transform = `translate(${cursorX}px, ${cursorY}px) scale(1)`

      setTimeout(() => {
        cursorElement.style.transition = ''
        resolve()
      }, 250)
    }, 100)
  })

  element.dispatchEvent(new MouseEvent('mousedown', eventOptions))
  element.dispatchEvent(new MouseEvent('mouseup', eventOptions))
  element.dispatchEvent(new MouseEvent('click', eventOptions))

  // If clicking on an input/textarea, focus it and show focus style
  const inputElement = element.closest('input, textarea')
  if (inputElement) {
    inputElement.focus()
    triggerFocus(inputElement)
  }

  await Promise.all([clickAnimation, playClickSound(), showClickText()])
}

// Visual-only click: plays sound and shows "Click" text without dispatching DOM events.
// Used by the upload action to avoid triggering the file picker dialog.
export const clickCursorVisualOnly = async () => {
  await Promise.all([playClickSound(), showClickText()])
}

const createFallbackDataTransfer = () => {
  const values = new Map()
  const types = []

  return {
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [],
    items: [],
    types,
    clearData(format) {
      if (format) {
        values.delete(format)
        const index = types.indexOf(format)
        if (index !== -1) types.splice(index, 1)
      } else {
        values.clear()
        types.splice(0)
      }
    },
    getData: format => values.get(format) || '',
    setData(format, value) {
      if (!values.has(format)) types.push(format)
      values.set(format, String(value))
    },
    setDragImage() {},
  }
}

const createDataTransfer = () => {
  try {
    return new DataTransfer()
  } catch {
    return createFallbackDataTransfer()
  }
}

const dispatchDragEvent = (element, type, options, dataTransfer) => {
  let event

  try {
    event = new DragEvent(type, { ...options, dataTransfer })
  } catch {
    event = new MouseEvent(type, options)
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  }

  element.dispatchEvent(event)
}

// Simulate both pointer and native HTML drag-and-drop from one element to
// another. The pointer sequence keeps calendar-style React interactions
// working; DragEvent + DataTransfer supports standard draggable product UIs.
//   mousedown on start → cursor animates (scaled-down, "pressed") to end →
//   mousemove + mouseover (with relatedTarget set to start so React fires
//   onMouseEnter on the end cell) → mouseup on end (bubbles, so any
//   onMouseUp on an ancestor fires too). Cursor stays scaled 0.85 throughout
//   the drag so the viewer reads it as a held click, not a teleport.
export const dragCursor = async (startSelector, endSelector) => {
  const startElement = findVisibleElement(startSelector)
  const endElement = findVisibleElement(endSelector)
  if (!startElement || !endElement) {
    console.warn(
      `dragCursor: missing element(s) for "${startSelector}" → "${endSelector}"`,
    )
    return
  }

  const speed = getSpeed()
  const startRect = startElement.getBoundingClientRect()
  const endRect = endElement.getBoundingClientRect()
  const startX = startRect.left + startRect.width / 2
  const startY = startRect.top + startRect.height / 2
  const endX = endRect.left + endRect.width / 2
  const endY = endRect.top + endRect.height / 2
  const dataTransfer = createDataTransfer()

  await moveCursor(startX, startY)
  await pause(200 / speed)

  startElement.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: startX,
      clientY: startY,
      button: 0,
      buttons: 1,
    }),
  )
  dispatchDragEvent(
    startElement,
    'dragstart',
    {
      bubbles: true,
      cancelable: true,
      clientX: startX,
      clientY: startY,
      button: 0,
      buttons: 1,
    },
    dataTransfer,
  )

  // Press the cursor down visually. Clear the transition before moveCursor
  // takes over via the Web Animations API — leaving a CSS transition on the
  // element while WAAPI animates the same property can cause a visible jump.
  cursorElement.style.transition = 'transform 100ms cubic-bezier(0.4, 0, 1, 1)'
  cursorElement.style.transform = `translate(${startX}px, ${startY}px) scale(0.85)`
  await pause(150 / speed)
  cursorElement.style.transition = ''

  // Yield so React flushes the mousedown's setState (begin drag) before we
  // dispatch mouseover on the end element — the end cell's onMouseEnter
  // handler reads drag from closure and bails when drag is still null.
  await pause(0)

  // Move with scale baked into the keyframes so the cursor stays "pressed"
  // for the entire drag animation. Without this moveCursor would override the
  // inline scale via WAAPI keyframes that only specify translate().
  // Use a straight-line path (not the arc used between clicks) so the motion
  // reads as a drag from check-in cell to check-out cell.
  await moveCursor(endX, endY, 0.85, true)

  // React's EnterLeaveEventPlugin only fires onMouseEnter on the end element
  // when it sees BOTH a mouseout from the previous element AND a mouseover
  // on the new one — a lone mouseover with relatedTarget doesn't trigger the
  // synthesis. We dispatch the pair so React fires onMouseEnter on the end
  // cell and the calendar's drag.endIndex actually updates to the end day.
  startElement.dispatchEvent(
    new MouseEvent('mouseout', {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      relatedTarget: endElement,
      buttons: 1,
    }),
  )

  endElement.dispatchEvent(
    new MouseEvent('mouseover', {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      relatedTarget: startElement,
      buttons: 1,
    }),
  )

  dispatchDragEvent(
    endElement,
    'dragenter',
    {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      buttons: 1,
    },
    dataTransfer,
  )
  dispatchDragEvent(
    endElement,
    'dragover',
    {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      buttons: 1,
    },
    dataTransfer,
  )

  await pause(120 / speed)

  dispatchDragEvent(
    endElement,
    'drop',
    {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      button: 0,
      buttons: 0,
    },
    dataTransfer,
  )

  endElement.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: endX,
      clientY: endY,
      button: 0,
      buttons: 0,
    }),
  )
  dispatchDragEvent(
    startElement,
    'dragend',
    {
      bubbles: true,
      cancelable: false,
      clientX: endX,
      clientY: endY,
      button: 0,
      buttons: 0,
    },
    dataTransfer,
  )

  cursorElement.style.transition =
    'transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1)'
  cursorElement.style.transform = `translate(${endX}px, ${endY}px) scale(1)`
  await pause(250 / speed)
  cursorElement.style.transition = ''
}

export const uploadFileCursor = async (fileContent, fileName = 'data.csv') => {
  const file = new File([fileContent], fileName, { type: 'text/csv' })

  if (window.mockFileUpload) {
    await window.mockFileUpload(file)
  } else {
    console.warn('uploadFileCursor: window.mockFileUpload not available')
  }
}

export const hideCursor = async ({ silent } = {}) => {
  clearHover()
  clearFocus()

  // Remove escape key handler
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }

  if (cursorElement) {
    cursorElement.remove()
    cursorElement = null
    if (!silent) {
      await Promise.all([playPuffSound(), showPuffText()])
    }
  }
}

export const waitForSelector = (selector, timeout = 10000) =>
  new Promise(resolve => {
    const startTime = Date.now()

    const check = () => {
      const element = findVisibleElement(selector)

      if (element) {
        resolve(element)
        return
      }

      if (Date.now() - startTime >= timeout) {
        console.warn(
          `waitForSelector: timeout waiting for "${selector}" after ${timeout}ms`,
        )
        resolve(null)
        return
      }

      requestAnimationFrame(check)
    }

    check()
  })

export const scrollToSelector = async selector => {
  const element = findVisibleElement(selector)

  if (!element) {
    console.warn(
      `scrollToSelector: no visible element found for selector "${selector}"`,
    )
    return
  }

  const rect = element.getBoundingClientRect()
  const isInViewport =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth

  if (!isInViewport) {
    // Instant, not smooth: a smooth-scroll animation is often still running
    // when the cursor gets positioned at the tour's fast playback speed,
    // which pins the cursor to a stale mid-scroll position.
    element.scrollIntoView({
      block: 'center',
      inline: 'center',
    })
  }

  // Wait for the scroll (and any post-navigation layout shift) to settle so
  // callers read a final, stable position.
  await waitForRectStable(element)
}

export const highlightElement = selector =>
  new Promise(resolve => {
    const element = findVisibleElement(selector)
    if (!element) {
      console.warn(
        `highlightElement: no visible element found for selector "${selector}"`,
      )
      resolve()
      return
    }
    const rect = element.getBoundingClientRect()
    const padding = 4
    const highlight = document.createElement('div')
    highlight.style.position = 'fixed'
    highlight.style.left = `${rect.left - padding}px`
    highlight.style.top = `${rect.top - padding}px`
    highlight.style.width = `${rect.width + padding * 2}px`
    highlight.style.height = `${rect.height + padding * 2}px`
    highlight.style.border = `3px solid ${getCursorConfig().color}`
    highlight.style.borderRadius = '4px'
    highlight.style.zIndex = '999998'
    highlight.style.pointerEvents = 'none'
    highlight.style.opacity = '0'
    highlight.style.transition = 'opacity 300ms ease'
    highlight.style.boxSizing = 'border-box'
    document.body.appendChild(highlight)
    requestAnimationFrame(() => {
      highlight.style.opacity = '1'
    })
    setTimeout(() => {
      highlight.style.opacity = '0'
      setTimeout(() => {
        highlight.remove()
        resolve()
      }, 300)
    }, 1000)
  })

const playTypeSound = () =>
  new Promise(resolve => {
    const ctx = getAudioContext()
    const bufferSize = ctx.sampleRate * 0.008 // 8ms
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)

    // Generate a soft click for typing
    for (let i = 0; i < bufferSize; i += 1) {
      const envelope = Math.exp(-i / (bufferSize * 0.15))
      data[i] = (Math.random() * 2 - 1) * envelope * 0.3
    }

    const noiseSource = ctx.createBufferSource()
    noiseSource.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 1500

    const gainNode = ctx.createGain()
    gainNode.gain.value = 0.15

    noiseSource.connect(filter)
    filter.connect(gainNode)
    gainNode.connect(ctx.destination)

    noiseSource.start()

    setTimeout(resolve, 8)
  })

/* eslint-disable camelcase */
const reconstructWords = alignment => {
  if (!alignment || !alignment.characters) {
    return []
  }

  const {
    characters,
    character_start_times_seconds,
    character_end_times_seconds,
  } = alignment
  const words = []
  let currentWord = ''
  let wordStart = null

  for (let i = 0; i < characters.length; i += 1) {
    const char = characters[i]
    const charStart = character_start_times_seconds[i]

    if (char === ' ' || char === '\n' || char === '\t') {
      if (currentWord) {
        words.push({
          word: currentWord,
          start: wordStart,
          end: character_end_times_seconds[i - 1],
        })
        currentWord = ''
        wordStart = null
      }
    } else {
      if (wordStart === null) {
        wordStart = charStart
      }
      currentWord += char
    }
  }

  if (currentWord) {
    words.push({
      word: currentWord,
      start: wordStart,
      end: character_end_times_seconds[characters.length - 1],
    })
  }

  return words
}
/* eslint-enable camelcase */

export const showOverlayWithKaraoke = (audioBase64, alignment) =>
  new Promise(resolve => {
    const words = reconstructWords(alignment)
    if (!words.length) {
      resolve()
      return
    }

    // Create overlay
    const overlay = document.createElement('div')
    overlay.style.position = 'fixed'
    overlay.style.inset = '0'
    overlay.style.zIndex = '999999'
    overlay.style.display = 'flex'
    overlay.style.alignItems = 'center'
    overlay.style.justifyContent = 'center'
    overlay.style.opacity = '0'
    overlay.style.transition = 'opacity 300ms ease'
    overlay.style.pointerEvents = 'none'

    // Text container — calc keeps 16px side margins on narrow viewports
    const container = document.createElement('div')
    container.style.maxWidth = 'min(800px, calc(100% - 32px))'
    container.style.boxSizing = 'border-box'
    container.style.padding = '20px 32px'
    container.style.lineHeight = '1.6'
    container.style.fontSize = '28px'
    container.style.textAlign = 'center'
    container.style.background = 'rgba(0,0,0,0.75)'
    container.style.borderRadius = '12px'
    overlay.appendChild(container)

    // Create word spans
    const spans = words.map((w, i) => {
      const span = document.createElement('span')
      span.textContent = w.word
      span.style.color = 'white'
      span.style.fontWeight = 'normal'
      span.style.transition =
        'color 150ms ease, font-weight 150ms ease, transform 150ms ease'
      span.style.display = 'inline-block'
      if (i < words.length - 1) {
        span.style.marginRight = '0.3em'
      }
      container.appendChild(span)
      return span
    })

    document.body.appendChild(overlay)

    // Fade in
    requestAnimationFrame(() => {
      overlay.style.opacity = '1'
    })

    // Create audio
    const audio = new Audio(audioBase64)
    let animationId = null
    let lastActiveIndex = -1

    const updateHighlight = () => {
      const currentTime = audio.currentTime

      let activeIndex = -1
      for (let i = 0; i < words.length; i += 1) {
        if (currentTime >= words[i].start && currentTime <= words[i].end) {
          activeIndex = i
          break
        }
        // If between words, highlight the upcoming word
        if (currentTime < words[i].start) {
          break
        }
        activeIndex = i
      }

      if (activeIndex !== lastActiveIndex) {
        // Reset previous
        if (lastActiveIndex >= 0 && lastActiveIndex < spans.length) {
          spans[lastActiveIndex].style.color = 'white'
          spans[lastActiveIndex].style.fontWeight = 'normal'
          spans[lastActiveIndex].style.transform = 'scale(1)'
        }
        // Highlight current
        if (activeIndex >= 0 && activeIndex < spans.length) {
          spans[activeIndex].style.color = getCursorConfig().color
          spans[activeIndex].style.fontWeight = 'bold'
          spans[activeIndex].style.transform = 'scale(1.05)'
        }
        lastActiveIndex = activeIndex
      }

      animationId = requestAnimationFrame(updateHighlight)
    }

    const cleanup = () => {
      if (animationId) {
        cancelAnimationFrame(animationId)
      }
      // Brief hold then fade out
      setTimeout(() => {
        overlay.style.opacity = '0'
        setTimeout(() => {
          overlay.remove()
          resolve()
        }, 300)
      }, 500)
    }

    audio.addEventListener('ended', cleanup, { once: true })
    audio.addEventListener('error', cleanup, { once: true })

    // Start playback and animation loop
    audio
      .play()
      .then(() => {
        animationId = requestAnimationFrame(updateHighlight)
      })
      .catch(() => {
        cleanup()
      })
  })

export const showOverlayText = text =>
  new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.position = 'fixed'
    overlay.style.inset = '0'
    overlay.style.zIndex = '999999'
    overlay.style.display = 'flex'
    overlay.style.alignItems = 'center'
    overlay.style.justifyContent = 'center'
    overlay.style.opacity = '0'
    overlay.style.transition = 'opacity 300ms ease'
    overlay.style.pointerEvents = 'none'

    // calc keeps 16px side margins on narrow viewports
    const container = document.createElement('div')
    container.style.maxWidth = 'min(800px, calc(100% - 32px))'
    container.style.boxSizing = 'border-box'
    container.style.padding = '20px 32px'
    container.style.lineHeight = '1.6'
    container.style.fontSize = '28px'
    container.style.textAlign = 'center'
    container.style.color = 'white'
    container.style.background = 'rgba(0,0,0,0.75)'
    container.style.borderRadius = '12px'
    container.textContent = text
    overlay.appendChild(container)

    document.body.appendChild(overlay)

    requestAnimationFrame(() => {
      overlay.style.opacity = '1'
    })

    setTimeout(() => {
      overlay.style.opacity = '0'
      setTimeout(() => {
        overlay.remove()
        resolve()
      }, 300)
    }, 3000)
  })

export const typeCursor = async (text, selector, options = {}) => {
  const { clear = false } = options
  const element = selector
    ? findVisibleElement(selector)
    : document.activeElement

  if (!element) {
    console.warn('typeCursor: no element to type into')
    return
  }

  // Click and focus the element to ensure it's active
  element.click()
  element.focus()
  triggerFocus(element)
  await pause(100)

  // Optionally clear any existing value first so typing replaces rather than
  // appends (e.g. setting a quantity field that already defaults to "1").
  if (
    clear &&
    (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
  ) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      element.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype,
      'value',
    ).set
    nativeInputValueSetter.call(element, '')
    element.dispatchEvent(
      new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true,
      }),
    )
  }

  // Type each character sequentially
  const characters = text.split('')
  await characters.reduce(async (previousPromise, char) => {
    await previousPromise

    // Simulate keydown, keypress, and input events
    const keydownEvent = new KeyboardEvent('keydown', {
      key: char,
      code: `Key${char.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    })
    element.dispatchEvent(keydownEvent)

    const keypressEvent = new KeyboardEvent('keypress', {
      key: char,
      code: `Key${char.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    })
    element.dispatchEvent(keypressEvent)

    // Update the value for free-text input/textarea elements. Structured
    // inputs (time, date, etc.) reject partial values like "0" or "09:", so
    // their value is set in full after the loop instead (see below).
    const isStructuredInput =
      element.tagName === 'INPUT' &&
      /^(time|date|datetime-local|month|week|color)$/.test(element.type)
    if (
      (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
      !isStructuredInput
    ) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        element.tagName === 'INPUT'
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype,
        'value',
      ).set
      nativeInputValueSetter.call(element, element.value + char)
    }

    // Dispatch input event
    const inputEvent = new InputEvent('input', {
      data: char,
      inputType: 'insertText',
      bubbles: true,
      cancelable: true,
    })
    element.dispatchEvent(inputEvent)

    const keyupEvent = new KeyboardEvent('keyup', {
      key: char,
      code: `Key${char.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    })
    element.dispatchEvent(keyupEvent)

    // Play typing sound and add a small delay between characters
    await playTypeSound()
    await pause((50 + Math.random() * 50) / getSpeed()) // Random delay 50-100ms for natural typing, scaled by speed
  }, Promise.resolve())

  // Structured inputs (time/date/etc.) only accept a complete, valid value —
  // set it in full now that every character has been "typed" for the animation.
  if (
    element.tagName === 'INPUT' &&
    /^(time|date|datetime-local|month|week|color)$/.test(element.type)
  ) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set
    nativeInputValueSetter.call(element, text)
    element.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', bubbles: true }),
    )
  }

  // Dispatch change event after typing is complete
  const changeEvent = new Event('change', { bubbles: true })
  element.dispatchEvent(changeEvent)
}
