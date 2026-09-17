/* Copyright 2013 - 2024 Waiterio LLC */

import {
  clickCursor,
  clickCursorVisualOnly,
  dragCursor,
  getOptions,
  hideCursor,
  highlightElement,
  moveToSelector,
  pause,
  scrollToSelector,
  setOptions,
  showCursor,
  showOverlayText,
  showOverlayWithKaraoke,
  typeCursor,
  uploadFileCursor,
  waitForSelector,
  warmupAudio,
} from './cursor.js'

const STORAGE_KEY = 'tour-state'
const DEFAULT_PAUSE_MS = 1000
const getSpeed = () => getOptions()?.speed || 1
const WAIT_TIMEOUT_MS = 10000

const isLoopbackOrigin = origin => {
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

const isAllowedMessageOrigin = origin =>
  origin === window.location.origin || isLoopbackOrigin(origin)

// Caps for the debug snapshot below. The payload crosses postMessage to a
// different origin, so it has to be bounded here — the recorder cannot refuse
// an oversized message after the fact.
const SNAPSHOT_MAX_HTML_CHARS = 262144
const SNAPSHOT_MAX_OUTLINE = 200
const SNAPSHOT_MAX_ERRORS = 20

// Caps for the storage dump. An IndexedDB database can hold megabytes; this
// payload also crosses postMessage, and a dump that silently drops half its
// records while LOOKING complete is precisely the misleading evidence this
// system exists to remove — so every cap sets a `truncated` flag as it bites.
const STORAGE_MAX_TOTAL_CHARS = 512 * 1024
const STORAGE_MAX_VALUE_CHARS = 16384
const STORAGE_MAX_RECORDS_PER_STORE = 200
const STORAGE_MAX_KEYS_PER_OBJECT = 200
const STORAGE_MAX_DEPTH = 8
const STORAGE_IDB_TIMEOUT_MS = 3000

// Redact on the KEY, not the value: a value that merely looks random is often
// an id we need. Deliberately NOT listed: `session`, `clinic`, `user`,
// `organization` — those objects are the diagnostic payload (which clinic is
// cached, is its trial live, what currency) and must stay readable.
const STORAGE_REDACT_KEY =
  /(token|password|passwd|secret|authorization|api[-_]?key|apikey|jwt|refresh|credential|bearer|signature|private[-_]?key)/i

/** Keep shape and size so presence-vs-absence stays diagnosable without the value. */
const describeRedacted = value => {
  if (typeof value === 'string') {
    return `[redacted string, ${value.length} chars]`
  }
  if (value === null) return '[redacted null]'
  if (Array.isArray(value)) return `[redacted array, ${value.length} items]`
  if (typeof value === 'object') {
    let keys
    try {
      keys = Object.keys(value).length
    } catch {
      keys = 0
    }
    return `[redacted object, ${keys} keys]`
  }
  return `[redacted ${typeof value}]`
}

/**
 * Convert an arbitrary stored value into something JSON-safe, redacted and
 * bounded. Also does the postMessage-safety job: IndexedDB hands back Blobs,
 * ArrayBuffers and class instances that would either fail to clone or serialise
 * to `{}`, so everything is flattened here rather than trusted to survive.
 */
const sanitizeStorageValue = (value, key, depth, budget) => {
  if (
    key !== null &&
    key !== undefined &&
    STORAGE_REDACT_KEY.test(String(key))
  ) {
    return describeRedacted(value)
  }
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'number') return value
  if (type === 'undefined') return '[undefined]'
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    return `[${type}]`
  }
  if (type === 'string') {
    budget.used += value.length
    if (value.length > budget.valueChars) {
      budget.truncated = true
      return `${value.slice(0, budget.valueChars)}…[truncated, ${value.length} chars total]`
    }
    return value
  }

  if (budget.used >= budget.totalChars) {
    budget.truncated = true
    return '[truncated: total size cap reached]'
  }
  if (depth <= 0) {
    budget.truncated = true
    return '[truncated: max depth]'
  }

  try {
    if (value instanceof Date) return value.toISOString()
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return `[Blob, ${value.size} bytes, ${value.type || 'unknown type'}]`
    }
    if (value instanceof ArrayBuffer) {
      return `[ArrayBuffer, ${value.byteLength} bytes]`
    }
    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor?.name || 'TypedArray'}, ${value.byteLength} bytes]`
    }

    if (Array.isArray(value)) {
      const out = []
      for (let i = 0; i < value.length; i += 1) {
        if (
          i >= STORAGE_MAX_KEYS_PER_OBJECT ||
          budget.used >= budget.totalChars
        ) {
          budget.truncated = true
          out.push(`[truncated: ${value.length - i} more items]`)
          break
        }
        out.push(sanitizeStorageValue(value[i], null, depth - 1, budget))
      }
      return out
    }

    const out = {}
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      if (
        i >= STORAGE_MAX_KEYS_PER_OBJECT ||
        budget.used >= budget.totalChars
      ) {
        budget.truncated = true
        out['[truncated]'] = `${keys.length - i} more keys`
        break
      }
      budget.used += keys[i].length
      out[keys[i]] = sanitizeStorageValue(
        value[keys[i]],
        keys[i],
        depth - 1,
        budget,
      )
    }
    return out
  } catch (error) {
    return `[unreadable: ${String(error?.message || error)}]`
  }
}

/**
 * Web Storage values are strings, but the app writes JSON into them — a token
 * nested inside a serialised session would sail straight past key-based
 * redaction if we kept the raw string. Parse when we can, so the walker sees
 * the real keys; fall back to the string when it is not JSON.
 */
const sanitizeStorageEntry = (key, raw, budget) => {
  if (STORAGE_REDACT_KEY.test(String(key))) return describeRedacted(raw)
  if (typeof raw === 'string' && /^\s*[[{]/.test(raw)) {
    try {
      return sanitizeStorageValue(
        JSON.parse(raw),
        null,
        STORAGE_MAX_DEPTH,
        budget,
      )
    } catch {
      // Not JSON after all — fall through to the plain string.
    }
  }
  return sanitizeStorageValue(raw, null, STORAGE_MAX_DEPTH, budget)
}

/** Any storage read can throw (disabled cookies, blocked IDB) — label it, never throw. */
const dumpWebStorage = (storage, budget) => {
  try {
    if (!storage) return { available: false, reason: 'unavailable' }
    const out = { available: true, keyCount: storage.length, entries: {} }
    for (let i = 0; i < storage.length; i += 1) {
      if (budget.used >= budget.totalChars) {
        budget.truncated = true
        out.truncated = true
        out.note = `stopped after ${i} of ${storage.length} keys (total size cap)`
        break
      }
      const key = storage.key(i)
      out.entries[key] = sanitizeStorageEntry(key, storage.getItem(key), budget)
    }
    return out
  } catch (error) {
    return {
      available: false,
      reason: 'error',
      collectError: String(error?.message || error),
    }
  }
}

const dumpCookies = budget => {
  try {
    const raw = document.cookie || ''
    const entries = {}
    for (const pair of raw.split(';')) {
      const trimmed = pair.trim()
      if (trimmed) {
        const index = trimmed.indexOf('=')
        const name = index === -1 ? trimmed : trimmed.slice(0, index)
        const value = index === -1 ? '' : trimmed.slice(index + 1)
        entries[name] = sanitizeStorageEntry(name, value, budget)
      }
    }
    return {
      available: true,
      entries,
      // Without this a reader concludes "no session cookie" from an empty list,
      // when the session cookie is exactly the kind that is httpOnly.
      note: 'document.cookie cannot see httpOnly cookies — absence here does NOT mean no session cookie exists',
    }
  } catch (error) {
    return {
      available: false,
      reason: 'error',
      collectError: String(error?.message || error),
    }
  }
}

/** Wrap an IDB request so a database that never opens cannot wedge the reply. */
const idbRequest = (request, timeoutMs) =>
  new Promise(resolve => {
    let settled = false
    const finish = outcome => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      finish({ error: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    try {
      request.onsuccess = () => {
        clearTimeout(timer)
        finish({ value: request.result })
      }
      request.onerror = () => {
        clearTimeout(timer)
        finish({
          error: String(
            request.error?.message || request.error || 'request failed',
          ),
        })
      }
      request.onblocked = () => {
        clearTimeout(timer)
        finish({ error: 'blocked' })
      }
    } catch (error) {
      clearTimeout(timer)
      finish({ error: String(error?.message || error) })
    }
  })

/** Read one object store's records, bounded, with whatever it dropped stated. */
const dumpObjectStore = async (db, storeName, budget) => {
  try {
    // One readonly transaction for all three reads, so the count can never
    // disagree with the records because of a write landing in between.
    const store = db.transaction(storeName, 'readonly').objectStore(storeName)
    const [keys, values, total] = await Promise.all([
      idbRequest(
        store.getAllKeys(undefined, STORAGE_MAX_RECORDS_PER_STORE),
        STORAGE_IDB_TIMEOUT_MS,
      ),
      idbRequest(
        store.getAll(undefined, STORAGE_MAX_RECORDS_PER_STORE),
        STORAGE_IDB_TIMEOUT_MS,
      ),
      idbRequest(store.count(), STORAGE_IDB_TIMEOUT_MS),
    ])
    if (values.error) {
      return { available: false, reason: values.error }
    }
    const records = (values.value || []).map((value, index) => ({
      key: sanitizeStorageValue(keys.value?.[index], null, 2, budget),
      value: sanitizeStorageValue(value, null, STORAGE_MAX_DEPTH, budget),
    }))
    const recordCount =
      typeof total.value === 'number' ? total.value : records.length
    const dumped = { available: true, recordCount, records }
    // Stating the denominator is the difference between a partial dump and a
    // partial dump that looks whole.
    if (recordCount > records.length) {
      budget.truncated = true
      dumped.truncated = true
      dumped.note = `showing ${records.length} of ${recordCount} records (per-store cap)`
    }
    return dumped
  } catch (error) {
    return {
      available: false,
      reason: 'error',
      collectError: String(error?.message || error),
    }
  }
}

/**
 * Dump every object store of every IndexedDB database, RECORDS INCLUDED.
 *
 * This is the point of the whole exercise: the app caches through LocalForage
 * (database "localforage"), so a clinic cached by an earlier run — expired
 * trial, different currency — lives here and nowhere else. Key names alone
 * would not have shown that, so the records are actually read.
 */
const dumpIndexedDb = async budget => {
  try {
    if (typeof indexedDB === 'undefined') {
      return { available: false, reason: 'no-indexeddb' }
    }
    if (typeof indexedDB.databases !== 'function') {
      // Firefox has no enumeration API. Say so rather than reporting "none".
      return { available: false, reason: 'databases-enumeration-unsupported' }
    }

    const listed = await Promise.race([
      indexedDB.databases(),
      new Promise(resolve => {
        setTimeout(() => resolve(null), STORAGE_IDB_TIMEOUT_MS)
      }),
    ])
    if (!listed) return { available: false, reason: 'timeout' }

    const out = { available: true, databases: [] }
    for (const info of listed) {
      const entry = {
        name: info?.name || null,
        version: info?.version ?? null,
        stores: {},
      }
      const opened = await idbRequest(
        indexedDB.open(info.name),
        STORAGE_IDB_TIMEOUT_MS,
      )
      if (opened.error || !opened.value) {
        entry.available = false
        entry.reason = opened.error || 'open-failed'
      } else {
        const db = opened.value
        try {
          const names = Array.from(db.objectStoreNames || [])
          for (const storeName of names) {
            if (budget.used >= budget.totalChars) {
              budget.truncated = true
              entry.truncated = true
              entry.note = `stopped before store "${storeName}" (total size cap)`
              break
            }
            entry.stores[storeName] = await dumpObjectStore(
              db,
              storeName,
              budget,
            )
          }
          entry.available = true
        } finally {
          try {
            db.close()
          } catch {
            // A database we could not close is not worth failing the dump for.
          }
        }
      }
      out.databases.push(entry)
    }
    return out
  } catch (error) {
    return {
      available: false,
      reason: 'error',
      collectError: String(error?.message || error),
    }
  }
}

/**
 * Describe THIS origin's client-side storage for the recorder's failure evidence.
 *
 * Storage is ORIGIN-SCOPED: the tutorials shell (:22828) cannot read the app's
 * (:22222) localStorage, cookies or IndexedDB at all, so — like collectSnapshot
 * — only the app can answer for the app.
 *
 * Motivating case: a clinic whose MongoDB record is correct (trial live, RUB,
 * setup guide completed) still gets paywalled and shown the setup guide. That
 * combination is impossible from the database, so the app is hydrating from
 * cache, and the cache was invisible to every artifact we wrote.
 */
export const collectStorage = async ({ maxTotalChars, maxValueChars } = {}) => {
  const budget = {
    totalChars: maxTotalChars || STORAGE_MAX_TOTAL_CHARS,
    valueChars: maxValueChars || STORAGE_MAX_VALUE_CHARS,
    used: 0,
    truncated: false,
  }

  const out = {
    available: true,
    url: null,
    caps: { totalChars: budget.totalChars, valueChars: budget.valueChars },
    // Named so a reader knows a filtered dump when they see one.
    redaction:
      'values whose key matches token/password/secret/authorization/apiKey/jwt/refresh/credential/bearer/signature/privateKey are replaced by a shape+length description; everything else (clinic, session, subscription, …) is verbatim',
  }

  try {
    out.url = String(window.location.href)
  } catch {
    out.url = null
  }

  out.localStorage = dumpWebStorage(
    (() => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    })(),
    budget,
  )
  out.sessionStorage = dumpWebStorage(
    (() => {
      try {
        return window.sessionStorage
      } catch {
        return null
      }
    })(),
    budget,
  )
  out.cookies = dumpCookies(budget)
  out.indexedDb = await dumpIndexedDb(budget)

  out.truncated = budget.truncated
  out.approximateChars = budget.used
  return out
}

/**
 * Describe THIS document for the recorder's per-step failure evidence.
 *
 * The recorder drives the app through an iframe on a different port, so it
 * cannot read this DOM itself — reading its own `window.document` only ever
 * shows the tutorials shell, which is why a crashed app used to be reported as
 * "selector not found, 0 matches". Only the app can answer for the app, so it
 * answers here and posts the result back.
 *
 * Shape matches collectDomSnapshot in @monorepool/tutorials/stepDebugArtifacts.js
 * so consumers do not need two formats.
 */
const collectSnapshot = ({ selector, maxHtmlChars, maxOutline } = {}) => {
  const out = {
    available: true,
    url: null,
    title: null,
    readyState: null,
    selector: selector || null,
    selectorMatches: 0,
    selectorVisible: 0,
    errorTexts: [],
    outline: [],
    html: '',
  }

  try {
    out.url = String(window.location.href)
    out.title = document.title || null
    out.readyState = document.readyState || null

    const isVisible = element => {
      try {
        const style = window.getComputedStyle?.(element)
        if (
          style &&
          (style.display === 'none' || style.visibility === 'hidden')
        ) {
          return false
        }
        const box = element.getBoundingClientRect?.()
        return !box || box.width > 0 || box.height > 0
      } catch {
        return true
      }
    }

    // "Absent" and "present but hidden" have completely different causes and
    // the step failure message cannot tell them apart.
    if (selector) {
      const matches = Array.from(document.querySelectorAll(selector))
      out.selectorMatches = matches.length
      out.selectorVisible = matches.filter(isVisible).length
    }

    // An error boundary ("Oops, something went wrong") is usually the whole
    // answer: the tour is not on the screen it thinks it is.
    const alerts = Array.from(
      document.querySelectorAll(
        '[role="alert"], [role="alertdialog"], [data-testid*="error"], [class*="error"], [class*="alert"]',
      ),
    )
    for (const element of alerts) {
      if (out.errorTexts.length >= SNAPSHOT_MAX_ERRORS) break
      if (isVisible(element)) {
        const text = (element.innerText || element.textContent || '').trim()
        if (text && !out.errorTexts.includes(text)) {
          out.errorTexts.push(text.slice(0, 500))
        }
      }
    }

    // Enough of a skeleton to recognise which screen the tour landed on.
    const limit = maxOutline || SNAPSHOT_MAX_OUTLINE
    const landmarks = Array.from(
      document.querySelectorAll(
        'h1, h2, h3, [data-testid], [role="dialog"], button',
      ),
    )
    for (const element of landmarks) {
      if (out.outline.length >= limit) break
      const tag = (element.tagName || '').toLowerCase()
      const testid = element.getAttribute?.('data-testid')
      const text = (element.innerText || element.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 120)
      out.outline.push(
        `${isVisible(element) ? '' : '[hidden] '}${tag}${testid ? `[data-testid="${testid}"]` : ''}${text ? ` — ${text}` : ''}`,
      )
    }

    const html = document.documentElement?.outerHTML || ''
    out.html = html.slice(0, maxHtmlChars || SNAPSHOT_MAX_HTML_CHARS)
  } catch (error) {
    out.collectError = String(error?.message || error)
  }

  return out
}

let isRunning = false
let toursData = null

/**
 * Get the current tour state from sessionStorage
 */
const getTutorialState = () => {
  try {
    const state = sessionStorage.getItem(STORAGE_KEY)
    return state ? JSON.parse(state) : null
  } catch {
    return null
  }
}

/**
 * Save the tour state to sessionStorage
 */
const saveTutorialState = state => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (error) {
    console.error('Failed to save tour state:', error)
  }
}

/**
 * Clear the tour state from sessionStorage
 */
const clearTutorialState = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('Failed to clear tour state:', error)
  }
}

/**
 * Initialize the TourRunner with tours data
 * @param {Object} tours - The tours data object
 */
export const initTourRunner = tours => {
  toursData = tours

  // Drop tour state left over from a run that never cleaned up (recording
  // killed mid-tour, preview reloaded, …) so isTutorialInProgress() doesn't
  // stay stuck on true for this tab. Nothing resumes tours across page loads
  // (resumeTutorial has no callers), so clearing on boot is safe.
  clearTutorialState()

  // Expose tours data on window for debugging/console access
  if (typeof window !== 'undefined') {
    window.tours = tours
  }
}

/**
 * Get tours data (must be initialized first)
 */
const loadTutorials = async () => toursData

/**
 * Resolve template variables in a value string.
 * Variables use {{variableName}} syntax and are looked up in options.metadata.
 * Supports multiple variables like 'Hello {{firstName}} {{lastName}}'.
 * If any variable is not found in metadata, returns null to indicate fallback is needed.
 * @param {string} value - The value string potentially containing template variables
 * @returns {string|null} - Resolved value or null if any variable is missing from metadata
 */
const resolveTemplateValue = value => {
  if (!value || typeof value !== 'string') {
    return value
  }

  const templatePattern = /\{\{\s*(\w+)\s*\}\}/g

  if (!templatePattern.test(value)) {
    return value
  }

  const options = getOptions()
  const metadata = options?.metadata || {}

  let allResolved = true

  // Reset regex lastIndex after test()
  templatePattern.lastIndex = 0

  const resolvedValue = value.replace(
    templatePattern,
    (match, variableName) => {
      const metadataValue = metadata[variableName]

      if (metadataValue !== undefined && metadataValue !== null) {
        return metadataValue
      }

      allResolved = false
      return match // Keep original if not found
    },
  )

  return allResolved ? resolvedValue : null
}

/**
 * Execute a single tour step
 */
const executeStep = async (step, { onCursorArrived } = {}) => {
  const {
    selector,
    action = 'click',
    value,
    valueDefault,
    clear,
    description,
    fakeClick,
    pause: customPause,
  } = step

  // Handle overview steps (no selector needed)
  if (action === 'overview') {
    if (description) console.log(`Tutorial: ${description}`)
    const options = getOptions()
    const speechData = options?.speeches?.[description]
    if (speechData?.base64 && speechData?.alignment) {
      await showOverlayWithKaraoke(speechData.base64, speechData.alignment)
    } else {
      await showOverlayText(description)
    }
    await pause((customPause || DEFAULT_PAUSE_MS) / getSpeed())
    return true
  }

  // Wait for the element to appear
  const element = await waitForSelector(selector, WAIT_TIMEOUT_MS)

  if (!element) {
    console.warn(`Tutorial step failed: element not found for "${selector}"`)
    return false
  }

  // Scroll element into view if needed
  await scrollToSelector(selector)
  await pause(300 / getSpeed())

  // Log the description if provided
  if (description) {
    console.log(`Tutorial: ${description}`)
  }

  // Execute the action
  switch (action) {
    case 'click':
      await moveToSelector(selector)
      if (onCursorArrived) await onCursorArrived()
      await pause(500 / getSpeed())
      if (fakeClick) {
        await clickCursorVisualOnly()
      } else {
        await clickCursor(selector)
      }
      break

    case 'move':
      await moveToSelector(selector)
      if (onCursorArrived) await onCursorArrived()
      break

    case 'type':
      await moveToSelector(selector)
      if (onCursorArrived) await onCursorArrived()
      await pause(300 / getSpeed())
      await clickCursor(selector)
      await pause(200 / getSpeed())
      if (value) {
        // Try to resolve template variables from metadata
        let resolvedValue = resolveTemplateValue(value)

        // If template variables couldn't be resolved, fall back to valueDefault
        if (resolvedValue === null) {
          resolvedValue =
            valueDefault || value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '$1') // Strip unresolved templates as last resort
        }

        if (resolvedValue) {
          await typeCursor(resolvedValue, selector, { clear })
        }
      }
      break

    case 'upload': {
      await moveToSelector(selector)
      if (onCursorArrived) await onCursorArrived()
      await pause(500)
      await clickCursorVisualOnly()
      await pause(300)
      let resolvedValue = resolveTemplateValue(value)
      if (resolvedValue === null) {
        resolvedValue = valueDefault || ''
      }
      if (resolvedValue) {
        await uploadFileCursor(resolvedValue, step.fileName || 'data.csv')
      }
      break
    }

    case 'drag':
      // dragCursor handles its own cursor movement (start → end) so we skip
      // the moveToSelector + onCursorArrived camera-zoom protocol — that flow
      // assumes a single click target, whereas a drag needs to visit two.
      await dragCursor(selector, step.endSelector)
      break

    case 'scroll':
      // Already scrolled above
      break

    case 'hover':
      await moveToSelector(selector)
      if (onCursorArrived) await onCursorArrived()
      break

    case 'highlight':
      await highlightElement(selector)
      break

    case 'wait':
      // Already waited for element above
      break

    default:
      console.warn(`Unknown tour action: ${action}`)
  }

  // Pause after action
  await pause((customPause || DEFAULT_PAUSE_MS) / getSpeed())

  return true
}

/**
 * Run a tour from a specific step
 */
const runTutorialFromStep = async (tour, startStep) => {
  if (isRunning) {
    console.warn('Tutorial already running')
    return
  }

  isRunning = true

  const { name, steps } = tour

  const options = getOptions()
  const skipSteps = options?.skipSteps || []

  // Filter steps to only run from startStep onwards, skipping specified steps
  const stepsToRun = steps.filter(
    step => step.step >= startStep && !skipSteps.includes(step.step),
  )

  if (stepsToRun.length === 0) {
    console.log(`Tutorial "${name}" completed`)
    clearTutorialState()
    await hideCursor()
    isRunning = false
    return
  }

  // Execute steps sequentially using reduce
  const stopped = await stepsToRun.reduce(async (previousPromise, step) => {
    const wasStopped = await previousPromise
    // If a previous step stopped the tour, don't continue
    if (wasStopped) {
      return true
    }

    // Check if tour was stopped externally
    const state = getTutorialState()
    if (!state || state.tour !== name) {
      console.log('Tutorial stopped')
      isRunning = false
      return true
    }

    // Execute the step
    const success = await executeStep(step)

    if (!success) {
      console.error(`Tutorial "${name}" failed at step ${step.step}`)
      clearTutorialState()
      await hideCursor()
      isRunning = false
      return true
    }

    return false
  }, Promise.resolve(false))

  // If not stopped, tour completed
  if (!stopped) {
    console.log(`Tutorial "${name}" completed`)
    clearTutorialState()
    await hideCursor()
    isRunning = false

    // Notify parent window that tour completed (for tour webapp integration)
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'tourCompleted', tourName: name }, '*')
    }
  }
}

/**
 * Start a tour by name
 * @param {string} tourName - Name of the tour to start
 * @param {Object} [tourOptions] - Options for the tour
 * @param {string} [tourOptions.language] - Language code for translations (e.g., 'it', 'en')
 */
export const startTour = async (tourName, tourOptions = {}) => {
  const tours = await loadTutorials()

  if (!tours) {
    console.error('Failed to load tours. Did you call initTourRunner?')
    return
  }

  const tour = tours[tourName]

  if (!tour) {
    console.error(`Tutorial "${tourName}" not found`)
    return
  }

  // Set options for cursor module
  setOptions(tourOptions)

  // Save initial state
  saveTutorialState({
    tour: tourName,
    step: 1,
  })

  // Initialize cursor
  await warmupAudio()
  await showCursor()

  // Run from step 1
  await runTutorialFromStep(tour, 1)
}

/**
 * Resume a tour if one is in progress
 * Call this on page load to continue after navigation
 */
export const resumeTutorial = async () => {
  const state = getTutorialState()

  if (!state) {
    return false
  }

  const tours = await loadTutorials()

  if (!tours) {
    console.error('Failed to load tours. Did you call initTourRunner?')
    clearTutorialState()
    return false
  }

  const tour = tours[state.tour]

  if (!tour) {
    console.error(`Tutorial "${state.tour}" not found`)
    clearTutorialState()
    return false
  }

  console.log(`Resuming tour "${state.tour}" from step ${state.step}`)

  // Initialize cursor if not already visible
  await warmupAudio()
  await showCursor()

  // Small delay to let the page render
  await pause(500)

  // Run from saved step
  await runTutorialFromStep(tour, state.step)

  return true
}

/**
 * Stop the current tour
 */
export const stopTutorial = async () => {
  clearTutorialState()
  isRunning = false
  await hideCursor()
  console.log('Tutorial stopped')
}

/**
 * Check if a tour is currently in progress
 */
export const isTutorialInProgress = () => {
  const state = getTutorialState()
  return state !== null
}

/**
 * Get the name of the current tour if one is in progress
 */
export const getCurrentTutorial = () => {
  const state = getTutorialState()
  return state?.tour || null
}

// Export to window for easy console access
if (typeof window !== 'undefined') {
  window.startTour = startTour
  window.resumeTutorial = resumeTutorial
  window.stopTutorial = stopTutorial
  window.isTutorialInProgress = isTutorialInProgress
  window.getCurrentTutorial = getCurrentTutorial

  // Listen for postMessage from parent window (for tour webapp integration)
  window.addEventListener('message', event => {
    // Production shells can run on the same origin. Development shells may
    // use another port on the local machine.
    if (!isAllowedMessageOrigin(event.origin)) {
      return
    }

    const { type, tourName, options: messageOptions } = event.data || {}

    if (type === 'startTour' && tourName) {
      console.log(`Received startTour message for "${tourName}"`)
      startTour(tourName, messageOptions)
    } else if (type === 'stopTutorial') {
      stopTutorial()
    } else if (type === 'initStepByStep') {
      const { tourName: stepTourName, options: stepOptions } = event.data || {}
      setOptions(stepOptions || {})
      // Mark the tour as in progress so isTutorialInProgress() is true in
      // step-by-step mode too — app code uses it to enable tour-only demo
      // affordances (e.g. simulating the WhatsApp QR scan).
      saveTutorialState({
        tour: stepTourName,
        step: 1,
      })
      const tour = toursData?.[stepTourName]
      const skipSet = new Set(stepOptions?.skipSteps || [])
      const isSmartphone = stepOptions?.device === 'smartphone'
      const steps = tour
        ? tour.steps
            .filter(step => !skipSet.has(step.step))
            .map(step => (isSmartphone ? { ...step, zoom: 'none' } : step))
        : []
      warmupAudio().then(() =>
        showCursor().then(() => {
          window.parent.postMessage({ type: 'stepByStepReady', steps }, '*')
        }),
      )
    } else if (type === 'executeTourStep') {
      const { step } = event.data || {}
      if (step) {
        const PROCEED_TIMEOUT_MS = 2000

        const reportPositionAndWait = async () => {
          if (step.selector) {
            const element = await waitForSelector(
              step.selector,
              WAIT_TIMEOUT_MS,
            )
            if (element) {
              await scrollToSelector(step.selector)
              const rect = element.getBoundingClientRect()
              window.parent.postMessage(
                {
                  type: 'tourStepPosition',
                  rect: {
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                  },
                  viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                  },
                },
                '*',
              )

              // Wait for proceedWithStep or timeout
              await new Promise(resolve => {
                let timeout
                const handler = evt => {
                  if (evt.data?.type === 'proceedWithStep') {
                    clearTimeout(timeout)
                    window.removeEventListener('message', handler)
                    resolve()
                  }
                }
                timeout = setTimeout(() => {
                  window.removeEventListener('message', handler)
                  resolve()
                }, PROCEED_TIMEOUT_MS)
                window.addEventListener('message', handler)
              })
            }
          }
        }

        const CURSOR_ACTIONS = new Set([
          'click',
          'type',
          'upload',
          'move',
          'hover',
        ])
        const options = {}

        if (step.selector && CURSOR_ACTIONS.has(step.action || 'click')) {
          options.onCursorArrived = () =>
            new Promise(resolve => {
              window.parent.postMessage({ type: 'cursorArrived' }, '*')
              let timeout
              const handler = evt => {
                if (evt.data?.type === 'proceedWithAction') {
                  clearTimeout(timeout)
                  window.removeEventListener('message', handler)
                  resolve()
                }
              }
              timeout = setTimeout(() => {
                window.removeEventListener('message', handler)
                resolve()
              }, PROCEED_TIMEOUT_MS)
              window.addEventListener('message', handler)
            })
        }

        reportPositionAndWait()
          .then(() => executeStep(step, options))
          .then(success => {
            // executeStep returns false when the target element never appears.
            // Report the outcome (and what failed) so the parent surfaces a
            // clear error instead of silently advancing / waiting for a timeout.
            if (success === false) {
              console.error(
                `Tutorial step ${step.step} failed: element not found for "${step.selector}" (action: ${step.action || 'click'})`,
              )
            }
            window.parent.postMessage(
              {
                type: 'tourStepCompleted',
                success: success !== false,
                step: step.step,
                selector: step.selector,
                action: step.action,
                description: step.description,
              },
              '*',
            )
          })
          .catch(error => {
            const message = String(error?.message || error)
            console.error(
              `Tutorial step ${step.step} threw while running "${step.selector}" (action: ${step.action || 'click'}): ${message}`,
            )
            window.parent.postMessage(
              {
                type: 'tourStepCompleted',
                success: false,
                step: step.step,
                selector: step.selector,
                action: step.action,
                description: step.description,
                error: message,
              },
              '*',
            )
          })
      }
    } else if (type === 'collectAppSnapshot') {
      // Failure evidence only — never touches the tour, so it stays answerable
      // even while a step is stuck. The requestId is echoed back because the
      // parent may have several requests in flight (one per failing step).
      const { requestId, selector, maxHtmlChars, maxOutline } = event.data || {}
      let snapshot
      try {
        snapshot = collectSnapshot({ selector, maxHtmlChars, maxOutline })
      } catch (error) {
        snapshot = {
          available: false,
          reason: 'error',
          collectError: String(error?.message || error),
        }
      }
      window.parent.postMessage(
        { type: 'appSnapshotCollected', requestId, snapshot },
        '*',
      )
    } else if (type === 'collectAppStorage') {
      // Same contract as collectAppSnapshot: failure evidence only, never
      // touches the tour, and always answers — a storage read that fails must
      // come back as a labelled absence rather than leaving the shell waiting.
      const { requestId, maxTotalChars, maxValueChars } = event.data || {}
      const reply = storage => {
        window.parent.postMessage(
          { type: 'appStorageCollected', requestId, storage },
          '*',
        )
      }
      try {
        collectStorage({ maxTotalChars, maxValueChars })
          .then(reply)
          .catch(error => {
            reply({
              available: false,
              reason: 'error',
              collectError: String(error?.message || error),
            })
          })
      } catch (error) {
        reply({
          available: false,
          reason: 'error',
          collectError: String(error?.message || error),
        })
      }
    } else if (type === 'getGroupPositions') {
      const { selectors } = event.data || {}
      const rects = (selectors || []).map(selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        }
      })
      window.parent.postMessage(
        {
          type: 'groupPositions',
          rects,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
        '*',
      )
    } else if (type === 'cleanupStepByStep') {
      clearTutorialState()
      hideCursor({ silent: true }).then(() => {
        window.parent.postMessage({ type: 'stepByStepCleanedUp' }, '*')
      })
    }
  })
}
