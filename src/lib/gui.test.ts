import assert from 'node:assert/strict'
import test from 'node:test'
import {once} from 'node:events'
import {GuiSession, type GuiServices} from './gui-session.js'
import {createGuiServer, authorized} from './gui-server.js'
import {buildChoices} from './ytdlp.js'

const services = (): GuiServices => ({
  buildChoices,
  ensureYtDlp: async () => 'fake-ytdlp',
  findFfmpeg: async () => undefined,
  probe: async () => ({info: {title: '<script>not HTML</script>', uploader: 'Prueba', formats: []}}),
  download: async () => '/downloads/test.mp4',
})
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('GUI validates URLs and keeps executable arguments on the server', async () => {
  const fake = services()
  let chosen: string[] = []
  fake.download = async (opts, handlers) => {
    chosen = opts.choice.args
    handlers.onProgress({downloadedBytes: 10, totalBytes: 10, part: 0, totalParts: 1})
    return '/downloads/test.mp4'
  }
  const session = new GuiSession('/downloads', fake)
  assert.throws(() => session.analyze('file:///etc/passwd'), /enlace válido/)
  assert.throws(() => session.start(0), /Primero/)
  session.analyze('https://example.com/video')
  assert.throws(() => session.analyze('https://example.com/second'), /Espera/)
  await tick()
  assert.equal(session.snapshot().phase, 'ready')
  assert.equal('args' in session.snapshot().choices![0]!, false)
  assert.throws(() => session.start(-1), /formato/)
  assert.throws(() => session.start('0'), /formato/)
  session.start(0)
  await tick()
  assert.equal(session.snapshot().phase, 'done')
  assert.deepEqual(chosen, ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'])
})

test('GUI ignores late results after cancellation', async () => {
  const fake = services()
  let finish!: (value: Awaited<ReturnType<GuiServices['probe']>>) => void
  fake.probe = () => new Promise(resolve => {finish = resolve})
  const session = new GuiSession('/downloads', fake)
  session.analyze('https://example.com/video')
  await tick()
  session.cancel()
  finish({info: {title: 'Late result'}})
  await tick()
  assert.equal(session.snapshot().phase, 'cancelled')
  assert.equal(session.snapshot().title, undefined)
})

test('GUI stops a pending download after cancellation and reports dependency failures', async () => {
  const fake = services()
  let cancelled = false
  fake.download = async (_opts, _handlers, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => {cancelled = true; reject(new Error('aborted'))}, {once: true})
  })
  const session = new GuiSession('/downloads', fake)
  session.analyze('https://example.com/video')
  await tick()
  session.start(0)
  await tick()
  session.cancel()
  await tick()
  assert.equal(cancelled, true)
  assert.equal(session.snapshot().phase, 'cancelled')
  fake.ensureYtDlp = async () => {throw new Error('Install yt-dlp')}
  session.analyze('https://example.com/another')
  await tick()
  assert.match(session.snapshot().error!, /No se encontró yt-dlp/)
})

test('local API requires a session token, exact host and same origin', () => {
  const host = '127.0.0.1:1234'
  const valid = {host, origin: `http://${host}`, authorization: 'Bearer secret'}
  assert.equal(authorized(valid, host, 'secret'), true)
  assert.equal(authorized({...valid, origin: 'https://evil.example'}, host, 'secret'), false)
  assert.equal(authorized({...valid, host: 'evil.example'}, host, 'secret'), false)
  assert.equal(authorized({...valid, authorization: undefined}, host, 'secret'), false)
  assert.equal(authorized({...valid, authorization: 'Bearer wrong!'}, host, 'secret'), false)
})

test('HTTP GUI serves its allowlisted assets and rejects unauthorized writes', async () => {
  const session = new GuiSession('/downloads', services())
  const {server, token} = createGuiServer('/downloads', new URL('../../web/', import.meta.url), session)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'}
  try {
    assert.equal((await fetch(`${base}/`)).status, 200)
    assert.equal((await fetch(`${base}/package.json`)).status, 404)
    assert.equal((await fetch(`${base}/api/state`)).status, 403)
    const cross = await fetch(`${base}/api/analyze`, {method: 'POST', headers: {...headers, origin: 'https://evil.example'}, body: JSON.stringify({url: 'https://example.com/video'})})
    assert.equal(cross.status, 403)
    const invalid = await fetch(`${base}/api/analyze`, {method: 'POST', headers, body: JSON.stringify({url: 'file:///etc/passwd'})})
    assert.equal(invalid.status, 400)
    const start = await fetch(`${base}/api/analyze`, {method: 'POST', headers, body: JSON.stringify({url: 'https://example.com/video'})})
    assert.equal(start.status, 202)
    await tick()
    const state = await fetch(`${base}/api/state`, {headers})
    assert.equal((await state.json()).phase, 'ready')
  } finally {
    session.cancel()
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
})
