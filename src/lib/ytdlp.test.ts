import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {probe, download} from './ytdlp.js'

test('rejects non-web URLs before starting a subprocess', async () => {
  await assert.rejects(probe('/does-not-exist', 'file:///etc/passwd'), /HTTP/)
  await assert.rejects(download({ytdlp: '/does-not-exist', url: '--exec=bad', choice: {kind: 'video', label: '', args: []}, outDir: os.tmpdir()}, {onProgress() {}, onProcessing() {}}), /HTTP/)
})

test('probe isolates configuration and preserves URL as one positional argument', {skip: process.platform === 'win32'}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-test-'))
  try {
    const executable = path.join(dir, 'fake-ytdlp')
    await fs.writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({title: JSON.stringify(process.argv.slice(2))}))\n`, {mode: 0o700})
    const url = 'https://example.com/video?a=1&b=2'
    const result = await probe(executable, url)
    const args = JSON.parse(result.info.title)
    assert.ok(args.includes('--ignore-config'))
    assert.ok(args.includes('--no-plugin-dirs'))
    assert.deepEqual(args.slice(-2), ['--', url])
    assert.deepEqual(Object.keys(result), ['info'])
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('cancel never deletes a path reported by subprocess output', {skip: process.platform === 'win32'}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-test-'))
  const controller = new AbortController()
  try {
    const victim = path.join(dir, 'keep.txt')
    await fs.writeFile(victim, 'keep me')
    const executable = path.join(dir, 'fake-ytdlp')
    await fs.writeFile(executable, `#!${process.execPath}\nconsole.log('[download] Destination: ' + ${JSON.stringify(victim)})\nconsole.log('YOINK|1|2|2|1|1')\nsetInterval(() => {}, 1000)\n`, {mode: 0o700})
    await assert.rejects(download({ytdlp: executable, url: 'https://example.com/video', choice: {kind: 'video', label: '', args: []}, outDir: dir}, {onProgress() {controller.abort()}, onProcessing() {}}, controller.signal))
    assert.equal(await fs.readFile(victim, 'utf8'), 'keep me')
  } finally {
    controller.abort()
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('probe exposes subprocess stderr and exit code for diagnostics', {skip: process.platform === 'win32'}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-test-'))
  const messages: string[] = []
  try {
    const executable = path.join(dir, 'fake-ytdlp')
    await fs.writeFile(executable, `#!${process.execPath}\nconsole.error('ERROR: simulated failure'); process.exit(3)\n`, {mode: 0o700})
    await assert.rejects(probe(executable, 'https://example.com/video', undefined, message => messages.push(message)), /simulated failure/)
    assert.ok(messages.some(message => message.includes('ERROR: simulated failure')))
    assert.ok(messages.some(message => message.includes('código 3')))
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})
