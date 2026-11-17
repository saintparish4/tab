/**
 * Payment binding and the thread model under a hostile relay and a lying peer.
 *
 * Invoices here are FIXTURES built by `fakeInvoice`: correctly encoded, with
 * an all-zero signature. That is legitimate for these tests because the
 * decoder does not check signatures; it would not be a valid invoice to any
 * Lightning node. Real invoices are covered in test/it.
 *
 * Establishes: the derived thread is independent of delivery order and
 * duplication; dropping events never makes a payment look more complete;
 * and nothing the peer can write, short of a preimage that hashes to the
 * invoice's payment hash, produces a paid state.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { bech32 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { makeRumor, type Rumor } from '../../src/core/giftwrap.ts'
import { binding, checkRequest, receiptTags, requestTags, verifyPreimage } from '../../src/core/pay.ts'
import { buildThread, type Facts } from '../../src/core/thread.ts'

const NOW = 1_800_000_000
const merchant = generateSecretKey()
const customer = generateSecretKey()
const mallory = generateSecretKey()
const M = getPublicKey(merchant)
const C = getPublicKey(customer)
const X = getPublicKey(mallory)
const NONE: Facts = { preimages: new Map(), settled: new Set() }

function fakeInvoice(o: { paymentHash: string; description: string; amountMsat?: bigint; timestamp?: number; expiry?: number; network?: string }): string {
  const int = (n: number, words: number) => Array.from({ length: words }, (_, i) => Math.floor(n / 32 ** (words - 1 - i)) % 32)
  const field = (type: number, data: number[]) => [type, ...int(data.length, 2), ...data]
  const words = [
    ...int(o.timestamp ?? NOW, 7),
    ...field(1, bech32.toWords(hexToBytes(o.paymentHash))),
    ...field(16, new Array(52).fill(0)),
    ...field(13, bech32.toWords(utf8ToBytes(o.description))),
    ...field(6, int(o.expiry ?? 600, 4)),
    ...new Array(104).fill(0),
  ]
  return bech32.encode(`ln${o.network ?? 'bcrt'}${(o.amountMsat ?? 2_500_000n) * 10n}p`, words, false)
}

/** A request the way the merchant's app builds it, plus the preimage only the merchant's node knows. */
function order(n: number, at = NOW, opts: { from?: Uint8Array; to?: string; boundTo?: [string, string] } = {}) {
  const preimage = bytesToHex(sha256(utf8ToBytes('preimage ' + n)))
  const paymentHash = bytesToHex(sha256(hexToBytes(preimage)))
  const from = opts.from ?? merchant
  const to = opts.to ?? C
  const ref = 'ref' + n
  const [bm, bc] = opts.boundTo ?? [getPublicKey(from), to]
  const bolt11 = fakeInvoice({ paymentHash, description: binding(bm, bc, ref), timestamp: at })
  const request = makeRumor(from, 14, requestTags(to, bolt11, ref), `Please pay 2500 sat for order ${n}`, at)
  return { request, preimage, paymentHash, bolt11 }
}
const receipt = (o: { request: Rumor }, preimage: string, at = NOW + 5, from = customer, to = M) =>
  makeRumor(from, 14, receiptTags(to, o.request.id, preimage), 'Paid', at)
const chat = (sk: Uint8Array, to: string, text: string, at: number) => makeRumor(sk, 14, [['p', to]], text, at)
const stateOf = (rumors: Rumor[], me: string, peer: string, id: string, facts = NONE, now = NOW + 10) =>
  buildThread(rumors, me, peer, 'bcrt', facts, now).find((i) => i.id === id)?.pay?.state

describe('checkRequest: what makes an invoice payable in this conversation', () => {
  test('accepts an invoice bound to (merchant, customer, ref)', () => {
    const o = order(1)
    const checked = checkRequest(o.request, C, 'bcrt')
    expect(checked.ok && checked.invoice.paymentHash).toBe(o.paymentHash)
  })

  test('refuses an invoice lifted from another conversation', () => {
    // Mallory holds a real invoice the merchant issued to HER, and presents it
    // to the customer as her own request, hoping the customer pays her order.
    const lifted = order(2, NOW, { from: mallory, to: C, boundTo: [M, X] })
    expect(checkRequest(lifted.request, C, 'bcrt')).toEqual({ ok: false, reason: 'invoice was not issued for this conversation' })
  })

  test('refuses the wrong network, a missing amount, and garbage', () => {
    const hash = 'aa'.repeat(32)
    const mainnet = fakeInvoice({ paymentHash: hash, description: binding(M, C, 'r'), network: 'bc' })
    expect(checkRequest(makeRumor(merchant, 14, requestTags(C, mainnet, 'r'), '', NOW), C, 'bcrt').ok).toBe(false)
    const noAmount = bech32.encode('lnbcrt', bech32.decode(mainnet as `${string}1${string}`, false).words, false)
    expect(checkRequest(makeRumor(merchant, 14, requestTags(C, noAmount, 'r'), '', NOW), C, 'bcrt').ok).toBe(false)
    expect(checkRequest(makeRumor(merchant, 14, requestTags(C, 'lnbcrt1notaninvoice', 'r'), '', NOW), C, 'bcrt').ok).toBe(false)
    expect(checkRequest(chat(merchant, C, 'hello', NOW), C, 'bcrt').ok).toBe(false)
  })

  test('binding changes with either key or the ref', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ minLength: 1, maxLength: 20 }), (a, b) => {
        fc.pre(a !== b)
        expect(binding(M, C, a)).not.toBe(binding(M, C, b))
        expect(binding(M, C, a)).not.toBe(binding(C, M, a))
        expect(binding(M, C, a)).not.toBe(binding(M, X, a))
      }),
    )
  })
})

