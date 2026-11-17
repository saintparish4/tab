/**
 * One-shot regtest bootstrap, safe to run again. It speaks only HTTP (bitcoind
 * JSON-RPC, LND REST, Alby Hub's own API) so the same file runs inside Compose
 * and against processes started by hand.
 *
 * It ends by writing demo.json: two throwaway Nostr keys and two NWC
 * connection strings. Those are real secrets for REGTEST wallets and nothing
 * else; the file exists so the demo and the tests have something to log in
 * with. Next to it go copies of both LND admin macaroons, so tests on the
 * host can read each node's own records. Never point this script at a node
 * that holds real funds.
 *
 * The two wallet connections are deliberately unequal, because that
 * inequality is the authorization model under test:
 *   merchant: make_invoice + lookup_invoice, no spending scope at all
 *   customer: pay_invoice + lookup_invoice, 10 000 sat per day
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Agent, fetch as ufetch } from 'undici'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'

const env = (k, d) => process.env[k] ?? d
const BTC = env('BITCOIND_URL', 'http://127.0.0.1:18443')
const BTC_AUTH = 'Basic ' + Buffer.from(env('BITCOIND_AUTH', 'tab:tab')).toString('base64')
const PUBLIC_RELAY = env('PUBLIC_RELAY_URL', 'ws://localhost:7777')
const PASSWORD = env('HUB_PASSWORD', 'regtest-only-password')
const OUT = env('OUT', './demo.json')
const NODES = {
  merchant: {
    rest: env('LND_MERCHANT_REST', 'https://127.0.0.1:8081'),
    macaroon: env('LND_MERCHANT_MACAROON', './lnd-merchant/admin.macaroon'),
    p2p: env('LND_MERCHANT_P2P', '127.0.0.1:9731'),
    hub: env('HUB_MERCHANT_URL', 'http://127.0.0.1:8091'),
    app: { name: 'tab-merchant', scopes: ['make_invoice', 'lookup_invoice'] },
  },
  customer: {
    rest: env('LND_CUSTOMER_REST', 'https://127.0.0.1:8082'),
    macaroon: env('LND_CUSTOMER_MACAROON', './lnd-customer/admin.macaroon'),
    hub: env('HUB_CUSTOMER_URL', 'http://127.0.0.1:8092'),
    app: {
      name: 'tab-customer',
      scopes: ['pay_invoice', 'lookup_invoice'],
      maxAmountSat: 10000,
      budgetRenewal: 'daily',
    },
  },
}

// LND's REST port serves a self-signed certificate. Skipping verification is
// acceptable only because both ends are containers on one private network.
const insecure = new Agent({ connect: { rejectUnauthorized: false } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[init]', ...a)

async function until(what, fn, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    await sleep(1000)
  }
  throw new Error('timed out waiting for ' + what)
}

async function btc(method, params = [], wallet = '') {
  const res = await fetch(BTC + (wallet ? '/wallet/' + wallet : ''), {
    method: 'POST',
    headers: { authorization: BTC_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'init', method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(method + ': ' + body.error.message)
  return body.result
}

async function lnd(node, path, body) {
  const res = await ufetch(node.rest + path, {
    method: body ? 'POST' : 'GET',
    dispatcher: insecure,
    headers: { 'Grpc-Metadata-macaroon': readFileSync(node.macaroon).toString('hex') },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(path + ': ' + text)
  return JSON.parse(text)
}

async function hub(node, path, method = 'GET', body, token) {
  const res = await fetch(node.hub + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function chain() {
  await until('bitcoind', () => btc('getblockchaininfo'))
  const wallets = await btc('listwallets')
  if (!wallets.includes('miner')) {
    try {
      await btc('loadwallet', ['miner'])
    } catch {
      await btc('createwallet', ['miner'])
    }
  }
  const addr = await btc('getnewaddress', [], 'miner')
  const mine = (n) => btc('generatetoaddress', [n, addr])
  if ((await btc('getblockcount')) < 101) await mine(101)
  return mine
}

async function channel(mine) {
  const { merchant, customer } = NODES
  const synced = (n) => until('lnd sync', async () => (await lnd(n, '/v1/getinfo')).synced_to_chain && true)
  const mInfo = await until('lnd-merchant', () => lnd(merchant, '/v1/getinfo'))
  await until('lnd-customer', () => lnd(customer, '/v1/getinfo'))
  await mine(1)
  await synced(merchant)
  await synced(customer)

  const existing = await lnd(customer, '/v1/channels')
  if ((existing.channels ?? []).length > 0) return log('channel already open')

  const { address } = await lnd(customer, '/v1/newaddress?type=TAPROOT_PUBKEY')
  await btc('sendtoaddress', [address, 1], 'miner')
  await mine(6)
  await until(
    'customer funds',
    async () => Number((await lnd(customer, '/v1/balance/blockchain')).confirmed_balance) > 0,
  )
  await lnd(customer, '/v1/peers', { addr: { pubkey: mInfo.identity_pubkey, host: merchant.p2p } }).catch((e) => {
    if (!String(e).includes('already connected')) throw e
  })
  await lnd(customer, '/v1/channels', { node_pubkey_string: mInfo.identity_pubkey, local_funding_amount: '1000000' })
  await mine(6)
  await until('active channel', async () =>
    ((await lnd(customer, '/v1/channels')).channels ?? []).some((c) => c.active),
  )
  log('channel open: customer -> merchant, 1 000 000 sat')
}

async function wallet(node) {
  const info = await until('hub', () => hub(node, '/api/info'))
  if (!info.setupCompleted) await hub(node, '/api/setup', 'POST', { unlockPassword: PASSWORD, backendType: 'LND' })
  if (!(await hub(node, '/api/info')).running) await hub(node, '/api/start', 'POST', { unlockPassword: PASSWORD })
  await until('hub running', async () => (await hub(node, '/api/info')).running)
  await sleep(1100) // the hub rate-limits password endpoints to one per second
  const { token } = await hub(node, '/api/unlock', 'POST', { unlockPassword: PASSWORD, permission: 'full' })

  // A connection secret is shown once, so an old connection cannot be reused:
  // delete it and mint a new one.
  const list = await hub(node, '/api/apps', 'GET', null, token)
  for (const a of list.apps ?? []) {
    if (a.name === node.app.name) await hub(node, '/api/apps/' + a.appPubkey, 'DELETE', null, token)
  }
  const made = await hub(node, '/api/apps', 'POST', { ...node.app, unlockPassword: PASSWORD }, token)
  // The hub reaches the relay by its Compose service name; a browser on the
  // host reaches the same relay as localhost. Rewrite only that parameter.
  const uri = new URL(made.pairingUri)
  uri.searchParams.delete('relay')
  uri.searchParams.append('relay', PUBLIC_RELAY)
  uri.searchParams.delete('lud16')
  log(node.app.name, 'scopes:', node.app.scopes.join(','), 'wallet pubkey:', made.walletPubkey)
  return uri.toString()
}

const mine = await chain()
await channel(mine)
const demo = { relay: PUBLIC_RELAY }
for (const role of ['merchant', 'customer']) {
  const sk = generateSecretKey()
  demo[role] = { sk: bytesToHex(sk), pk: getPublicKey(sk), nwc: await wallet(NODES[role]) }
}
mkdirSync(dirname(OUT), { recursive: true })
// Delete before writing: a file left by the other route (Docker runs this as
// root, native.sh as you) cannot be overwritten, but it can be removed by
// whoever owns the directory.
rmSync(OUT, { force: true })
writeFileSync(OUT, JSON.stringify(demo, null, 2))
for (const role of ['merchant', 'customer']) {
  const copy = join(dirname(OUT), `lnd-${role}.macaroon`)
  rmSync(copy, { force: true })
  copyFileSync(NODES[role].macaroon, copy)
  chmodSync(copy, 0o644) // inside Compose this runs as root; the host user must be able to read it
}
log('wrote', OUT)
