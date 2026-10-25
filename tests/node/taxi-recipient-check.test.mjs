/**
 * Offline tests for scripts/taxi-recipient-check.mjs.
 *
 * MOCK tests against servers on 127.0.0.1 started by this file, with obviously
 * fictitious credentials and recipients. They do not touch the real Taxi API.
 *
 * Run: node --test tests/node/taxi-recipient-check.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  EXIT,
  analyzeRecipients,
  buildDataUrl,
  runRecipientCheck,
  safeMessage,
  validateRecipientConfig,
} from '../../scripts/taxi-recipient-check.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/taxi-recipient-check.mjs', import.meta.url))

const FAKE = {
  login: 'FAKE_LOGIN_user.nobody@example.test',
  password: 'FAKE_PASSWORD_pw-0000',
  authHash: 'FAKE_AUTH_HASH_aaaa1111',
  token: 'FAKE_TOKEN_bbbb2222',
  uHash: 'FAKE_UHASH_cccc3333',
  recipientA: 'FAKE_RECIPIENT_aaaa@example.test',
  recipientB: 'FAKE_RECIPIENT_bbbb@example.test',
  objectEmail: 'FAKE_OBJECT_cccc@example.test',
  objectName: 'FAKE_NAME_Zed',
  serverNote: 'FAKE_SERVER_NOTE_eeee5555',
  testRecipient: 'FAKE_TESTBOX_dddd@example.test',
}
const FAKE_VALUES = Object.values(FAKE)

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function startServer(handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://127.0.0.1')
      const call = {
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        rawUrl: req.url,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
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

const envFor = (baseUrl, mode, extra = {}) => ({
  VITE_BACKEND_URL: baseUrl,
  RECIPIENT_CHECK_MODE: mode,
  E2E_DRIVER_LOGIN: FAKE.login,
  E2E_DRIVER_PASSWORD: FAKE.password,
  TAXI_AUTH_CHECK_ALLOW_LOOPBACK: '1',
  ...extra,
})

const configFor = (baseUrl, mode) => {
  const checked = validateRecipientConfig(envFor(baseUrl, mode))
  assert.ok(checked.ok, 'test config must validate')
  return checked.config
}

const emailsBody = site_emails => ({ code: '200', status: 'success', data: { version: '1', data: { site_emails } } })
const authOk = res => json(res, 200, { status: 'success', auth_hash: FAKE.authHash })
const tokenOk = res => json(res, 200, { status: 'success', data: { token: FAKE.token, u_hash: FAKE.uHash } })

/** Router: /auth, /token, /data/ answered by the given functions. */
const router = ({ data }) => (req, res, call) => {
  if (call.pathname.endsWith('/auth')) return authOk(res)
  if (call.pathname.endsWith('/token')) return tokenOk(res)
  return data(req, res, call)
}

async function scenario(mode, handler, options = {}) {
  const server = await startServer(handler)
  const lines = []
  try {
    const code = await runRecipientCheck(configFor(server.baseUrl, mode), { log: line => lines.push(line), ...options })
    await new Promise(resolve => setTimeout(resolve, 150))
    return { code, output: lines.join('\n'), calls: [...server.calls] }
  } finally {
    await server.close()
  }
}

const assertNoLeak = (text, extra = []) => {
  for (const value of [...FAKE_VALUES, ...extra])
    assert.ok(!text.includes(value), `output must not contain ${value.slice(0, 14)}…`)
}

