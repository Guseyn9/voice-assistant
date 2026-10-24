#!/usr/bin/env node
/**
 * Taxi recipient check — read-only look at `site_emails` (Stage 4).
 *
 * Answers two questions about the report recipient lookup used by the
 * Validation Bench (apps/voice-demo/src/BackendClient.ts, getEmailId):
 *   1. Does GET /api/v1/data/?json_like={"site_emails":true} need authorisation?
 *   2. What does the answer look like (shape, number of candidates)?
 *
 * Modes (RECIPIENT_CHECK_MODE, one /data/ request per run):
 *   public        GET without any credentials, exactly like the Bench does today.
 *   query_token   one /auth + one /token, then GET with `token` and `u_hash` as
 *                 query parameters (the Taxi convention is to send both with
 *                 every authorised call).
 *
 * Safety rules (covered by tests/node/taxi-recipient-check.test.mjs):
 *  - exactly one /data/ request, no retries, no write/POST to /data/;
 *  - never touches /mail/ and never selects a recipient: a result with several
 *    candidates is reported as ambiguous;
 *  - recipient VALUES (addresses) are never printed — only ids, the JSON type of
 *    each value and whether it looks like an e-mail address;
 *  - credentials, tokens, hashes and response bodies are never printed; server
 *    messages only if they are short plain words and contain no secret;
 *  - public mode never reads or sends credentials.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  EXIT as BASE_EXIT,
  describe,
  extractSession,
  interpretAuth,
  interpretToken,
  nonEmptyString,
  sendRequest,
  toStage,
  validateConfig,
} from './taxi-auth-check.mjs'

export const EXIT = Object.freeze({ ...BASE_EXIT, RECIPIENT_EMPTY: 70, RECIPIENT_MISSING: 71 })

const MODES = Object.freeze(['public', 'query_token'])
const REQUEST_TIMEOUT_MS = 20_000
const MAX_LISTED_ENTRIES = 20
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,32}$/
const EMAIL_LIKE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Only an explicit allow-list of variables is looked at; in public mode credentials are never read. */
export function validateRecipientConfig(env = process.env) {
  const mode = env.RECIPIENT_CHECK_MODE
  if (!MODES.includes(mode)) return { ok: false, missing: [], reason: 'invalid_mode' }

  const shared = {
    VITE_BACKEND_URL: env.VITE_BACKEND_URL,
    NODE_TLS_REJECT_UNAUTHORIZED: env.NODE_TLS_REJECT_UNAUTHORIZED,
    TAXI_AUTH_CHECK_ALLOW_LOOPBACK: env.TAXI_AUTH_CHECK_ALLOW_LOOPBACK,
  }
  const checked = mode === 'public'
    ? validateConfig({ ...shared, E2E_DRIVER_LOGIN: 'unused', E2E_DRIVER_PASSWORD: 'unused' })
    : validateConfig({
      ...shared,
      E2E_DRIVER_LOGIN: env.E2E_DRIVER_LOGIN,
      E2E_DRIVER_PASSWORD: env.E2E_DRIVER_PASSWORD,
      E2E_DRIVER_TYPE: env.E2E_DRIVER_TYPE,
    })
  if (!checked.ok) return checked

  const { baseUrl, login, password, type } = checked.config
  return {
    ok: true,
    config: mode === 'public' ? { mode, baseUrl } : { mode, baseUrl, login, password, type },
  }
}

// ---------------------------------------------------------------------------
// Response analysis (pure; never returns recipient values)
// ---------------------------------------------------------------------------

const safeNames = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const names = Object.keys(value)
  const safe = [...new Set(names.filter(name => SAFE_NAME.test(name)))].sort()
  return names.length > safe.length ? [...safe, '<other>'] : safe
}

