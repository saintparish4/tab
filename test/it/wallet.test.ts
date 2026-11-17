/**
 * Claims that only a third party can confirm, checked against the running
 * regtest stack: Alby Hub decides what a connection may do, and LND's own
 * records say what settled. Run `docker compose up` first.
 *
 * Establishes, for Alby Hub 1.24.7 + LND on regtest: scope and budget are
 * enforced by the wallet service, a settled payment's preimage hashes to the
 * invoice's payment hash in both nodes' records, a replayed request is not
 * executed twice, and a deleted connection stops working at once.
 * Does not establish: the same for any other wallet, or on mainnet routes.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { decodeInvoice } from '../../src/core/bolt11.ts'
import { makeRequest, parseConn } from '../../src/core/nwc.ts'
import { verifyPreimage } from '../../src/core/pay.ts'
import { Wallet, WalletTimeout } from '../../src/net/wallet.ts'
import { createConnection, demo, lnd, RELAY, relayQuery, revokeConnection } from './stack.ts'

const d = demo()
const merchant = new Wallet(parseConn(d.merchant.nwc))
const customer = new Wallet(parseConn(d.customer.nwc))
const extra: Wallet[] = []
afterAll(() => [merchant, customer, ...extra].forEach((w) => w.close()))

const hexOf = (b64: string) => Buffer.from(b64, 'base64').toString('hex')
async function invoice(sats: number): Promise<{ bolt11: string; hash: string }> {
  const r = await merchant.call('make_invoice', { amount: sats * 1000, description: 'tab1test', expiry: 600 })
  if (!r.ok) throw new Error(r.error.message)
  return { bolt11: String(r.result.invoice), hash: String(r.result.payment_hash) }
}

describe('login proof against the real wallet service', () => {
  test('each connection is told only the methods it was granted', async () => {
    const m = await merchant.call('get_info')
    const c = await customer.call('get_info')
    expect(m.ok && c.ok).toBe(true)
    if (!m.ok || !c.ok) return
    expect(m.result.methods).toContain('make_invoice')
    expect(m.result.methods).not.toContain('pay_invoice')
    expect(c.result.methods).toContain('pay_invoice')
    expect(c.result.methods).not.toContain('make_invoice')
    // No get_info scope was granted, so the node's identity is withheld.
    expect(m.result.pubkey).toBeNull()
  })

  test('a forged response racing the real one is ignored', async () => {
    // The attacker watches the relay for the request, as anyone can, and
    // answers first with a response that grants everything.
    const conn = merchant.conn
    const attacker = generateSecretKey()
    const ws = new WebSocket(RELAY)
    await new Promise((r) => (ws.onopen = r))
    let forged = 0
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data))
      if (f[0] !== 'EVENT') return
      const body = { result_type: 'get_info', error: null, result: { methods: ['pay_invoice', 'make_invoice'] } }
      const content = nip44.encrypt(JSON.stringify(body), nip44.utils.getConversationKey(attacker, conn.clientPk))
      ws.send(
        JSON.stringify([
          'EVENT',
          finalizeEvent(
            {
              kind: 23195,
              created_at: f[2].created_at,
              tags: [
                ['p', conn.clientPk],
                ['e', f[2].id],
              ],
              content,
            },
            attacker,
          ),
        ]),
      )
      forged++
    }
    ws.send(
      JSON.stringify([
        'REQ',
        'spy',
        { kinds: [23194], authors: [conn.clientPk], since: Math.floor(Date.now() / 1000) },
      ]),
    )
    await new Promise((r) => setTimeout(r, 300))
    const reply = await merchant.call('get_info')
    ws.close()
    expect(forged).toBeGreaterThan(0)
    expect(reply.ok && reply.result.methods).not.toContain('pay_invoice')
  })
})

describe('authorization is enforced by the wallet service', () => {
  test('out of scope: the receive-only connection cannot pay, the pay connection cannot invoice', async () => {
    const { bolt11 } = await invoice(100)
    expect(await merchant.call('pay_invoice', { invoice: bolt11 })).toMatchObject({
      ok: false,
      error: { code: 'RESTRICTED' },
    })
    expect(await merchant.call('get_balance')).toMatchObject({ ok: false, error: { code: 'RESTRICTED' } })
    expect(await customer.call('make_invoice', { amount: 1000 })).toMatchObject({
      ok: false,
      error: { code: 'RESTRICTED' },
    })
  })

  test('over budget: refused, and the invoice stays unpaid in LND', async () => {
    const { uri } = await createConnection('customer', {
      name: 'tab-it-tiny',
      scopes: ['pay_invoice'],
      maxAmountSat: 100,
      budgetRenewal: 'never',
    })
    const tiny = new Wallet(parseConn(uri))
    extra.push(tiny)
    const { bolt11, hash } = await invoice(150)
    expect(await tiny.call('pay_invoice', { invoice: bolt11 }, 30000)).toMatchObject({
      ok: false,
      error: { code: 'QUOTA_EXCEEDED' },
    })
    expect((await lnd('merchant', '/v1/invoice/' + hash)).state).toBe('OPEN')
  })
})

describe('"paid" is checkable without trusting either app', () => {
  test('preimage hashes to the payment hash, and both LND nodes record the settlement', async () => {
    const { bolt11, hash } = await invoice(250)
    expect(decodeInvoice(bolt11).paymentHash).toBe(hash)
    const paid = await customer.call('pay_invoice', { invoice: bolt11 }, 30000)
    expect(paid.ok).toBe(true)
    if (!paid.ok) return
    const preimage = String(paid.result.preimage)
    expect(verifyPreimage(preimage, hash)).toBe(true)

    const inv = await lnd('merchant', '/v1/invoice/' + hash)
    expect(inv.state).toBe('SETTLED')
    expect(inv.amt_paid_msat).toBe('250000')
    expect(hexOf(inv.r_preimage)).toBe(preimage)

    const sent = (await lnd('customer', '/v1/payments?include_incomplete=true')).payments.filter(
      (p: any) => p.payment_hash === hash,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].status).toBe('SUCCEEDED')
    expect(sent[0].payment_preimage).toBe(preimage)

    // The merchant's own wallet connection reports the same thing.
    const seen = await merchant.call('lookup_invoice', { payment_hash: hash })
    expect(seen).toMatchObject({ ok: true, result: { type: 'incoming', state: 'settled', preimage } })

    // Paying the same invoice again is refused by the wallet.
    expect((await customer.call('pay_invoice', { invoice: bolt11 }, 30000)).ok).toBe(false)
    const again = (await lnd('customer', '/v1/payments?include_incomplete=true')).payments.filter(
      (p: any) => p.payment_hash === hash,
    )
    expect(again).toHaveLength(1)
  })

  test('an unpaid invoice: no preimage is disclosed and LND says OPEN', async () => {
    const { hash } = await invoice(700)
    const seen = await merchant.call('lookup_invoice', { payment_hash: hash })
    expect(seen).toMatchObject({ ok: true, result: { state: 'pending', preimage: '' } })
    expect((await lnd('merchant', '/v1/invoice/' + hash)).state).toBe('OPEN')
  })
})

describe('replay, leak and revocation', () => {
  test('a pay request replayed to the relay is executed once', async () => {
    const conn = customer.conn
    const { bolt11, hash } = await invoice(300)
    const request = makeRequest(conn, 'pay_invoice', { invoice: bolt11 }, Math.floor(Date.now() / 1000))
    const ws = new WebSocket(RELAY)
    await new Promise((r) => (ws.onopen = r))
    let responses = 0
    ws.onmessage = (m) => JSON.parse(String(m.data))[0] === 'EVENT' && responses++
    ws.send(JSON.stringify(['REQ', 'r', { kinds: [23195], '#e': [request.id] }]))
    ws.send(JSON.stringify(['EVENT', request]))
    await new Promise((r) => setTimeout(r, 3000))
    ws.send(JSON.stringify(['EVENT', request])) // the replay
    await new Promise((r) => setTimeout(r, 3000))
    ws.close()
    expect(responses).toBe(1)
    const sent = (await lnd('customer', '/v1/payments?include_incomplete=true')).payments.filter(
      (p: any) => p.payment_hash === hash,
    )
    expect(sent).toHaveLength(1)
  })

  test('a leaked connection string spends up to its budget, from anywhere, until it is deleted', async () => {
    const { uri, appPubkey } = await createConnection('customer', {
      name: 'tab-it-leak',
      scopes: ['pay_invoice'],
      maxAmountSat: 100,
      budgetRenewal: 'never',
    })
    // The "thief" has nothing but the string: no Nostr identity, no PIN, another socket.
    const thief = new Wallet(parseConn(uri))
    extra.push(thief)
    const first = await invoice(60)
    expect((await thief.call('pay_invoice', { invoice: first.bolt11 }, 30000)).ok).toBe(true)
    // The budget, not the app, is what limits the loss.
    const second = await invoice(60)
    expect(await thief.call('pay_invoice', { invoice: second.bolt11 }, 30000)).toMatchObject({
      ok: false,
      error: { code: 'QUOTA_EXCEEDED' },
    })

    await revokeConnection('customer', appPubkey)
    const t0 = Date.now()
    await expect(thief.call('get_info', {}, 4000)).rejects.toBeInstanceOf(WalletTimeout)
    // Reported, not asserted: how soon after deletion the first request went unanswered.
    console.log(
      `[measured] first request after revocation sent ${Date.now() - t0 - 4000} ms after DELETE returned; unanswered`,
    )
  })

  test('the wallet advertises each connection publicly: anyone can list them', async () => {
    const infos = await relayQuery({ kinds: [13194] })
    const mine = infos.find((e) => e.pubkey === customer.conn.walletPk)
    expect(mine.content).toContain('pay_invoice')
    expect(mine.tags).toContainEqual(['p', customer.conn.clientPk])
  })
})
