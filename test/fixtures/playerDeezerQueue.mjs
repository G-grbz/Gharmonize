import assert from 'node:assert/strict'
import { deezerGet } from '../../modules/player/online.js'

let calls = 0
const fetchImpl = async () => ({ ok: true, json: async () => ({ id: ++calls }) })
await deezerGet('/track/1', { fetchImpl })
await deezerGet('/track/2', { fetchImpl })
assert.equal(calls, 2)
console.log('DEEZER_QUEUE_COMPLETE')