const dataCalls = calls => calls.filter(call => call.pathname.endsWith('/data/'))

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('config: mode is mandatory and validated', () => {
  assert.equal(validateRecipientConfig({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill' }).reason, 'invalid_mode')
  assert.equal(validateRecipientConfig({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'post_token' }).reason, 'invalid_mode')
})

test('config: public mode needs no credentials and never carries them', () => {
  const result = validateRecipientConfig({
    VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill',
    RECIPIENT_CHECK_MODE: 'public',
    E2E_DRIVER_LOGIN: FAKE.login,
    E2E_DRIVER_PASSWORD: FAKE.password,
  })
  assert.ok(result.ok)
  assert.deepEqual(Object.keys(result.config).sort(), ['baseUrl', 'mode'])
})

test('config: query_token mode requires credentials (names only reported)', () => {
  const result = validateRecipientConfig({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'query_token' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['E2E_DRIVER_LOGIN', 'E2E_DRIVER_PASSWORD'])
})

test('config: URL rules of the auth check apply (host allow-list, https, no api/v1)', () => {
  const reason = url => validateRecipientConfig({ VITE_BACKEND_URL: url, RECIPIENT_CHECK_MODE: 'public' }).reason
  assert.equal(reason('https://evil.example/taxi/c/gruzvill'), 'host_not_allowed')
  assert.equal(reason('http://ibronevik.ru/taxi/c/gruzvill'), 'insecure_scheme')
  assert.equal(reason('https://ibronevik.ru/taxi/c/gruzvill/api/v1'), 'url_already_has_api_v1')
})

test('buildDataUrl: same json_like encoding as the Bench; token only when a session is given', () => {
  assert.equal(buildDataUrl('https://h/x', null), 'https://h/x/api/v1/data/?json_like=%7B%22site_emails%22%3Atrue%7D')
  assert.equal(buildDataUrl('https://h/x', { token: 'T 1', uHash: 'U&2' }),
    'https://h/x/api/v1/data/?json_like=%7B%22site_emails%22%3Atrue%7D&token=T%201&u_hash=U%262')
})

// ---------------------------------------------------------------------------
// Pure analysis
// ---------------------------------------------------------------------------

test('analyze: shapes, counts and value hygiene', () => {
  const deep = analyzeRecipients(emailsBody({ 2: FAKE.recipientA, 5: { e_email: FAKE.objectEmail, e_name: FAKE.objectName } }))
  assert.equal(deep.kind, 'found')
  assert.equal(deep.path, 'data.data.site_emails')
  assert.equal(deep.count, 2)
  assert.deepEqual(deep.entries.map(e => [e.id, e.valueType, e.looksLikeEmail]), [['2', 'string', true], ['5', 'object', false]])
  assert.deepEqual(deep.entries[1].valueKeys, ['e_email', 'e_name'])
  assertNoLeak(JSON.stringify(deep), [])

  assert.equal(analyzeRecipients({ data: { site_emails: { 1: FAKE.recipientA } } }).path, 'data.site_emails')
  assert.equal(analyzeRecipients(emailsBody([FAKE.recipientA])).type, 'array')
  assert.equal(analyzeRecipients(emailsBody({})).kind, 'empty')
  assert.equal(analyzeRecipients(emailsBody([])).kind, 'empty')
  assert.equal(analyzeRecipients(emailsBody('text')).kind, 'bad_format')
  assert.equal(analyzeRecipients(emailsBody(null)).kind, 'bad_format')
  assert.equal(analyzeRecipients({ data: { data: {} } }).kind, 'missing')
  assert.equal(analyzeRecipients({}).kind, 'missing')
  assert.equal(analyzeRecipients({ status: 'error', message: 'access denied' }).kind, 'app_error')
})

test('analyze: odd ids and key names are masked, listing is capped', () => {
  const found = analyzeRecipients(emailsBody({ [`id with spaces ${FAKE.serverNote}`]: { [`weird key ${FAKE.serverNote}`]: 1 } }))
  assert.equal(found.entries[0].id, '<masked>')
  assert.deepEqual(found.entries[0].valueKeys, ['<other>'])
  assertNoLeak(JSON.stringify(found))
  const many = analyzeRecipients(emailsBody(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [i + 1, FAKE.recipientA]))))
  assert.equal(many.count, 50)
  assert.equal(many.entries.length, 20)
})

test('safeMessage: only short plain words without secrets', () => {
  assert.equal(safeMessage('access denied'), 'access denied')
  assert.equal(safeMessage('wrong token 12345'), 'hidden_message')
  assert.equal(safeMessage('user@example.test'), 'hidden_message')
  assert.equal(safeMessage('x'.repeat(61)), 'hidden_message')
  assert.equal(safeMessage('hello secret world', ['SECRET']), 'hidden_message')
  assert.equal(safeMessage(undefined), 'no_message')
  assert.equal(safeMessage({}), 'no_message')
})

// ---------------------------------------------------------------------------
// Scenarios: public mode
// ---------------------------------------------------------------------------

test('public: exactly one GET /data/, no credentials of any kind, no /auth, /token or /mail', async () => {
  const { code, output, calls } = await scenario('public', (req, res) => json(res, 200, emailsBody({ 2: FAKE.recipientA })))
  assert.equal(code, EXIT.OK)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].pathname, '/taxi/c/gruzvill/api/v1/data/')
  assert.deepEqual(calls[0].query, { json_like: '{"site_emails":true}' })
  assert.equal(calls[0].cookie, undefined)
  assert.equal(calls[0].authorization, undefined)
  assert.match(output, /mode=public auth_sent=false/)
  assert.match(output, /RESULT: FOUND_SINGLE \(1 candidate; no recipient was selected; nothing was sent\)/)
  assert.match(output, /requests sent: auth=0, token=0, data=1, retries=0/)
  assertNoLeak(output)
})

