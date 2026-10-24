/**
 * Offline tests for scripts/taxi-auth-check.mjs.
 *
 * These are MOCK tests of the classifier and of the output hygiene. They talk to
 * servers on 127.0.0.1 that this file starts itself, with obviously fictitious
 * credentials. They do not touch the real Taxi API and prove nothing about it.
 *
 * Run: node --test tests/node/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT, classifyFetchError, runCheck, validateConfig } from '../../scripts/taxi-auth-check.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/taxi-auth-check.mjs', import.meta.url))

// Fictitious values: none of them may ever appear in the output.
const FAKE = {
  login: 'FAKE_LOGIN_user.nobody@example.test',
  password: 'FAKE_PASSWORD_pw-0000',
  authHash: 'FAKE_AUTH_HASH_aaaa1111',
  token: 'FAKE_TOKEN_bbbb2222',
  uHash: 'FAKE_UHASH_cccc3333',
  email: 'FAKE_PERSON_dddd4444@example.test',
  serverNote: 'FAKE_SERVER_NOTE_eeee5555',
}
const FAKE_VALUES = Object.values(FAKE)

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

/** Starts a loopback server; `handler(req, res, body, calls)` answers. */
async function startServer(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const call = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        form: Object.fromEntries(new URLSearchParams(body)),
      }
      calls.push(call)
      handler(req, res, call, calls)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    calls,
    baseUrl: `http://127.0.0.1:${port}/taxi/c/gruzvill`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

const configFor = baseUrl => {
  const checked = validateConfig({
    VITE_BACKEND_URL: baseUrl,
    E2E_DRIVER_LOGIN: FAKE.login,
    E2E_DRIVER_PASSWORD: FAKE.password,
    TAXI_AUTH_CHECK_ALLOW_LOOPBACK: '1',
  })
  assert.ok(checked.ok, 'test config must validate')
  return checked.config
}

/** Runs the check against `handler`; returns { code, output, calls }. */
async function scenario(handler, options = {}) {
  const server = await startServer(handler)
  const lines = []
  try {
    const code = await runCheck(configFor(server.baseUrl), { log: line => lines.push(line), ...options })
    // Give a (forbidden) retry time to show up before counting.
    await new Promise(resolve => setTimeout(resolve, 150))
    return { code, output: lines.join('\n'), calls: [...server.calls] }
  } finally {
    await server.close()
  }
}

const okAuth = (res) => json(res, 200, { code: '200', status: 'success', auth_hash: FAKE.authHash, auth_user: { u_email: FAKE.email } })
const okToken = (res) => json(res, 200, { code: '200', status: 'success', data: { token: FAKE.token, u_hash: FAKE.uHash, user: { u_email: FAKE.email } } })

const assertNoLeak = (text, extra = []) => {
  for (const value of [...FAKE_VALUES, ...extra])
    assert.ok(!text.includes(value), `output must not contain a fictitious secret/body fragment (${value.slice(0, 12)}…)`)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('config: missing variables are reported by name only', () => {
  const result = validateConfig({ VITE_BACKEND_URL: '', E2E_DRIVER_LOGIN: FAKE.login })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['VITE_BACKEND_URL', 'E2E_DRIVER_PASSWORD'])
  assertNoLeak(JSON.stringify(result))
})

