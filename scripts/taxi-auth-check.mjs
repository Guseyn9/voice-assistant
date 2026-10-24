#!/usr/bin/env node
/**
 * Taxi auth check — one controlled /auth + /token round trip.
 *
 * Contract under test (Validation Bench, apps/voice-demo/src/BackendClient.ts):
 *   POST {base}/api/v1/auth   x-www-form-urlencoded: login, password, type
 *   POST {base}/api/v1/token  x-www-form-urlencoded: auth_hash
 * No `au` parameter is sent: its purpose is unconfirmed.
 *
 * Safety rules enforced here (and covered by tests/node/taxi-auth-check.test.mjs):
 *  - at most ONE request per endpoint; there is no retry logic of any kind;
 *  - /token is only sent after a well-formed /auth answer;
 *  - the output holds stage names, error classes, HTTP status codes and timings
 *    only. Login, password, auth_hash, token, u_hash, cookies, response bodies
 *    and server messages are never printed (a fixed whitelist of known
 *    application messages is reported by label);
 *  - TLS verification stays on; credentials are only sent to an allow-listed
 *    host over https;
 *  - no files are written except the optional GitHub step summary.
 *
 * Configuration (environment):
 *   VITE_BACKEND_URL     e.g. https://ibronevik.ru/taxi/c/gruzvill (no /api/v1)
 *   E2E_DRIVER_LOGIN     secret
 *   E2E_DRIVER_PASSWORD  secret
 *   E2E_DRIVER_TYPE      optional, default "e-mail"
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const EXIT = Object.freeze({
  OK: 0,
  CONFIG: 10,
  NETWORK: 20,
  HTTP: 30,
  APP: 40,
  FORMAT: 50,
  INTERNAL: 60,
})

const ALLOWED_HOSTS = Object.freeze(['ibronevik.ru'])
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]'])
const REQUEST_TIMEOUT_MS = 20_000
const MAX_BODY_CHARS = 1_000_000

/** Server messages that may be reported (by label). Anything else is not shown. */
const KNOWN_APP_MESSAGES = new Map([
  ['wrong login', 'wrong_login'],
  ['wrong password', 'wrong_password'],
  ['wrong phone', 'wrong_phone'],
])

const TLS_CODES = new Set([
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH',
])

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Validates the environment. Returns { ok: true, config } or
 * { ok: false, missing: string[], reason?: string }. Only variable NAMES and
 * fixed reason codes are ever reported — never values.
 */
