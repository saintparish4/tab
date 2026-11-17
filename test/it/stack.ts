/**
 * Handles on the running regtest stack for the integration tests: the demo
 * file written by infra/init.mjs, Alby Hub's admin API (to mint and revoke
 * connections), LND's REST API (the independent record of what settled), and
 * a raw relay query.
 *
 * Tests use these to check claims against a system this repo did not write.
 * Nothing here is imported by the app.
 */
import { readFileSync } from 'node:fs'
import { Agent, fetch as ufetch } from 'undici'

const env = (k: string, d: string) => process.env[k] ?? d
export const RELAY = env('PUBLIC_RELAY_URL', 'ws://localhost:7777')
const PASSWORD = env('HUB_PASSWORD', 'regtest-only-password')
const HUBS = {
  merchant: env('HUB_MERCHANT_URL', 'http://localhost:8091'),
  customer: env('HUB_CUSTOMER_URL', 'http://localhost:8092'),
}
const LNDS = {
  merchant: {
    rest: env('LND_MERCHANT_REST', 'https://localhost:8081'),
    macaroon: env('LND_MERCHANT_MACAROON', './.stack/lnd-merchant.macaroon'),
  },
  customer: {
    rest: env('LND_CUSTOMER_REST', 'https://localhost:8082'),
    macaroon: env('LND_CUSTOMER_MACAROON', './.stack/lnd-customer.macaroon'),
  },
}
export type Role = 'merchant' | 'customer'
export type Demo = { relay: string } & Record<Role, { sk: string; pk: string; nwc: string }>

export function demo(): Demo {
  return JSON.parse(readFileSync(env('DEMO', './.stack/demo.json'), 'utf8'))
}

const insecure = new Agent({ connect: { rejectUnauthorized: false } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function lnd(role: Role, path: string): Promise<any> {
  const res = await ufetch(LNDS[role].rest + path, {
    dispatcher: insecure,
    headers: { 'Grpc-Metadata-macaroon': readFileSync(LNDS[role].macaroon).toString('hex') },
  })
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`)
  return res.json()
}

const tokens: Partial<Record<Role, string>> = {}
async function hub(role: Role, path: string, method = 'GET', body?: unknown): Promise<any> {
  if (!tokens[role]) {
    // The hub allows one password check per second across all callers.
    for (let i = 0; !tokens[role]; i++) {
      const res = await fetch(HUBS[role] + '/api/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unlockPassword: PASSWORD, permission: 'full' }),
      })
      if (res.ok) tokens[role] = (await res.json()).token
      else if (i > 10) throw new Error('hub unlock: ' + (await res.text()))
      else await sleep(1200)
    }
  }
  const res = await fetch(HUBS[role] + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokens[role] },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (res.status === 429) return sleep(1200).then(() => hub(role, path, method, body))
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Mint a fresh connection on a hub. Returns its URI and the key to revoke it by. */
export async function createConnection(
  role: Role,
  app: Record<string, unknown>,
): Promise<{ uri: string; appPubkey: string }> {
  const made = await hub(role, '/api/apps', 'POST', { ...app, unlockPassword: PASSWORD })
  const uri = new URL(made.pairingUri)
  uri.searchParams.delete('relay')
  uri.searchParams.append('relay', RELAY)
  uri.searchParams.delete('lud16')
  return { uri: uri.toString(), appPubkey: made.pairingPublicKey }
}

export async function revokeConnection(role: Role, appPubkey: string): Promise<void> {
  await hub(role, '/api/apps/' + appPubkey, 'DELETE')
}

/** Everything the relay will hand an unauthenticated stranger for `filter`. */
export function relayQuery(filter: Record<string, unknown>, waitMs = 1500): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY)
    const out: any[] = []
    const done = () => (ws.close(), resolve(out))
    const timer = setTimeout(done, waitMs)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'q', filter]))
    ws.onerror = () => reject(new Error('relay unreachable'))
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data))
      if (f[0] === 'EVENT') out.push(f[2])
      if (f[0] === 'EOSE' || f[0] === 'CLOSED') (clearTimeout(timer), done())
    }
  })
}