test('public: several candidates are ambiguous — none is selected, values are not printed', async () => {
  const { code, output, calls } = await scenario('public', (req, res) => json(res, 200, emailsBody({
    2: FAKE.recipientA,
    7: FAKE.recipientB,
    9: { e_email: FAKE.objectEmail, e_name: FAKE.objectName },
  })))
  assert.equal(code, EXIT.OK)
  assert.equal(calls.length, 1)
  assert.match(output, /response shape: found at data\.data\.site_emails, type=object, entries=3/)
  assert.match(output, /entry id=2 value_type=string looks_like_email=true/)
  assert.match(output, /entry id=9 value_type=object looks_like_email=false value_keys=e_email,e_name/)
  assert.match(output, /RESULT: FOUND_AMBIGUOUS \(3 candidates; no recipient was selected/)
  assertNoLeak(output)
})

test('public: empty and missing site_emails are distinct results and distinct exit codes', async () => {
  const empty = await scenario('public', (req, res) => json(res, 200, emailsBody({})))
  assert.equal(empty.code, EXIT.RECIPIENT_EMPTY)
  assert.match(empty.output, /RESULT: EMPTY/)

  const missing = await scenario('public', (req, res) => json(res, 200, { status: 'success', data: { version: '1', data: {}, note: FAKE.serverNote } }))
  assert.equal(missing.code, EXIT.RECIPIENT_MISSING)
  assert.match(missing.output, /RESULT: SITE_EMAILS_MISSING \(top-level keys: data,status; data keys: data,note,version\)/)
  assertNoLeak(missing.output)
})

for (const status of [401, 403, 404, 500]) {
  test(`public: HTTP ${status} is reported once and never retried`, async () => {
    const { code, output, calls } = await scenario('public', (req, res) => json(res, status, { status: 'error', message: FAKE.serverNote }))
    assert.equal(code, EXIT.HTTP)
    assert.equal(calls.length, 1)
    assert.match(output, new RegExp(`class=HTTP_ERROR_${status}`))
    if (status === 401 || status === 403) assert.match(output, /authorisation is likely required \(not proven\)/)
    else assert.doesNotMatch(output, /authorisation is likely required/)
    assertNoLeak(output)
  })
}

test('public: HTTP 200 + status:"error" is an application error; plain messages shown, others hidden', async () => {
  const plain = await scenario('public', (req, res) => json(res, 200, { status: 'error', message: 'access denied' }))
  assert.equal(plain.code, EXIT.APP)
  assert.match(plain.output, /RESULT: APP_ERROR \(HTTP 200, status:"error", message="access denied"\)/)
  assert.match(plain.output, /can mean that authorisation is required \(not proven\)/)

  const secretive = await scenario('public', (req, res) => json(res, 200, { status: 'error', message: FAKE.serverNote }))
  assert.equal(secretive.code, EXIT.APP)
  assert.match(secretive.output, /message="hidden_message"/)
  assertNoLeak(secretive.output)
})

test('public: bad JSON, non-object and malformed site_emails are format errors', async () => {
  for (const body of ['<html></html>', '[]']) {
    const result = await scenario('public', (req, res) => json(res, 200, body))
    assert.equal(result.code, EXIT.FORMAT)
    assert.match(result.output, /BAD_FORMAT/)
  }
  const result = await scenario('public', (req, res) => json(res, 200, emailsBody('not-an-object')))
  assert.equal(result.code, EXIT.FORMAT)
  assert.match(result.output, /BAD_FORMAT \(site_emails_not_object_or_array\)/)
})

test('public: timeout is ambiguous and not retried; refused connection is not delivered', async () => {
  const slow = await scenario('public', () => { /* never answers */ }, { timeoutMs: 300 })
  assert.equal(slow.code, EXIT.NETWORK)
  assert.equal(slow.calls.length, 1)
  assert.match(slow.output, /class=NETWORK_TIMEOUT.*delivery=unknown/)
  assert.match(slow.output, /It was NOT retried/)

  const server = await startServer(() => {})
  const baseUrl = server.baseUrl
  await server.close()
  const lines = []
  const code = await runRecipientCheck(configFor(baseUrl, 'public'), { log: line => lines.push(line) })
  assert.equal(code, EXIT.NETWORK)
  assert.match(lines.join('\n'), /class=NETWORK_TCP_FAILED.*delivery=not_delivered/)
})

// ---------------------------------------------------------------------------
// Scenarios: query_token mode
// ---------------------------------------------------------------------------

test('query_token: one /auth, one /token, one /data/ with token and u_hash in the query; nothing printed', async () => {
  const { code, output, calls } = await scenario('query_token', router({
    data: (req, res) => json(res, 200, emailsBody({ 4: FAKE.recipientA })),
  }))
  assert.equal(code, EXIT.OK)
  assert.deepEqual(calls.map(call => `${call.method} ${call.pathname}`), [
    'POST /taxi/c/gruzvill/api/v1/auth',
    'POST /taxi/c/gruzvill/api/v1/token',
    'GET /taxi/c/gruzvill/api/v1/data/',
  ])
  assert.deepEqual(Object.keys(calls[0].form).sort(), ['login', 'password', 'type'], 'no `au`')
  assert.deepEqual(Object.keys(calls[1].form), ['auth_hash'])
  assert.deepEqual(calls[2].query, { json_like: '{"site_emails":true}', token: FAKE.token, u_hash: FAKE.uHash })
  assert.match(output, /mode=query_token auth_sent=true/)
  assert.match(output, /requests sent: auth=1, token=1, data=1, retries=0/)
  assertNoLeak(output)
})

test('query_token: a failed /auth or /token stops before /data/ and is not retried', async () => {
  const authFailure = await scenario('query_token', (req, res) => json(res, 200, { status: 'error', message: 'wrong password' }))
  assert.equal(authFailure.code, EXIT.APP)
  assert.equal(authFailure.calls.length, 1)
  assert.match(authFailure.output, /requests sent: auth=1, token=0, data=0/)

  const tokenFailure = await scenario('query_token', (req, res, call) =>
    (call.pathname.endsWith('/auth') ? authOk(res) : json(res, 500, {})))
  assert.equal(tokenFailure.code, EXIT.HTTP)
  assert.equal(tokenFailure.calls.length, 2)
  assert.match(tokenFailure.output, /requests sent: auth=1, token=1, data=0/)
  assertNoLeak(authFailure.output + tokenFailure.output)
})

test('query_token: a refusal on /data/ is reported once; a message containing a secret is hidden', async () => {
  const refused = await scenario('query_token', router({ data: (req, res) => json(res, 403, {}) }))
  assert.equal(refused.code, EXIT.HTTP)
  assert.equal(dataCalls(refused.calls).length, 1)

  const echo = await scenario('query_token', router({
    data: (req, res) => json(res, 200, { status: 'error', message: `bad token ${FAKE.token}` }),
  }))
  assert.equal(echo.code, EXIT.APP)
  assert.match(echo.output, /message="hidden_message"/)
  assertNoLeak(echo.output)

  const echoWord = await scenario('query_token', router({
    data: (req, res) => json(res, 200, { status: 'error', message: `access for ${FAKE.login.toLowerCase()} denied` }),
  }))
  assert.match(echoWord.output, /message="hidden_message"/)
})

// ---------------------------------------------------------------------------
// The CLI as a child process
// ---------------------------------------------------------------------------

function runCli(env) {
  return new Promise(resolve => {
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taxi-recipient-check-')), 'summary.md')
    fs.writeFileSync(summary, '')
    const childEnv = { ...process.env, GITHUB_STEP_SUMMARY: summary }
    for (const name of ['VITE_BACKEND_URL', 'E2E_DRIVER_LOGIN', 'E2E_DRIVER_PASSWORD', 'E2E_DRIVER_TYPE',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'TAXI_AUTH_CHECK_ALLOW_LOOPBACK', 'RECIPIENT_CHECK_MODE']) delete childEnv[name]
    Object.assign(childEnv, env)
    const child = spawn(process.execPath, [SCRIPT], { env: childEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr, summary: fs.readFileSync(summary, 'utf8') }))
  })
}