export function validateConfig(env = process.env) {
  const present = name => typeof env[name] === 'string' && env[name].trim() !== ''
  const required = ['VITE_BACKEND_URL', 'E2E_DRIVER_LOGIN', 'E2E_DRIVER_PASSWORD']
  const missing = required.filter(name => !present(name))
  if (missing.length > 0) return { ok: false, missing }

  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    return { ok: false, missing: [], reason: 'tls_verification_disabled' }

  const allowLoopback = env.TAXI_AUTH_CHECK_ALLOW_LOOPBACK === '1'

  let url
  try {
    url = new URL(env.VITE_BACKEND_URL.trim())
  } catch {
    return { ok: false, missing: [], reason: 'invalid_url' }
  }
  if (url.username || url.password) return { ok: false, missing: [], reason: 'url_has_credentials' }
  if (url.search || url.hash) return { ok: false, missing: [], reason: 'url_has_query_or_fragment' }

  const isLoopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (isLoopback) {
    if (!allowLoopback) return { ok: false, missing: [], reason: 'host_not_allowed' }
  } else {
    if (url.protocol !== 'https:') return { ok: false, missing: [], reason: 'insecure_scheme' }
    if (!ALLOWED_HOSTS.includes(url.hostname)) return { ok: false, missing: [], reason: 'host_not_allowed' }
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (/\/api\/v1$/.test(path)) return { ok: false, missing: [], reason: 'url_already_has_api_v1' }

  return {
    ok: true,
    config: {
      baseUrl: `${url.origin}${path}`,
      login: env.E2E_DRIVER_LOGIN,
      password: env.E2E_DRIVER_PASSWORD,
      type: present('E2E_DRIVER_TYPE') ? env.E2E_DRIVER_TYPE.trim() : 'e-mail',
    },
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function collectCodes(error) {
  const codes = new Set()
  const names = new Set()
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3) return
    if (typeof value.code === 'string') codes.add(value.code)
    if (typeof value.name === 'string') names.add(value.name)
    visit(value.cause, depth + 1)
    if (Array.isArray(value.errors)) value.errors.forEach(item => visit(item, depth + 1))
  }
  visit(error, 0)
  return { codes, names }
}

const safeCode = code => (/^[A-Z0-9_]{1,48}$/.test(code) ? code : 'UNKNOWN')

/**
 * Maps a fetch() failure to { cls, delivery, code? }.
 * delivery: 'not_delivered' — the request cannot have reached the server
 *           (DNS, TCP connect and TLS handshake failures);
 *           'unknown'       — the server may or may not have processed it.
 */
export function classifyFetchError(error) {
  const { codes, names } = collectCodes(error)
  const has = (...list) => list.find(code => codes.has(code))

  if (names.has('TimeoutError') || names.has('AbortError'))
    return { cls: 'NETWORK_TIMEOUT', delivery: 'unknown' }

  if (has('ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL'))
    return { cls: 'NETWORK_DNS', delivery: 'not_delivered' }

  if (has('UND_ERR_CONNECT_TIMEOUT'))
    return { cls: 'NETWORK_TCP_TIMEOUT', delivery: 'not_delivered' }

  if (has('ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'))
    return { cls: 'NETWORK_TCP_FAILED', delivery: 'not_delivered' }

  const tls = [...codes].find(code => TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
  if (tls) return { cls: 'NETWORK_TLS', delivery: 'not_delivered', code: safeCode(tls) }

  if (has('ETIMEDOUT'))
    return { cls: 'NETWORK_TCP_TIMEOUT', delivery: 'unknown' }

  if (has('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED'))
    return { cls: 'NETWORK_CONNECTION_LOST', delivery: 'unknown' }

  const first = [...codes][0]
  return { cls: 'NETWORK_OTHER', delivery: 'unknown', ...(first ? { code: safeCode(first) } : {}) }
}

// ---------------------------------------------------------------------------
// A single HTTP round trip (no retries)
// ---------------------------------------------------------------------------

/**
 * Sends ONE form POST. Never throws; never retries; never returns the body text
 * except as the parsed JSON object on success.
 */
async function postForm(url, fields, { fetchImpl, timeoutMs }) {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const signal = AbortSignal.timeout(timeoutMs)

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    return { kind: 'network', ms: elapsed(), ...classifyFetchError(error) }
  }

  const status = response.status
  if (status < 200 || status >= 300) {
    try { await response.body?.cancel() } catch { /* body is not needed */ }
    return { kind: 'http', status, ms: elapsed() }
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    // Headers arrived, so the server did process the request.
    return { kind: 'network', ms: elapsed(), status, ...classifyFetchError(error), delivery: 'delivered' }
  }

  if (text.length > MAX_BODY_CHARS) return { kind: 'format', status, ms: elapsed(), detail: 'body_too_large' }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'format', status, ms: elapsed(), detail: 'invalid_json' }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    return { kind: 'format', status, ms: elapsed(), detail: 'not_an_object' }

  return { kind: 'ok', status, ms: elapsed(), json }
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

const nonEmptyString = value => typeof value === 'string' && value !== ''

/** HTTP 200 carrying an application-level error. Returns a label or null. */
function applicationError(json) {
  const isError = typeof json.status === 'string' && json.status.toLowerCase() === 'error'
  const label = typeof json.message === 'string'
    ? KNOWN_APP_MESSAGES.get(json.message.trim().toLowerCase())
    : undefined
  if (!isError && !label) return null
  if (label) return label
  return typeof json.message === 'string' ? 'unlisted_message' : 'no_message'
}

function toStage(name, round, interpret) {
  const base = { name, httpStatus: round.status, ms: round.ms }
  switch (round.kind) {
    case 'network':
      return { ...base, ok: false, exit: EXIT.NETWORK, cls: round.cls, delivery: round.delivery, code: round.code }
    case 'http':
      return { ...base, ok: false, exit: EXIT.HTTP, cls: `HTTP_ERROR_${round.status}` }
    case 'format':
      return { ...base, ok: false, exit: EXIT.FORMAT, cls: 'BAD_FORMAT', detail: round.detail }
    default:
      return interpret(base, round.json)
  }
}

function interpretAuth(base, json) {
  const appError = applicationError(json)
  if (appError) return { ...base, ok: false, exit: EXIT.APP, cls: 'APP_ERROR', detail: appError }
  if (!nonEmptyString(json.auth_hash))
    return { ...base, ok: false, exit: EXIT.FORMAT, cls: 'MISSING_FIELD', detail: 'auth_hash' }
  return { ...base, ok: true, authHash: json.auth_hash }
}

function interpretToken(base, json) {
  const appError = applicationError(json)
  if (appError) return { ...base, ok: false, exit: EXIT.APP, cls: 'APP_ERROR', detail: appError }
  const data = json.data
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return { ...base, ok: false, exit: EXIT.FORMAT, cls: 'MISSING_FIELD', detail: 'data' }
  const absent = ['token', 'u_hash'].filter(name => !nonEmptyString(data[name]))
  if (absent.length > 0)
    return { ...base, ok: false, exit: EXIT.FORMAT, cls: 'MISSING_FIELD', detail: absent.join('+') }
  return { ...base, ok: true }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const describe = stage => {
  const parts = [`class=${stage.cls}`]
  if (stage.detail) parts.push(`detail=${stage.detail}`)
  if (stage.code) parts.push(`code=${stage.code}`)
  if (stage.httpStatus !== undefined) parts.push(`HTTP ${stage.httpStatus}`)
  if (stage.delivery) parts.push(`delivery=${stage.delivery}`)
  parts.push(`${stage.ms} ms`)
  return parts.join(', ')
}

/**
 * Runs the check. `log` receives plain lines; `summary` receives markdown rows.
 * Returns the process exit code.
 */
export async function runCheck(config, {
  fetchImpl = fetch,
  log = console.log,
  timeoutMs = REQUEST_TIMEOUT_MS,
  summaryRows = [],
} = {}) {
  const stages = []

  const finish = exit => {
    log(`[INFO] requests sent: auth=${stages.some(s => s.name === 'auth') ? 1 : 0}, token=${stages.some(s => s.name === 'token') ? 1 : 0}, retries=0`)
    return exit
  }
  const report = (label, stage) => {
    stages.push(stage)
    summaryRows.push({ stage: label, status: stage.ok ? 'PASS' : 'FAIL', http: stage.httpStatus ?? '', detail: stage.ok ? '' : stage.cls + (stage.detail ? `:${stage.detail}` : '') })
    if (stage.ok) {
      log(`[AUTH] ${label}: PASS (HTTP ${stage.httpStatus}, ${stage.ms} ms)`)
    } else {
      log(`[AUTH] ${label}: FAIL (${describe(stage)})`)
      if (stage.delivery === 'unknown')
        log('[AUTH] NOTE: the server may or may not have processed this request. It was NOT retried.')
    }
  }

  log('[CONFIG] VITE_BACKEND_URL, E2E_DRIVER_LOGIN, E2E_DRIVER_PASSWORD present and valid: PASS')

  // 1. /auth
  const authRound = await postForm(`${config.baseUrl}/api/v1/auth`, {
    login: config.login,
    password: config.password,
    type: config.type,
  }, { fetchImpl, timeoutMs })
  const auth = toStage('auth', authRound, interpretAuth)
  report('POST /auth', auth)
  if (!auth.ok) {
    summaryRows.push({ stage: 'POST /token', status: 'SKIPPED', http: '', detail: 'previous stage failed' })
    log('[AUTH] POST /token: SKIPPED (previous stage failed)')
    return finish(auth.exit)
  }
  log('[AUTH] auth_hash present: PASS')

  // 2. /token (only after a well-formed /auth answer)
  const tokenRound = await postForm(`${config.baseUrl}/api/v1/token`, {
    auth_hash: auth.authHash,
  }, { fetchImpl, timeoutMs })
  const token = toStage('token', tokenRound, interpretToken)
  report('POST /token', token)
  if (!token.ok) return finish(token.exit)
  log('[AUTH] token and u_hash present: PASS')

  return finish(EXIT.OK)
}

function writeSummary(rows, exitCode) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  const lines = [
    '### Taxi auth check',
    '',
    '| stage | status | HTTP | class |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${row.stage} | ${row.status} | ${row.http} | ${row.detail} |`),
    '',
    `Exit code: ${exitCode}`,
    '',
  ]
  try {
    fs.appendFileSync(file, lines.join('\n'))
  } catch {
    // The summary is a convenience; the log lines above are authoritative.
  }
}

export async function main(env = process.env) {
  const rows = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    console.log('[CONFIG] FAIL (reason=node_version_below_20)')
    return EXIT.CONFIG
  }

  const checked = validateConfig(env)
  if (!checked.ok) {
    if (checked.missing.length > 0) console.log(`[CONFIG] FAIL (missing variables: ${checked.missing.join(', ')})`)
    else console.log(`[CONFIG] FAIL (reason=${checked.reason})`)
    rows.push({ stage: 'config', status: 'FAIL', http: '', detail: checked.missing.length > 0 ? `missing:${checked.missing.join('+')}` : checked.reason })
    writeSummary(rows, EXIT.CONFIG)
    return EXIT.CONFIG
  }

  const code = await runCheck(checked.config, { summaryRows: rows })
  writeSummary(rows, code)
  return code
}

// Last-resort handlers print a class only: error messages and stacks may
// contain request fragments.
function installSafetyNets() {
  const bail = () => {
    console.log('[INTERNAL] FAIL (unexpected error; details suppressed)')
    process.exit(EXIT.INTERNAL)
  }
  process.on('uncaughtException', bail)
  process.on('unhandledRejection', bail)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installSafetyNets()
  main().then(code => { process.exitCode = code })
}
