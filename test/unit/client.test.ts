/**
 * The payer's "unknown" outcome, driven through the real Client with the
 * relay and the wallet replaced by scripted fakes.
 *
 * Why fakes: on regtest one direct channel always pays, so no real run ever
 * reaches a pay_invoice that times out. The fake wallet below answers each
 * method the way the test says, or not at all.
 *
 * Establishes: a pay_invoice with no answer is recorded as unknown, never as
 * failed or paid, and is not sent a second time; only the wallet's own
 * lookup_invoice resolves it, to paid on a preimage that hashes to the
 * invoice, or back to payable when the wallet says the payment failed.
 * Does not establish: that any real wallet reports a late or failed payment
 * this way. Alby Hub's lookup_invoice shape is covered in test/it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Event } from '../../src/core/event.ts'
import { makeRumor, unwrap, wrap } from '../../src/core/giftwrap.ts'
import type { Conn, NwcReply } from '../../src/core/nwc.ts'
import { binding, requestTags } from '../../src/core/pay.ts'
import { tagValue } from '../../src/core/event.ts'
import { fakeInvoice } from './fake-invoice.ts'

type Handler = (params: Record<string, unknown>) => NwcReply | 'timeout'

const fake = vi.hoisted(() => {
  class WalletTimeout extends Error {}
  return {
    WalletTimeout,
    /** what the wallet answers, per method; a missing method times out */
    handlers: {} as Record<string, Handler>,
    /** every wallet call made, in order */
    calls: [] as { method: string; params: Record<string, unknown> }[],
    /** hands a relay event to the client, as the relay would */
    deliver: (_: Event) => {},
    published: [] as Event[],
    /** false: the relay never acknowledges a publish, as on a link that just died */
    acks: true,
  }
})

vi.mock('../../src/net/relay.ts', () => ({
  Relay: class {
    constructor(_url: string, opts: { onStatus?: (s: string) => void }) {
      queueMicrotask(() => opts.onStatus?.('open'))
    }
    sub(_filter: unknown, onEvent: (e: Event) => void) {
      fake.deliver = onEvent
      return () => {}
    }
    publish(ev: Event) {
      if (!fake.acks) return new Promise<void>(() => {})
      fake.published.push(ev)
      return Promise.resolve()
    }
    close() {}
  },
}))

vi.mock('../../src/net/wallet.ts', () => ({
  WalletTimeout: fake.WalletTimeout,
  Wallet: class {
    info() {
      return Promise.resolve({ methods: [] })
    }
    call(method: string, params: Record<string, unknown> = {}) {
      fake.calls.push({ method, params })
      const answer = fake.handlers[method]?.(params) ?? 'timeout'
      return answer === 'timeout' ? Promise.reject(new fake.WalletTimeout(method)) : Promise.resolve(answer)
    }
    close() {}
  },
}))

const { Client } = await import('../../src/client.ts')

const merchant = generateSecretKey()
const customer = generateSecretKey()
const M = getPublicKey(merchant)
const C = getPublicKey(customer)
const conn = { walletPk: M, relay: 'ws://unused', secret: customer, clientPk: C } satisfies Conn
const ok = (result: Record<string, unknown>): NwcReply => ({ ok: true, result })
const count = (method: string) => fake.calls.filter((c) => c.method === method).length

/**
 * vi.waitFor gives up after 1 s by default. Nothing here waits on a clock, but
 * the client's start-up does real signing and encryption, and on a busy
 * machine (a browser running, other test files in parallel) that has taken
 * longer than a second. A longer limit costs nothing when the test passes.
 */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000 })

let client: InstanceType<typeof Client>

