/**
 * Capture one real NIP-47 exchange from the running stack into
 * test/fixtures/captured.json, for the unit tests to replay offline.
 *
 * It mints a throwaway receive-only connection, records the wallet's info
 * event, one get_info request/response pair and one make_invoice pair exactly
 * as they crossed the relay (plus the decrypted results), then deletes the
 * connection. The secret stored
 * in the fixture is therefore dead: it decrypts these frames and nothing else.
 *
 *   node scripts/capture.ts
 */
import { writeFileSync } from 'node:fs'
import { bytesToHex } from '@noble/hashes/utils.js'
import { makeRequest, parseConn, readResponse } from '../src/core/nwc.ts'
import { createConnection, relayQuery, revokeConnection } from '../test/it/stack.ts'

const { uri, appPubkey } = await createConnection('merchant', {
  name: 'tab-capture',
  scopes: ['make_invoice', 'lookup_invoice'],
})
const conn = parseConn(uri)
const ws = new WebSocket(conn.relay)
await new Promise((r) => (ws.onopen = r))
const frames: string[] = []
ws.onmessage = (m) => frames.push(String(m.data))
const next = (pred: (f: any) => boolean) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no frame')), 10000)
    const prev = ws.onmessage!
    ws.onmessage = (m) => {
      prev.call(ws, m)
      const f = JSON.parse(String(m.data))
      if (pred(f)) (clearTimeout(t), (ws.onmessage = prev), resolve(f))
    }
  })

async function exchange(method: string, params: Record<string, unknown>) {
  const request = makeRequest(conn, method, params, Math.floor(Date.now() / 1000))
  ws.send(JSON.stringify(['REQ', method, { kinds: [23195], '#e': [request.id] }]))
  const got = next((f) => f[0] === 'EVENT' && f[1] === method)
  ws.send(JSON.stringify(['EVENT', request]))
  const response = (await got)[2]
  const reply = readResponse(conn, request.id, method, response)
  if (!reply.ok) throw new Error(method + ': ' + reply.error.message)
  // `plain` is the decrypted result, kept so tests can compare without the key.
  return { method, request, response, plain: { response: reply.result } }
}

const info = (await relayQuery({ kinds: [13194], authors: [conn.walletPk] }))[0]
const getInfo = await exchange('get_info', {})
const makeInvoice = await exchange('make_invoice', { amount: 2500000, description: 'tab1capture', expiry: 600 })
ws.close()
await revokeConnection('merchant', appPubkey)

writeFileSync(
  new URL('../test/fixtures/captured.json', import.meta.url),
  JSON.stringify(
    {
      note: 'Real frames from Alby Hub on regtest. The connection was deleted after capture; the secret is dead.',
      capturedAt: new Date().toISOString(),
      walletPk: conn.walletPk,
      relay: conn.relay,
      secret: bytesToHex(conn.secret),
      info,
      getInfo,
      makeInvoice,
      relayFrames: frames.slice(0, 6),
    },
    null,
    2,
  ),
)
console.log('captured', frames.length, 'relay frames for wallet', conn.walletPk)
