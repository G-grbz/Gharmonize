import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeServerHostChoice, resolveServerHost, describeServerHost, isLoopbackHost, SERVER_HOST_ALL, SERVER_HOST_LOOPBACK } from '../modules/serverHost.js'
import { initializeRuntimeEnvironment } from '../modules/runtimeEnvironment.js'

test('settings can only pick the fixed listen addresses', () => {
  assert.equal(normalizeServerHostChoice('0.0.0.0'), SERVER_HOST_ALL)
  assert.equal(normalizeServerHostChoice('lan'), SERVER_HOST_ALL)
  assert.equal(normalizeServerHostChoice('127.0.0.1'), SERVER_HOST_LOOPBACK)
  // Anything else (including other addresses or junk) never reaches listen().
  for (const value of ['192.168.1.5', '::', 'evil.example', '0.0.0.0; rm -rf /', '', null, undefined, {}]) {
    assert.equal(normalizeServerHostChoice(value), SERVER_HOST_LOOPBACK)
  }
})

test('the listen address comes from the environment with a loopback default', () => {
  assert.equal(resolveServerHost({}), '127.0.0.1')
  assert.equal(resolveServerHost({ GHARMONIZE_HOST: ' 0.0.0.0 ' }), '0.0.0.0')
  assert.deepEqual(describeServerHost({ GHARMONIZE_HOST: '0.0.0.0' }), { choice: '0.0.0.0', current: '0.0.0.0', locked: false })
  assert.deepEqual(describeServerHost({ GHARMONIZE_HOST: '192.168.1.5' }, { locked: true }), { choice: 'custom', current: '192.168.1.5', locked: true })
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
})

test('a deployment-provided GHARMONIZE_HOST is reported so Settings can lock it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-host-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.env'), 'GHARMONIZE_HOST=127.0.0.1\n')
  const docker = { GHARMONIZE_HOST: '0.0.0.0', DATA_DIR: path.join(root, 'data') }
  assert.equal(initializeRuntimeEnvironment({ env: docker, cwd: root }).hostFromDeployment, true)
  assert.equal(docker.GHARMONIZE_HOST, '0.0.0.0')
  const desktop = { DATA_DIR: path.join(root, 'data2') }
  assert.equal(initializeRuntimeEnvironment({ env: desktop, cwd: root }).hostFromDeployment, false)
  assert.equal(desktop.GHARMONIZE_HOST, '127.0.0.1')
})
