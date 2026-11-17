/**
 * The whole flow with the app's own `Client` on both sides, over the real
 * relay and wallets: message, payment request, payment, and confirmation
 * shown to both. Then the same thread attacked by its participants, and the
 * relay asked what it will reveal.
 *
 * Establishes: the happy path works end to end without a browser; a receipt
 * without a valid preimage never reaches "paid" on the merchant's side while
 * LND still says the invoice is open; and the relay serves stored gift wraps
 * only to the authenticated recipient.
 * Does not establish: anything about the page itself (see e2e/).
 */
import { afterAll, describe, expect, test } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { Client } from '../../src/client.ts'
import { makeRumor, wrap } from '../../src/core/giftwrap.ts'
import { parseConn } from '../../src/core/nwc.ts'
import { receiptTags } from '../../src/core/pay.ts'
import { Relay } from '../../src/net/relay.ts'
import { demo, lnd, RELAY, relayQuery } from './stack.ts'

const d = demo()
const open = (role: 'merchant' | 'customer') =>
  new Client({
    sk: hexToBytes(d[role].sk),
    peer: d[role === 'merchant' ? 'customer' : 'merchant'].pk,
    relayUrl: RELAY,
    network: 'bcrt',
    conn: parseConn(d[role].nwc),
  })
const merchant = open('merchant')
const customer = open('customer')
afterAll(() => (merchant.close(), customer.close()))

async function until<T>(what: string, fn: () => T | undefined | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out waiting for ' + what)
}
const find = (c: Client, text: string) => c.thread().find((i) => i.text.includes(text))

describe('one conversation, end to end', () => {
  test('both wallets pass the capability check and get the right role', async () => {
    await until('merchant role', () => merchant.role.canRequest)
    await until('customer role', () => customer.role.canPay)
    expect(merchant.role).toEqual({ canRequest: true, canPay: false })
    expect(customer.role).toEqual({ canRequest: false, canPay: true })
  })

  test('the buyer is shown the budget the wallet reports for its connection', async () => {
    const budget = await until('customer budget', () => customer.budget ?? undefined)
    expect(budget).toMatchObject({ totalMsat: 10_000_000, daily: true })
    expect(budget.usedMsat).toBeLessThanOrEqual(budget.totalMsat)
  })

  test('message, request, pay, and both sides see a verified result', async () => {
    const tag = 'order-' + Date.now()
    customer.send(`two chapati and tea please (${tag})`)
    await until('merchant sees the order', () => find(merchant, tag))

    await merchant.requestPayment(250, tag)
    const request = await until('customer sees a payable request', () => {
      const i = find(customer, 'Payment request: 250 sats for ' + tag)
      return i?.pay?.state === 'payable' && i
    })
    expect(request.pay).toMatchObject({ role: 'payer', amountMsat: 250000n })
    expect((await lnd('merchant', '/v1/invoice/' + request.pay!.paymentHash)).state).toBe('OPEN')

    const usedBefore = customer.budget!.usedMsat
    const t0 = Date.now()
    await customer.pay(request.id)
    await until(
      'customer shows paid',
      () => find(customer, 'Payment request: 250 sats for ' + tag)?.pay?.state === 'paid',
    )
    await until(
      'merchant shows settled',
      () => find(merchant, 'Payment request: 250 sats for ' + tag)?.pay?.state === 'settled',
    )
    // The wallet counts the payment (and any fee) against the budget it reports.
    await until('budget reflects the payment', () => customer.budget!.usedMsat >= usedBefore + 250_000)
    console.log(
      `[measured] tap Pay -> merchant sees wallet-confirmed settlement: ${Date.now() - t0} ms (local relay, regtest, one hop)`,
    )

    expect((await lnd('merchant', '/v1/invoice/' + request.pay!.paymentHash)).state).toBe('SETTLED')
    // Paying again from the app does nothing: the request is no longer payable.
    await customer.pay(request.id)
    const sent = (await lnd('customer', '/v1/payments?include_incomplete=true')).payments.filter(
      (p: any) => p.payment_hash === request.pay!.paymentHash,
    )
    expect(sent).toHaveLength(1)
  })

  test('a customer who claims to have paid, without paying, changes nothing', async () => {
    const tag = 'unpaid-' + Date.now()
    await merchant.requestPayment(300, tag)
    const request = await until('request arrives', () => find(customer, tag))
    // A dishonest customer app: a well-formed receipt with an invented preimage,
    // sealed and signed with the customer's real key.
    const now = Math.floor(Date.now() / 1000)
    const sk = hexToBytes(d.customer.sk)
    const lie = makeRumor(
      sk,
      14,
      receiptTags(d.merchant.pk, request.id, 'ab'.repeat(32)),
      'Paid. Proof of payment attached.',
      now,
    )
    const relay = new Relay(RELAY)
    await relay.publish(wrap(lie, sk, d.merchant.pk, now))
    relay.close()

    const shown = await until('merchant sees the claim', () => merchant.thread().find((i) => i.id === lie.id))
    expect(shown.warn).toBe('Payment claim without valid proof')
    await merchant.confirmSettlements()
    expect(find(merchant, tag)?.pay?.state).toBe('awaiting')
    expect((await lnd('merchant', '/v1/invoice/' + request.pay!.paymentHash)).state).toBe('OPEN')
  })
})

describe('what the relay stores and to whom it serves it', () => {
  test('a stranger gets no gift wraps, authenticated or not', async () => {
    expect(await relayQuery({ kinds: [1059] })).toEqual([])
    expect(await relayQuery({ kinds: [1059], '#p': [d.merchant.pk] })).toEqual([])
    // Authenticated as someone else, asking for the merchant's mail.
    const outsider = generateSecretKey()
    const got: unknown[] = []
    const relay = new Relay(RELAY, {
      auth: (challenge, url) =>
        finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['relay', url],
              ['challenge', challenge],
            ],
            content: '',
          },
          outsider,
        ),
    })
    relay.sub({ kinds: [1059], '#p': [d.merchant.pk] }, (e) => got.push(e))
    relay.sub({ kinds: [1059], '#p': [getPublicKey(outsider)] }, (e) => got.push(e))
    await new Promise((r) => setTimeout(r, 1500))
    relay.close()
    expect(got).toEqual([])
  })

  test('the recipient, once authenticated, gets wraps that reveal a recipient key and nothing else', async () => {
    const sk = hexToBytes(d.merchant.sk)
    const wraps: any[] = []
    const relay = new Relay(RELAY, {
      auth: (challenge, url) =>
        finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['relay', url],
              ['challenge', challenge],
            ],
            content: '',
          },
          sk,
        ),
    })
    relay.sub({ kinds: [1059], '#p': [d.merchant.pk] }, (e) => wraps.push(e))
    await until('stored wraps', () => wraps.length >= 3)
    relay.close()
    const wire = JSON.stringify(wraps)
    expect(wire).not.toContain('chapati')
    expect(wire).not.toContain('lnbcrt')
    expect(wire).not.toContain(d.customer.pk) // the sender never appears
    for (const w of wraps) {
      expect(w.tags).toEqual([['p', d.merchant.pk]]) // the recipient always does
      expect(w.pubkey).not.toBe(d.merchant.pk)
      expect(w.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    }
    expect(new Set(wraps.map((w) => w.pubkey)).size).toBe(wraps.length) // one-time keys
  })
})