test('cli public: credentials present in the environment are ignored — one credential-free GET', async () => {
  const server = await startServer((req, res) => json(res, 200, emailsBody({ 2: FAKE.recipientA, 3: FAKE.recipientB })))
  try {
    const result = await runCli(envFor(server.baseUrl, 'public'))
    assert.equal(result.code, EXIT.OK)
    assert.equal(server.calls.length, 1)
    assert.equal(server.calls[0].pathname, '/taxi/c/gruzvill/api/v1/data/')
    assert.ok(!server.calls[0].rawUrl.includes('token'))
    for (const value of [FAKE.login, FAKE.password]) assert.ok(!JSON.stringify(server.calls).includes(value), 'credentials must not reach the server in public mode')
    for (const text of [result.stdout, result.stderr, result.summary]) assertNoLeak(text, ['127.0.0.1'])
    assert.match(result.summary, /\| GET \/data\/ site_emails \| PASS \| 200 \| FOUND_AMBIGUOUS:2 \|/)
    assert.equal(result.stderr, '')
  } finally {
    await server.close()
  }
})

test('cli query_token: output, stderr and summary stay clean', async () => {
  const server = await startServer(router({ data: (req, res) => json(res, 200, emailsBody({ 2: FAKE.recipientA })) }))
  try {
    const result = await runCli(envFor(server.baseUrl, 'query_token'))
    assert.equal(result.code, EXIT.OK)
    assert.equal(server.calls.length, 3)
    for (const text of [result.stdout, result.stderr, result.summary]) assertNoLeak(text, ['127.0.0.1'])
  } finally {
    await server.close()
  }
})