describe('verifyPreimage', () => {
  test('accepts only the preimage of the hash', () => {
    const o = order(3)
    expect(verifyPreimage(o.preimage, o.paymentHash)).toBe(true)
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/), (guess) => {
        fc.pre(guess !== o.preimage)
        expect(verifyPreimage(guess, o.paymentHash)).toBe(false)
      }),
    )
    for (const junk of [undefined, null, '', 'paid', o.preimage.toUpperCase(), o.paymentHash]) expect(verifyPreimage(junk, o.paymentHash)).toBe(false)
  })
})

describe('buildThread: payment state comes only from evidence', () => {
  const o = order(4)

  test('customer view: payable until a matching preimage exists', () => {
    expect(stateOf([o.request], C, M, o.request.id)).toBe('payable')
    expect(stateOf([o.request], C, M, o.request.id, { preimages: new Map([[o.paymentHash, o.preimage]]), settled: new Set() })).toBe('paid')
    // after a reload the wallet fact is gone, but the customer's own receipt carries the proof
    expect(stateOf([o.request, receipt(o, o.preimage)], C, M, o.request.id)).toBe('paid')
  })

  test('merchant view: a claim is not a payment; proof is; the wallet outranks both', () => {
    const lie = receipt(o, 'ff'.repeat(32))
    const talk = chat(customer, M, 'I paid, check your wallet!', NOW + 6)
    expect(stateOf([o.request, lie, talk], M, C, o.request.id)).toBe('awaiting')
    const items = buildThread([o.request, lie], M, C, 'bcrt', NONE, NOW + 10)
    expect(items.find((i) => i.id === lie.id)?.warn).toBe('Payment claim without valid proof')
    expect(stateOf([o.request, receipt(o, o.preimage)], M, C, o.request.id)).toBe('proof')
    expect(stateOf([o.request], M, C, o.request.id, { preimages: new Map(), settled: new Set([o.paymentHash]) })).toBe('settled')
  })

  test('a valid preimage for a DIFFERENT invoice proves nothing about this one', () => {
    const other = order(5)
    expect(stateOf([o.request, other.request, receipt(o, other.preimage)], M, C, o.request.id)).toBe('awaiting')
  })

  test("the merchant's own receipt, or a third party's, cannot mark the merchant's request paid", () => {
    const selfReceipt = makeRumor(merchant, 14, receiptTags(C, o.request.id, o.preimage), 'Paid', NOW + 5)
    expect(stateOf([o.request, selfReceipt], C, M, o.request.id)).toBe('payable')
    const outsider = receipt(o, o.preimage, NOW + 5, mallory, M)
    expect(buildThread([o.request, outsider], M, C, 'bcrt', NONE, NOW + 10)).toHaveLength(1)
  })

  test('expiry follows the invoice, and an unpayable request is shown with a reason', () => {
    expect(stateOf([o.request], C, M, o.request.id, NONE, NOW + 600)).toBe('expired')
    expect(stateOf([o.request], M, C, o.request.id, NONE, NOW + 600)).toBe('expired')
    const lifted = order(6, NOW, { from: merchant, to: C, boundTo: [M, X] })
    const [item] = buildThread([lifted.request], C, M, 'bcrt', NONE, NOW)
    expect(item.pay).toBeUndefined()
    expect(item.warn).toMatch(/not issued for this conversation/)
  })

  test('a receipt that arrives before its request is flagged, then resolves', () => {
    const r = receipt(o, o.preimage)
    expect(buildThread([r], M, C, 'bcrt', NONE, NOW + 10)[0].warn).toMatch(/has not received/)
    expect(stateOf([r, o.request], M, C, o.request.id)).toBe('proof')
  })
})

describe('buildThread: a relay that reorders, repeats or drops', () => {
  // A realistic thread: chatter, three orders, one honest receipt, one lie.
  const orders = [order(10, NOW), order(11, NOW + 20), order(12, NOW + 40)]
  const all: Rumor[] = [
    chat(customer, M, 'two chapati and tea please', NOW - 5),
    orders[0].request,
    receipt(orders[0], orders[0].preimage, NOW + 10),
    orders[1].request,
    receipt(orders[1], '00'.repeat(32), NOW + 30),
    chat(merchant, C, 'ready in five minutes', NOW + 35),
    orders[2].request,
  ]
  const view = (rumors: Rumor[], me = M, peer = C) => buildThread(rumors, me, peer, 'bcrt', NONE, NOW + 60)

  test('any order and any duplication give the identical thread', () => {
    const expected = view(all)
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: all.length }), fc.array(fc.constantFrom(...all), { maxLength: 10 }), (shuffled, dupes) => {
        expect(view([...dupes, ...shuffled])).toEqual(expected)
      }),
      { numRuns: 300 },
    )
  })

  test('dropping events never upgrades a payment state', () => {
    const rank = { expired: 0, awaiting: 0, payable: 0, proof: 1, paid: 1, settled: 2 }
    const full = new Map(view(all).map((i) => [i.id, i.pay?.state]))
    fc.assert(
      fc.property(fc.subarray(all), (subset) => {
        for (const item of view(subset)) {
          if (item.pay) expect(rank[item.pay.state]).toBeLessThanOrEqual(rank[full.get(item.id)!])
        }
      }),
      { numRuns: 300 },
    )
  })

  test('both sides derive the same order of messages from the same set', () => {
    expect(view(all, M, C).map((i) => i.id)).toEqual(view(all, C, M).map((i) => i.id))
  })

  test('rumors from outside the pair never enter the thread', () => {
    const noise = [chat(mallory, M, 'hi', NOW), chat(merchant, X, 'other customer', NOW), order(13, NOW, { to: X }).request]
    expect(view([...all, ...noise])).toEqual(view(all))
  })
})