/** A customer whose wallet lists `methods`, holding one payable request from the merchant. */
async function customerWithRequest(methods = ['pay_invoice', 'lookup_invoice'], more: Record<string, Handler> = {}) {
  fake.handlers = { get_info: () => ok({ methods }), ...more }
  fake.calls.length = 0
  fake.published.length = 0
  fake.acks = true
  client = new Client({ sk: customer, peer: M, relayUrl: 'ws://unused', network: 'bcrt', conn })
  await waitFor(() => expect(client.role.canPay).toBe(true))

  const now = Math.floor(Date.now() / 1000)
  const preimage = bytesToHex(sha256(utf8ToBytes('preimage ' + Math.random())))
  const paymentHash = bytesToHex(sha256(hexToBytes(preimage)))
  const bolt11 = fakeInvoice({ paymentHash, description: binding(M, C, 'ref1'), timestamp: now })
  const request = makeRumor(merchant, 14, requestTags(C, bolt11, 'ref1'), 'Please pay 2500 sats', now)
  const requestWrap = wrap(request, merchant, C, now)
  fake.deliver(requestWrap)
  expect(stateOf(request.id)).toBe('payable')
  return { id: request.id, preimage, paymentHash, requestWrap }
}
/** Lock, then unlock: a new Client that gets back only what the relay stored. */
async function lockAndUnlock(stored: Event[]) {
  client.close()
  fake.acks = true
  client = new Client({ sk: customer, peer: M, relayUrl: 'ws://unused', network: 'bcrt', conn })
  await waitFor(() => expect(client.role.canPay).toBe(true))
  for (const ev of stored) fake.deliver(ev)
}
const stateOf = (id: string) => client.thread().find((i) => i.id === id)?.pay?.state
/** receipts this client sent to the merchant, read the way the merchant would */
const receiptsSent = () =>
  fake.published
    .filter((ev) => ev.kind === 1059 && tagValue(ev, 'p') === M)
    .map((ev) => unwrap(ev, merchant))
    .filter((r) => tagValue(r, 'tab') === 'receipt')

afterEach(() => client?.close())

describe('a pay_invoice the wallet never answers', () => {
  test('is unknown: not failed, not paid, and no receipt is sent', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)

    expect(client.unknown.has(o.paymentHash)).toBe(true)
    expect(client.paying.has(o.paymentHash)).toBe(false)
    expect(client.notice).toMatch(/may or may not/)
    expect(client.notice).not.toMatch(/fail/i)
    expect(stateOf(o.id)).toBe('payable')
    expect(receiptsSent()).toEqual([])
  })

  test('is never sent to the wallet a second time', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    await client.pay(o.id)
    await client.pay(o.id)
    expect(count('pay_invoice')).toBe(1)
  })

  test('becomes paid when the wallet later reports the preimage', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: o.preimage })
    await client.confirmSettlements()

    expect(client.unknown.has(o.paymentHash)).toBe(false)
    expect(stateOf(o.id)).toBe('paid')
    const receipts = receiptsSent()
    expect(receipts).toHaveLength(1)
    expect(tagValue(receipts[0], 'preimage')).toBe(o.preimage)
    expect(tagValue(receipts[0], 'e')).toBe(o.id)
  })

  test('stays unknown when the wallet says settled without a matching preimage', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: '00'.repeat(32) })
    await client.confirmSettlements()

    expect(client.unknown.has(o.paymentHash)).toBe(true)
    expect(stateOf(o.id)).toBe('payable')
    expect(receiptsSent()).toEqual([])
  })

  test('stays unknown while the wallet is unreachable or still pending', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    await client.confirmSettlements() // lookup_invoice times out too
    expect(client.unknown.has(o.paymentHash)).toBe(true)

    fake.handlers.lookup_invoice = (p) => ok({ payment_hash: p.payment_hash, state: 'pending', type: 'outgoing' })
    await client.confirmSettlements()
    expect(client.unknown.has(o.paymentHash)).toBe(true)
    expect(stateOf(o.id)).toBe('payable')
  })

  test('ignores a lookup answer about a different invoice', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    fake.handlers.lookup_invoice = () =>
      ok({ payment_hash: 'ab'.repeat(32), state: 'settled', type: 'outgoing', preimage: o.preimage })
    await client.confirmSettlements()
    expect(client.unknown.has(o.paymentHash)).toBe(true)
  })

  test('is payable again only when the wallet says the payment failed', async () => {
    const o = await customerWithRequest()
    await client.pay(o.id)
    fake.handlers.lookup_invoice = (p) => ok({ payment_hash: p.payment_hash, state: 'failed', type: 'outgoing' })
    await client.confirmSettlements()

    expect(client.unknown.has(o.paymentHash)).toBe(false)
    expect(client.notice).toMatch(/did not go through/)
    expect(stateOf(o.id)).toBe('payable')

    // The user may now try again, and this time the wallet answers.
    fake.handlers.pay_invoice = () => ok({ preimage: o.preimage })
    await client.pay(o.id)
    expect(count('pay_invoice')).toBe(2)
    expect(stateOf(o.id)).toBe('paid')
  })
})