test('cli: invalid or missing mode, missing credentials and disallowed hosts exit 10 without any request', async () => {
  const noMode = await runCli({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill' })
  assert.equal(noMode.code, EXIT.CONFIG)
  assert.match(noMode.stdout, /reason=invalid_mode/)

  const noCreds = await runCli({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'query_token' })
  assert.equal(noCreds.code, EXIT.CONFIG)
  assert.match(noCreds.stdout, /missing variables: E2E_DRIVER_LOGIN, E2E_DRIVER_PASSWORD/)

  const badHost = await runCli({ VITE_BACKEND_URL: 'https://evil.example/x', RECIPIENT_CHECK_MODE: 'public' })
  assert.equal(badHost.code, EXIT.CONFIG)
  assert.ok(!badHost.stdout.includes('evil.example'))
})

// ---------------------------------------------------------------------------
// public_match: which id equals the agreed test address (addresses never printed)
// ---------------------------------------------------------------------------

/** Entries shaped like the real answer: objects with a `value` field and localised texts. */
const objectEntry = value => ({ value, about_en: 'Label', about_ru: 'Метка', en: 'x', ru: 'y' })
const matchEnv = (baseUrl, extra = {}) => envFor(baseUrl, 'public_match', { E2E_TEST_RECIPIENT: FAKE.testRecipient, ...extra })

async function matchScenario(entries, { testRecipient = FAKE.testRecipient } = {}) {
  const server = await startServer((req, res) => json(res, 200, emailsBody(entries)))
  const lines = []
  try {
    const checked = validateRecipientConfig({ ...matchEnv(server.baseUrl), E2E_TEST_RECIPIENT: testRecipient })
    assert.ok(checked.ok)
    const code = await runRecipientCheck(checked.config, { log: line => lines.push(line) })
    await new Promise(resolve => setTimeout(resolve, 100))
    return { code, output: lines.join('\n'), calls: [...server.calls] }
  } finally {
    await server.close()
  }
}

test('public_match config: needs the test address, validates it, carries no login', () => {
  const base = { VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'public_match' }
  assert.deepEqual(validateRecipientConfig(base).missing, ['E2E_TEST_RECIPIENT'])
  assert.equal(validateRecipientConfig({ ...base, E2E_TEST_RECIPIENT: 'not an address' }).reason, 'invalid_test_recipient')
  const ok = validateRecipientConfig({ ...base, E2E_TEST_RECIPIENT: `  ${FAKE.testRecipient} `, E2E_DRIVER_LOGIN: FAKE.login, E2E_DRIVER_PASSWORD: FAKE.password })
  assert.ok(ok.ok)
  assert.deepEqual(Object.keys(ok.config).sort(), ['baseUrl', 'mode', 'testRecipient'])
  assert.equal(ok.config.testRecipient, FAKE.testRecipient)
})

test('analyze with a test address: matches by field or self, case-insensitive and trimmed', () => {
  const found = analyzeRecipients(emailsBody({
    1: objectEntry(FAKE.recipientA),
    2: objectEntry(`  ${FAKE.testRecipient.toUpperCase()} `),
    3: FAKE.testRecipient,
    4: { other_field: FAKE.testRecipient },
    5: { 'unsafe key! FAKE_SERVER_NOTE_eeee5555': FAKE.testRecipient },
  }), [], FAKE.testRecipient)
  assert.deepEqual(found.entries.map(entry => [entry.id, entry.match]), [['1', null], ['2', 'value'], ['3', '(self)'], ['4', 'other_field'], ['5', '<other>']])
  assert.equal(found.entries[0].valueFieldType, 'string')
  assert.equal(found.entries[0].valueFieldLooksLikeEmail, true)
  assertNoLeak(JSON.stringify(found))
  assert.equal(analyzeRecipients(emailsBody({ 1: FAKE.recipientA })).entries[0].match, undefined)
})

test('public_match: exactly one match is reported by id; one credential-free GET; no address printed', async () => {
  const { code, output, calls } = await matchScenario({ 1: objectEntry(FAKE.recipientA), 2: objectEntry(FAKE.testRecipient) })
  assert.equal(code, EXIT.OK)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].pathname, '/taxi/c/gruzvill/api/v1/data/')
  assert.ok(!JSON.stringify(calls).includes(FAKE.testRecipient), 'the test address must never be sent to the server')
  assert.match(output, /mode=public_match auth_sent=false/)
  assert.match(output, /entry id=1 .*value_field=string value_field_looks_like_email=true matches_test_recipient=false$/m)
  assert.match(output, /entry id=2 .*matches_test_recipient=true in=value$/m)
  assert.match(output, /RESULT: MATCH_SINGLE \(the agreed test address is entry id=2; nothing was sent\)/)
  assert.match(output, /requests sent: auth=0, token=0, data=1, retries=0/)
  assertNoLeak(output)
})

