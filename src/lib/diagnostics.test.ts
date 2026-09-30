import assert from 'node:assert/strict'
import test from 'node:test'
import {Diagnostics, redactDiagnostic} from './diagnostics.js'

test('diagnostics redact URLs, bearer tokens and terminal escapes', () => {
  const text = redactDiagnostic('\x1b[31mERROR https://example.com/private?token=secret Bearer sensitive\x1b[0m')
  assert.equal(text.includes('secret'), false)
  assert.equal(text.includes('sensitive'), false)
  assert.equal(text.includes('\x1b'), false)
  assert.match(text, /ERROR.*URL omitida/)
})

test('diagnostics bound memory and return snapshots without exposing internal state', () => {
  const printed: string[] = []
  const logs = new Diagnostics(line => printed.push(line))
  for (let i = 0; i < 120; i++) logs.add(`event ${i}`)
  assert.equal(logs.snapshot().length, 100)
  assert.match(logs.snapshot()[0]!, /event 20$/)
  assert.equal(printed.length, 120)
  logs.snapshot().pop()
  assert.equal(logs.snapshot().length, 100)
})