describe('a payment whose receipt never reached the relay', () => {
  // Paid state is held in memory and rebuilt after unlock from the buyer's own
  // receipt, which comes back from the relay. If the buyer locks (or the page
  // reloads) before the relay has acknowledged that receipt, it is gone.
  const paidThenLockedTooSoon = async () => {
    const o = await customerWithRequest()
    fake.handlers.pay_invoice = () => ok({ preimage: o.preimage })
    fake.acks = false
    await client.pay(o.id)
    expect(stateOf(o.id)).toBe('paid')
    await lockAndUnlock([o.requestWrap])
    return o
  }

  test('is found again by asking the wallet, and the receipt is sent', async () => {
    const o = await paidThenLockedTooSoon()
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: o.preimage })
    await client.confirmSettlements()

    expect(stateOf(o.id)).toBe('paid')
    expect(count('pay_invoice')).toBe(1)
    const receipts = receiptsSent()
    expect(receipts).toHaveLength(1)
    expect(tagValue(receipts[0], 'preimage')).toBe(o.preimage)
  })

  test('two checks running at once ask the wallet once and send one receipt', async () => {
    const o = await paidThenLockedTooSoon()
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: o.preimage })
    fake.calls.length = 0
    await Promise.all([client.confirmSettlements(), client.confirmSettlements(), client.confirmSettlements()])
    expect(count('lookup_invoice')).toBe(1)
    expect(receiptsSent()).toHaveLength(1)
  })

  test('still needs a preimage that hashes to the invoice', async () => {
    const o = await paidThenLockedTooSoon()
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: '00'.repeat(32) })
    await client.confirmSettlements()
    expect(stateOf(o.id)).toBe('payable')
    expect(receiptsSent()).toEqual([])
  })

  test('a payment still in flight after unlock is unknown, and is not sent again', async () => {
    const o = await paidThenLockedTooSoon()
    fake.handlers.lookup_invoice = (p) => ok({ payment_hash: p.payment_hash, state: 'pending', type: 'outgoing' })
    await client.confirmSettlements()
    expect(client.unknown.has(o.paymentHash)).toBe(true)
    await client.pay(o.id)
    expect(count('pay_invoice')).toBe(1)
  })

  test('a request the wallet never paid is asked about once, and stays payable without a notice', async () => {
    const o = await customerWithRequest()
    fake.handlers.lookup_invoice = () => ({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
    fake.calls.length = 0 // the request's arrival already tried once, with no answer
    await client.confirmSettlements()
    await client.confirmSettlements()
    await client.confirmSettlements()
    expect(count('lookup_invoice')).toBe(1)
    expect(stateOf(o.id)).toBe('payable')
    expect(client.notice).toBe('')
  })

  test('is asked about again while the wallet does not answer', async () => {
    const o = await paidThenLockedTooSoon()
    await client.confirmSettlements() // lookup_invoice times out
    expect(stateOf(o.id)).toBe('payable')
    fake.handlers.lookup_invoice = (p) =>
      ok({ payment_hash: p.payment_hash, state: 'settled', type: 'outgoing', preimage: o.preimage })
    await client.confirmSettlements()
    expect(stateOf(o.id)).toBe('paid')
  })
})

describe('the budget line', () => {
  const methods = ['pay_invoice', 'lookup_invoice', 'get_budget']
  const budget = (used: number) => () => ok({ used_budget: used, total_budget: 10_000_000, renewal_period: 'daily' })

  test('shows what the wallet reported, and refreshes after a payment', async () => {
    const o = await customerWithRequest(methods, { get_budget: budget(505_000) })
    await waitFor(() => expect(client.budget).not.toBeNull())
    expect(client.budget).toEqual({ usedMsat: 505_000, totalMsat: 10_000_000, leftMsat: 9_495_000, daily: true })

    fake.handlers.get_budget = budget(3_005_000)
    fake.handlers.pay_invoice = () => ok({ preimage: o.preimage })
    await client.pay(o.id)
    await waitFor(() => expect(client.budget?.usedMsat).toBe(3_005_000))
  })

  test('never blocks a payment: a spent budget still sends pay_invoice to the wallet', async () => {
    const o = await customerWithRequest(methods)
    fake.handlers.get_budget = budget(10_000_000)
    await client.refreshBudget()
    fake.handlers.pay_invoice = () => ({ ok: false, error: { code: 'QUOTA_EXCEEDED', message: '' } })
    await client.pay(o.id)

    expect(count('pay_invoice')).toBe(1)
    expect(client.notice).toBe("Over this connection's spending limit.")
    expect(stateOf(o.id)).toBe('payable')
  })

  test('is dropped, not kept stale, when the wallet stops answering or lacks the method', async () => {
    await customerWithRequest(methods, { get_budget: budget(0) })
    await waitFor(() => expect(client.budget).not.toBeNull())
    delete fake.handlers.get_budget
    await client.refreshBudget()
    expect(client.budget).toBeNull()

    client.close()
    await customerWithRequest() // no get_budget in the wallet's list
    await client.refreshBudget()
    expect(count('get_budget')).toBe(0)
    expect(client.budget).toBeNull()
  })
})