test('public_match: no match and several matches are separate failures', async () => {
  const none = await matchScenario({ 1: objectEntry(FAKE.recipientA), 2: objectEntry(FAKE.recipientB) })
  assert.equal(none.code, EXIT.MATCH_NONE)
  assert.match(none.output, /RESULT: MATCH_NONE \(0 of 2 entries equal the agreed test address; nothing was sent\)/)
  assertNoLeak(none.output)

  const several = await matchScenario({ 1: objectEntry(FAKE.testRecipient), 2: objectEntry(FAKE.testRecipient) })
  assert.equal(several.code, EXIT.MATCH_MULTIPLE)
  assert.match(several.output, /RESULT: MATCH_MULTIPLE \(2 of 2 entries/)
  assertNoLeak(several.output)
})

test('public_match: a server message that echoes the test address is hidden', async () => {
  const server = await startServer((req, res) => json(res, 200, { status: 'error', message: `no access for ${FAKE.testRecipient.replace(/[0-9_@.]/g, ' ')}` }))
  try {
    const lines = []
    const checked = validateRecipientConfig(matchEnv(server.baseUrl))
    const code = await runRecipientCheck(checked.config, { log: line => lines.push(line) })
    assert.equal(code, EXIT.APP)
    assertNoLeak(lines.join('\n'))
  } finally {
    await server.close()
  }
})

test('cli public_match: only the credential-free GET is sent; stdout, stderr and summary stay clean', async () => {
  const server = await startServer((req, res) => json(res, 200, emailsBody({ 1: objectEntry(FAKE.recipientA), 2: objectEntry(FAKE.testRecipient) })))
  try {
    const result = await runCli(matchEnv(server.baseUrl))
    assert.equal(result.code, EXIT.OK)
    assert.equal(server.calls.length, 1)
    for (const value of [FAKE.login, FAKE.password, FAKE.testRecipient]) assert.ok(!JSON.stringify(server.calls).includes(value))
    for (const text of [result.stdout, result.stderr, result.summary]) assertNoLeak(text, ['127.0.0.1'])
    assert.match(result.summary, /\| GET \/data\/ site_emails \| PASS \| 200 \| MATCH_SINGLE:2 \|/)
  } finally {
    await server.close()
  }
})

test('cli public_match: missing or malformed test address exits 10 before any request', async () => {
  const missing = await runCli({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'public_match' })
  assert.equal(missing.code, EXIT.CONFIG)
  assert.match(missing.stdout, /missing variables: E2E_TEST_RECIPIENT/)
  const malformed = await runCli({ VITE_BACKEND_URL: 'https://ibronevik.ru/taxi/c/gruzvill', RECIPIENT_CHECK_MODE: 'public_match', E2E_TEST_RECIPIENT: 'FAKE not an address' })
  assert.equal(malformed.code, EXIT.CONFIG)
  assert.match(malformed.stdout, /reason=invalid_test_recipient/)
  assert.ok(!malformed.stdout.includes('FAKE not an address'))
})