/** A server message is shown only if it is short plain words without any secret. */
export function safeMessage(message, secrets = []) {
  if (typeof message !== 'string') return 'no_message'
  if (message.length > 60 || !/^[A-Za-z][A-Za-z _.,'-]*$/.test(message)) return 'hidden_message'
  const lower = message.toLowerCase()
  if (secrets.some(secret => nonEmptyString(secret) && lower.includes(secret.toLowerCase()))) return 'hidden_message'
  return message
}

/**
 * Interprets a parsed /data/ answer. Returns one of:
 *   { kind: 'app_error', message }
 *   { kind: 'missing', topKeys, dataKeys }
 *   { kind: 'bad_format', detail }
 *   { kind: 'empty', path, type }
 *   { kind: 'found', path, type, count, entries: [{ id, valueType, looksLikeEmail, valueKeys }] }
 */
export function analyzeRecipients(json, secrets = []) {
  const isError = typeof json.status === 'string' && json.status.toLowerCase() === 'error'
  if (isError) return { kind: 'app_error', message: safeMessage(json.message, secrets) }

  const deep = json.data?.data?.site_emails
  const shallow = json.data?.site_emails
  const path = deep !== undefined ? 'data.data.site_emails' : shallow !== undefined ? 'data.site_emails' : null
  if (path === null) return { kind: 'missing', topKeys: safeNames(json), dataKeys: safeNames(json.data) }

  const node = deep !== undefined ? deep : shallow
  if (node === null || typeof node !== 'object') return { kind: 'bad_format', detail: 'site_emails_not_object_or_array' }

  const type = Array.isArray(node) ? 'array' : 'object'
  const all = Array.isArray(node) ? node.map((value, index) => [String(index), value]) : Object.entries(node)
  if (all.length === 0) return { kind: 'empty', path, type }

  const entries = all.slice(0, MAX_LISTED_ENTRIES).map(([id, value]) => ({
    id: SAFE_ID.test(id) ? id : '<masked>',
    valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    looksLikeEmail: typeof value === 'string' && EMAIL_LIKE.test(value),
    valueKeys: value !== null && typeof value === 'object' && !Array.isArray(value) ? safeNames(value) : [],
  }))
  return { kind: 'found', path, type, count: all.length, entries }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function buildDataUrl(baseUrl, session) {
  const query = `json_like=${encodeURIComponent(JSON.stringify({ site_emails: true }))}`
  const auth = session
    ? `&token=${encodeURIComponent(session.token)}&u_hash=${encodeURIComponent(session.uHash)}`
    : ''
  return `${baseUrl}/api/v1/data/?${query}${auth}`
}

export async function runRecipientCheck(config, {
  fetchImpl = fetch,
  log = console.log,
  timeoutMs = REQUEST_TIMEOUT_MS,
  summaryRows = [],
} = {}) {
  const counts = { auth: 0, token: 0, data: 0 }
  const finish = exit => {
    log(`[INFO] requests sent: auth=${counts.auth}, token=${counts.token}, data=${counts.data}, retries=0`)
    return exit
  }
  const row = (stage, status, http, detail) => summaryRows.push({ stage, status, http: http ?? '', detail: detail ?? '' })
  const fail = (label, stage) => {
    log(`[RECIPIENT] ${label}: FAIL (${describe(stage)})`)
    if (stage.delivery === 'unknown')
      log('[RECIPIENT] NOTE: the server may or may not have processed this request. It was NOT retried.')
    row(label, 'FAIL', stage.httpStatus, stage.cls + (stage.detail ? `:${stage.detail}` : ''))
  }

  log(`[CONFIG] VITE_BACKEND_URL${config.mode === 'public' ? '' : ', E2E_DRIVER_LOGIN, E2E_DRIVER_PASSWORD'} present and valid: PASS (mode=${config.mode})`)
  log(`[RECIPIENT] mode=${config.mode} auth_sent=${config.mode === 'public' ? 'false' : 'true'}`)

  let session = null
  if (config.mode === 'query_token') {
    counts.auth += 1
    const authRound = await sendRequest(`${config.baseUrl}/api/v1/auth`, {
      method: 'POST',
      fields: { login: config.login, password: config.password, type: config.type },
      fetchImpl,
      timeoutMs,
    })
    const auth = toStage('auth', authRound, interpretAuth)
    if (!auth.ok) {
      log(`[AUTH] POST /auth: FAIL (${describe(auth)})`)
      row('POST /auth', 'FAIL', auth.httpStatus, auth.cls)
      return finish(auth.exit)
    }
    log(`[AUTH] POST /auth: PASS (HTTP ${auth.httpStatus}, ${auth.ms} ms)`)
    row('POST /auth', 'PASS', auth.httpStatus)

    counts.token += 1
    const tokenRound = await sendRequest(`${config.baseUrl}/api/v1/token`, {
      method: 'POST',
      fields: { auth_hash: auth.authHash },
      fetchImpl,
      timeoutMs,
    })
    const token = toStage('token', tokenRound, interpretToken)
    if (!token.ok) {
      log(`[AUTH] POST /token: FAIL (${describe(token)})`)
      row('POST /token', 'FAIL', token.httpStatus, token.cls)
      return finish(token.exit)
    }
    log(`[AUTH] POST /token: PASS (HTTP ${token.httpStatus}, ${token.ms} ms)`)
    row('POST /token', 'PASS', token.httpStatus)
    session = extractSession(tokenRound.json)
  }

  // The single /data/ request.
  counts.data += 1
  const label = 'GET /data/ site_emails'
  const round = await sendRequest(buildDataUrl(config.baseUrl, session), { method: 'GET', fetchImpl, timeoutMs })
  const secrets = session ? [config.login, config.password, session.token, session.uHash] : []

  if (round.kind === 'network') { const s = toStage('data', round); fail(label, s); return finish(s.exit) }
  if (round.kind === 'http') {
    const s = toStage('data', round)
    fail(label, s)
    if (round.status === 401 || round.status === 403)
      log('[RECIPIENT] HINT: the endpoint refused this request; authorisation is likely required (not proven).')
    return finish(s.exit)
  }
  if (round.kind === 'format') { const s = toStage('data', round); fail(label, s); return finish(s.exit) }

  log(`[RECIPIENT] ${label}: PASS (HTTP ${round.status}, ${round.ms} ms)`)
  const analysis = analyzeRecipients(round.json, secrets)

  switch (analysis.kind) {
    case 'app_error':
      log(`[RECIPIENT] RESULT: APP_ERROR (HTTP ${round.status}, status:"error", message="${analysis.message}")`)
      if (config.mode === 'public')
        log('[RECIPIENT] HINT: an application error without credentials can mean that authorisation is required (not proven).')
      row(label, 'FAIL', round.status, `APP_ERROR:${analysis.message}`)
      return finish(EXIT.APP)
    case 'bad_format':
      log(`[RECIPIENT] RESULT: BAD_FORMAT (${analysis.detail})`)
      row(label, 'FAIL', round.status, `BAD_FORMAT:${analysis.detail}`)
      return finish(EXIT.FORMAT)
    case 'missing':
      log(`[RECIPIENT] RESULT: SITE_EMAILS_MISSING (top-level keys: ${analysis.topKeys.join(',') || '-'}; data keys: ${analysis.dataKeys.join(',') || '-'})`)
      row(label, 'FAIL', round.status, 'SITE_EMAILS_MISSING')
      return finish(EXIT.RECIPIENT_MISSING)
    case 'empty':
      log(`[RECIPIENT] response shape: found at ${analysis.path}, type=${analysis.type}, entries=0`)
      log('[RECIPIENT] RESULT: EMPTY (site_emails has no entries)')
      row(label, 'FAIL', round.status, 'EMPTY')
      return finish(EXIT.RECIPIENT_EMPTY)
    default: {
      log(`[RECIPIENT] response shape: found at ${analysis.path}, type=${analysis.type}, entries=${analysis.count}`)
      for (const entry of analysis.entries) {
        const keys = entry.valueKeys.length > 0 ? ` value_keys=${entry.valueKeys.join(',')}` : ''
        log(`[RECIPIENT] entry id=${entry.id} value_type=${entry.valueType} looks_like_email=${entry.looksLikeEmail}${keys}`)
      }
      if (analysis.count > analysis.entries.length) log(`[RECIPIENT] (${analysis.count - analysis.entries.length} more entries not listed)`)
      const verdict = analysis.count === 1 ? 'FOUND_SINGLE' : 'FOUND_AMBIGUOUS'
      log(`[RECIPIENT] RESULT: ${verdict} (${analysis.count} candidate${analysis.count === 1 ? '' : 's'}; no recipient was selected; nothing was sent)`)
      row(label, 'PASS', round.status, `${verdict}:${analysis.count}`)
      return finish(EXIT.OK)
    }
  }
}

function writeSummary(rows, exitCode, mode) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  const lines = [
    `### Taxi recipient check (mode: ${mode})`,
    '',
    '| stage | status | HTTP | result |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${row.stage} | ${row.status} | ${row.http} | ${row.detail} |`),
    '',
    `Exit code: ${exitCode}`,
    '',
  ]
  try {
    fs.appendFileSync(file, lines.join('\n'))
  } catch {
    // The summary is a convenience; the log lines are authoritative.
  }
}

export async function main(env = process.env) {
  const rows = []
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.log('[CONFIG] FAIL (reason=node_version_below_20)')
    return EXIT.CONFIG
  }
  const checked = validateRecipientConfig(env)
  if (!checked.ok) {
    if (checked.missing.length > 0) console.log(`[CONFIG] FAIL (missing variables: ${checked.missing.join(', ')})`)
    else console.log(`[CONFIG] FAIL (reason=${checked.reason})`)
    rows.push({ stage: 'config', status: 'FAIL', http: '', detail: checked.missing.length > 0 ? `missing:${checked.missing.join('+')}` : checked.reason })
    writeSummary(rows, EXIT.CONFIG, 'unknown')
    return EXIT.CONFIG
  }
  const code = await runRecipientCheck(checked.config, { summaryRows: rows })
  writeSummary(rows, code, checked.config.mode)
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bail = () => {
    console.log('[INTERNAL] FAIL (unexpected error; details suppressed)')
    process.exit(EXIT.INTERNAL)
  }
  process.on('uncaughtException', bail)
  process.on('unhandledRejection', bail)
  main().then(code => { process.exitCode = code })
}