test('config: rejects unsafe URLs without echoing them', () => {
  const base = { E2E_DRIVER_LOGIN: FAKE.login, E2E_DRIVER_PASSWORD: FAKE.password }
  const reason = url => validateConfig({ ...base, VITE_BACKEND_URL: url }).reason
  assert.equal(reason('not a url'), 'invalid_url')
  assert.equal(reason('http://ibronevik.ru/taxi/c/gruzvill'), 'insecure_scheme')
  assert.equal(reason('https://evil.example/taxi/c/gruzvill'), 'host_not_allowed')
  assert.equal(reason('https://user:pw@ibronevik.ru/taxi/c/gruzvill'), 'url_has_credentials')
  assert.equal(reason('https://ibronevik.ru/taxi/c/gruzvill?x=1'), 'url_has_query_or_fragment')
  assert.equal(reason('https://ibronevik.ru/taxi/c/gruzvill/api/v1'), 'url_already_has_api_v1')
  assert.equal(reason('http://127.0.0.1:9/x'), 'host_not_allowed', 'loopback needs the explicit test flag')
  assert.equal(validateConfig({ ...base, VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill/' }).config.baseUrl,
    'https://ibronevik.ru/taxi/c/gruzvill')
  assert.equal(validateConfig({ ...base, VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill' }).config.type, 'e-mail')
})

test('config: refuses to run with TLS verification disabled', () => {
  const result = validateConfig({
    VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill',
    E2E_DRIVER_LOGIN: FAKE.login,
    E2E_DRIVER_PASSWORD: FAKE.password,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'tls_verification_disabled')
})

// ---------------------------------------------------------------------------
// Error classification (synthetic errors shaped like undici/Node errors)
// ---------------------------------------------------------------------------

const fetchFailed = cause => Object.assign(new TypeError('fetch failed'), { cause })
const coded = (code, name = 'Error') => Object.assign(new Error(code), { code, name })

test('classify: DNS, TCP, TLS, timeouts and resets', () => {
  const cases = [
    [fetchFailed(coded('ENOTFOUND')), 'NETWORK_DNS', 'not_delivered'],
    [fetchFailed(coded('EAI_AGAIN')), 'NETWORK_DNS', 'not_delivered'],
    [fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT')), 'NETWORK_TCP_TIMEOUT', 'not_delivered'],
    [fetchFailed(coded('ECONNREFUSED')), 'NETWORK_TCP_FAILED', 'not_delivered'],
    [fetchFailed(coded('EHOSTUNREACH')), 'NETWORK_TCP_FAILED', 'not_delivered'],
    [fetchFailed(coded('CERT_HAS_EXPIRED')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('DEPTH_ZERO_SELF_SIGNED_CERT')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('ERR_TLS_CERT_ALTNAME_INVALID')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('ERR_SSL_WRONG_VERSION_NUMBER')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('EPROTO')), 'NETWORK_TLS', 'not_delivered'],
    [fetchFailed(coded('ETIMEDOUT')), 'NETWORK_TCP_TIMEOUT', 'unknown'],
    [fetchFailed(coded('ECONNRESET')), 'NETWORK_CONNECTION_LOST', 'unknown'],
    [fetchFailed(coded('UND_ERR_SOCKET')), 'NETWORK_CONNECTION_LOST', 'unknown'],
    [fetchFailed(coded('UND_ERR_HEADERS_TIMEOUT')), 'NETWORK_CONNECTION_LOST', 'unknown'],
    [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'NETWORK_TIMEOUT', 'unknown'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'NETWORK_TIMEOUT', 'unknown'],
    [fetchFailed(Object.assign(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')]), { code: undefined })),
      'NETWORK_TCP_FAILED', 'not_delivered'],
  ]
  for (const [error, cls, delivery] of cases) {
    const got = classifyFetchError(error)
    assert.equal(got.cls, cls, `class for ${[...Object.keys(error)].join()} ${error.cause?.code ?? error.name}`)
    assert.equal(got.delivery, delivery, `delivery for ${cls}`)
  }
})

test('classify: unknown errors do not leak their message', () => {
  const got = classifyFetchError(fetchFailed(Object.assign(new Error(`boom ${FAKE.password}`), { code: 'weird code with spaces' })))
  assert.equal(got.cls, 'NETWORK_OTHER')
  assert.equal(got.delivery, 'unknown')
  assertNoLeak(JSON.stringify(got))
})

// ---------------------------------------------------------------------------
// Scenarios against a loopback mock
// ---------------------------------------------------------------------------

test('happy path: one /auth, one /token, exact request shape, no `au`', async () => {
  const { code, output, calls } = await scenario((req, res) => (req.url.endsWith('/auth') ? okAuth(res) : okToken(res)))
  assert.equal(code, EXIT.OK)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
    'POST /taxi/c/gruzvill/api/v1/auth',
    'POST /taxi/c/gruzvill/api/v1/token',
  ])
  assert.match(calls[0].contentType, /^application\/x-www-form-urlencoded/)
  assert.deepEqual(Object.keys(calls[0].form).sort(), ['login', 'password', 'type'], '/auth must not carry `au` or anything else')
  assert.equal(calls[0].form.type, 'e-mail')
  assert.deepEqual(Object.keys(calls[1].form), ['auth_hash'])
  assert.match(output, /POST \/auth: PASS/)
  assert.match(output, /auth_hash present: PASS/)
  assert.match(output, /POST \/token: PASS/)
  assert.match(output, /token and u_hash present: PASS/)
  assert.match(output, /retries=0/)
  assertNoLeak(output)
})

test('HTTP 200 + status:"error" is an application error, /token is not sent', async () => {
  const { code, output, calls } = await scenario((req, res) =>
    json(res, 200, { code: '200', status: 'error', message: 'wrong password', note: FAKE.serverNote }))
  assert.equal(code, EXIT.APP)
  assert.equal(calls.length, 1)
  assert.match(output, /class=APP_ERROR, detail=wrong_password, HTTP 200/)
  assert.match(output, /POST \/token: SKIPPED/)
  assertNoLeak(output)
})

test('known message without status field is still an application error', async () => {
  const { code, output, calls } = await scenario((req, res) => json(res, 200, { message: 'wrong login' }))
  assert.equal(code, EXIT.APP)
  assert.equal(calls.length, 1)
  assert.match(output, /detail=wrong_login/)
})

test('unlisted server message is never printed', async () => {
  const { code, output, calls } = await scenario((req, res) => json(res, 200, { status: 'error', message: FAKE.serverNote }))
  assert.equal(code, EXIT.APP)
  assert.equal(calls.length, 1)
  assert.match(output, /detail=unlisted_message/)
  assertNoLeak(output)
})

for (const status of [400, 401, 403, 404, 405, 500, 503]) {
  test(`HTTP ${status} on /auth: reported once, never retried, body ignored`, async () => {
    const { code, output, calls } = await scenario((req, res) => json(res, status, { status: 'error', message: FAKE.serverNote }))
    assert.equal(code, EXIT.HTTP)
    assert.equal(calls.length, 1)
    assert.match(output, new RegExp(`class=HTTP_ERROR_${status}, HTTP ${status}`))
    assertNoLeak(output)
  })
}

test('HTTP redirect is reported, not followed', async () => {
  const { code, output, calls } = await scenario((req, res) => { res.writeHead(302, { Location: '/elsewhere' }); res.end() })
  assert.equal(code, EXIT.HTTP)
  assert.equal(calls.length, 1)
  assert.match(output, /HTTP_ERROR_302/)
})

test('invalid JSON and non-object JSON are format errors', async () => {
  for (const body of ['<html>nope</html>', '[]', '"text"', 'null', '']) {
    const { code, output, calls } = await scenario((req, res) => json(res, 200, body))
    assert.equal(code, EXIT.FORMAT, `body ${JSON.stringify(body)}`)
    assert.equal(calls.length, 1)
    assert.match(output, /class=BAD_FORMAT/)
  }
})

test('oversized body is a format error', async () => {
  const { code, output, calls } = await scenario((req, res) => json(res, 200, JSON.stringify({ pad: 'a'.repeat(1_000_001) })))
  assert.equal(code, EXIT.FORMAT)
  assert.equal(calls.length, 1)
  assert.match(output, /class=BAD_FORMAT, detail=body_too_large/)
})

test('missing or empty auth_hash is a missing-field error', async () => {
  for (const body of [{ status: 'success' }, { auth_hash: '' }, { auth_hash: 123 }, { auth_hash: null }]) {
    const { code, output, calls } = await scenario((req, res) => json(res, 200, body))
    assert.equal(code, EXIT.FORMAT)
    assert.equal(calls.length, 1)
    assert.match(output, /class=MISSING_FIELD, detail=auth_hash/)
  }
})

test('/token failures: status:"error", missing fields and HTTP errors; exactly one request each', async () => {
  const tokenBodies = [
    [{ status: 'error', message: 'wrong auth hash' }, EXIT.APP, /APP_ERROR, detail=unlisted_message/],
    [{ data: { u_hash: FAKE.uHash } }, EXIT.FORMAT, /MISSING_FIELD, detail=token/],
    [{ data: { token: FAKE.token } }, EXIT.FORMAT, /MISSING_FIELD, detail=u_hash/],
    [{ data: {} }, EXIT.FORMAT, /MISSING_FIELD, detail=token\+u_hash/],
    [{ status: 'success' }, EXIT.FORMAT, /MISSING_FIELD, detail=data/],
    [{ data: [FAKE.token] }, EXIT.FORMAT, /MISSING_FIELD, detail=data/],
  ]
  for (const [body, exit, pattern] of tokenBodies) {
    const { code, output, calls } = await scenario((req, res) => (req.url.endsWith('/auth') ? okAuth(res) : json(res, 200, body)))
    assert.equal(code, exit)
    assert.equal(calls.length, 2, '/auth once, /token once')
    assert.match(output, pattern)
    assertNoLeak(output)
  }
  const http500 = await scenario((req, res) => (req.url.endsWith('/auth') ? okAuth(res) : json(res, 500, {})))
  assert.equal(http500.code, EXIT.HTTP)
  assert.equal(http500.calls.length, 2)
  assert.match(http500.output, /POST \/token: FAIL \(class=HTTP_ERROR_500/)
})

test('timeout: classified as ambiguous, reported once, never retried', async () => {
  const { code, output, calls } = await scenario(() => { /* never answers */ }, { timeoutMs: 300 })
  assert.equal(code, EXIT.NETWORK)
  assert.equal(calls.length, 1, 'the request reached the server exactly once')
  assert.match(output, /class=NETWORK_TIMEOUT.*delivery=unknown/)
  assert.match(output, /may or may not have processed this request. It was NOT retried/)
  assert.match(output, /POST \/token: SKIPPED/)
})

test('connection refused: classified as not delivered', async () => {
  const server = await startServer(() => {})
  const baseUrl = server.baseUrl
  await server.close()
  const lines = []
  const code = await runCheck(configFor(baseUrl), { log: line => lines.push(line) })
  assert.equal(code, EXIT.NETWORK)
  assert.match(lines.join('\n'), /class=NETWORK_TCP_FAILED.*delivery=not_delivered/)
  assertNoLeak(lines.join('\n'))
})

test('TLS failure (https against a plain-http port): classified as TLS, not delivered', async () => {
  const server = await startServer((req, res) => json(res, 200, {}))
  try {
    const config = configFor(`https://127.0.0.1:${server.port}/taxi/c/gruzvill`)
    const lines = []
    const code = await runCheck(config, { log: line => lines.push(line) })
    assert.equal(code, EXIT.NETWORK)
    assert.match(lines.join('\n'), /class=NETWORK_TLS.*delivery=not_delivered/)
    assert.equal(server.calls.length, 0, 'no application request can have been delivered')
    assertNoLeak(lines.join('\n'))
  } finally {
    await server.close()
  }
})

test('connection dropped after the request was sent: ambiguous, not retried', async () => {
  const { code, output, calls } = await scenario((req, res) => req.socket.destroy())
  assert.equal(code, EXIT.NETWORK)
  assert.equal(calls.length, 1)
  assert.match(output, /class=NETWORK_CONNECTION_LOST.*delivery=unknown/)
})

// ---------------------------------------------------------------------------
// The CLI as a child process: exit codes, stdout/stderr and step summary
// ---------------------------------------------------------------------------

function runCli(env) {
  return new Promise(resolve => {
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taxi-auth-check-')), 'summary.md')
    fs.writeFileSync(summary, '')
    const childEnv = { ...process.env, GITHUB_STEP_SUMMARY: summary }
    for (const name of ['VITE_BACKEND_URL', 'E2E_DRIVER_LOGIN', 'E2E_DRIVER_PASSWORD', 'E2E_DRIVER_TYPE',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'TAXI_AUTH_CHECK_ALLOW_LOOPBACK']) delete childEnv[name]
    Object.assign(childEnv, env)
    const child = spawn(process.execPath, [SCRIPT], { env: childEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr, summary: fs.readFileSync(summary, 'utf8') }))
  })
}

const cliEnv = baseUrl => ({
  VITE_BACKEND_URL: baseUrl,
  E2E_DRIVER_LOGIN: FAKE.login,
  E2E_DRIVER_PASSWORD: FAKE.password,
  TAXI_AUTH_CHECK_ALLOW_LOOPBACK: '1',
})

test('cli: success prints stage lines only; stdout, stderr and summary contain no secrets or bodies', async () => {
  const server = await startServer((req, res) => (req.url.endsWith('/auth') ? okAuth(res) : okToken(res)))
  try {
    const result = await runCli(cliEnv(server.baseUrl))
    assert.equal(result.code, EXIT.OK)
    for (const text of [result.stdout, result.stderr, result.summary]) assertNoLeak(text, ['127.0.0.1'])
    assert.match(result.stdout, /\[AUTH\] token and u_hash present: PASS/)
    assert.match(result.summary, /\| POST \/auth \| PASS \| 200 \|/)
    assert.match(result.summary, /\| POST \/token \| PASS \| 200 \|/)
    assert.equal(result.stderr, '')
  } finally {
    await server.close()
  }
})

test('cli: failure modes keep the output clean', async () => {
  const modes = [
    [(req, res) => json(res, 200, { status: 'error', message: 'wrong password', note: FAKE.serverNote }), EXIT.APP],
    [(req, res) => json(res, 500, { message: FAKE.serverNote }), EXIT.HTTP],
    [(req, res) => json(res, 200, `<html>${FAKE.serverNote}</html>`), EXIT.FORMAT],
    [(req, res) => json(res, 200, { auth_user: { u_email: FAKE.email } }), EXIT.FORMAT],
  ]
  for (const [handler, expected] of modes) {
    const server = await startServer(handler)
    try {
      const result = await runCli(cliEnv(server.baseUrl))
      assert.equal(result.code, expected)
      assert.equal(server.calls.length, 1)
      for (const text of [result.stdout, result.stderr, result.summary]) assertNoLeak(text, ['127.0.0.1'])
    } finally {
      await server.close()
    }
  }
})

test('cli: missing variables exit 10, name the variables, send nothing', async () => {
  const result = await runCli({ E2E_DRIVER_LOGIN: FAKE.login })
  assert.equal(result.code, EXIT.CONFIG)
  assert.match(result.stdout, /missing variables: VITE_BACKEND_URL, E2E_DRIVER_PASSWORD/)
  assertNoLeak(result.stdout + result.stderr + result.summary)
})

test('cli: a disallowed host is rejected before any request', async () => {
  const result = await runCli({
    VITE_BACKEND_URL: 'https://evil.example/taxi/c/gruzvill',
    E2E_DRIVER_LOGIN: FAKE.login,
    E2E_DRIVER_PASSWORD: FAKE.password,
  })
  assert.equal(result.code, EXIT.CONFIG)
  assert.match(result.stdout, /reason=host_not_allowed/)
  assert.ok(!result.stdout.includes('evil.example'))
  assertNoLeak(result.stdout + result.stderr + result.summary)
})
