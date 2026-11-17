/**
 * The invoice decoder against BOLT 11's own examples, read straight from the
 * pinned copy of the spec (scripts/fetch-fixtures.sh), plus one invoice a real
 * LND node issued through Alby Hub (test/fixtures/captured.json, if present).
 *
 * Establishes: the five fields we act on match the spec's stated values, and
 * the spec's invalid examples are refused, except the one that is invalid only
 * because of its signature. That one we accept, on purpose and on the record:
 * this decoder does not verify signatures (see src/core/bolt11.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { decodeInvoice } from '../../src/core/bolt11.ts'

const spec = readFileSync(new URL('../fixtures/bolt11.md', import.meta.url), 'utf8')
/** The invoice printed under the example whose heading starts with `title`. */
function example(title: string): string {
  const at = spec.indexOf('> ### ' + title)
  if (at < 0) throw new Error('no such example: ' + title)
  const line = spec.slice(at).split('\n')[1]
  return line.replace(/^> /, '').trim()
}

const HASH = '0001020304050607080900010203040506070809000102030405060708090102'

describe('BOLT 11 spec examples', () => {
  test('donation of any amount', () => {
    const inv = decodeInvoice(example('Please make a donation of any amount'))
    expect(inv).toEqual({ network: 'bc', amountMsat: null, timestamp: 1496314658, expiry: 3600, paymentHash: HASH, description: 'Please consider supporting this project' })
  })

  test('2500u with a one-minute expiry', () => {
    const inv = decodeInvoice(example('Please send $3 for a cup of coffee'))
    expect(inv.amountMsat).toBe(250_000_000n)
    expect(inv.expiry).toBe(60)
    expect(inv.description).toBe('1 cup coffee')
  })

  test('UTF-8 description', () => {
    expect(decodeInvoice(example('Please send 0.0025 BTC for a cup of nonsense')).description).toBe('ナンセンス 1杯')
  })

  test('hashed description has no readable description', () => {
    const inv = decodeInvoice(example('Now send $24 for an entire list of things (hashed)'))
    expect(inv.amountMsat).toBe(2_000_000_000n)
    expect(inv.description).toBeNull()
  })

  test('testnet prefix', () => {
    expect(decodeInvoice(example('The same, on testnet')).network).toBe('tb')
  })

  test('pico-BTC amount and one-week expiry', () => {
    const inv = decodeInvoice(example('Please send 0.00967878534 BTC'))
    expect(inv.amountMsat).toBe(967_878_534n)
    expect(inv.expiry).toBe(604800)
    expect(inv.paymentHash).toBe('462264ede7e14047e9b249da94fefc47f41f7d02ee9b091815a5506bc8abf75f')
  })

  test('upper case, and unknown fields that must be ignored', () => {
    expect(decodeInvoice(example('Same, but all upper case.')).amountMsat).toBe(2_500_000_000n)
    expect(decodeInvoice(example('Same, but including fields which must be ignored.')).paymentHash).toBe(HASH)
  })

  test.each([
    'Same, but with an `n` field of invalid length.',
    'Missing required `p` field.',
    'Two distinct p fields in an otherwise valid invoice.',
    'The same p field twice in an otherwise valid invoice.',
    'Two distinct s fields in an otherwise valid invoice.',
    'Bech32 checksum is invalid.',
    'Malformed bech32 string (no 1)',
    'Malformed bech32 string (mixed case)',
    'String is too short.',
    'Invalid multiplier',
    'Invalid sub-millisatoshi precision.',
    'Missing required `s` field.',
    // Refused here for its field layout, not for the high-S signature the
    // spec means it to demonstrate: we never look at the signature.
    "Non canonical signature (high-S) with 'n' field defined",
  ])('refuses invalid example: %s', (title) => {
    expect(() => decodeInvoice(example(title))).toThrow()
  })

  test('KNOWN LIMIT: accepts the example that is invalid only by its signature', () => {
    expect(decodeInvoice(example('Signature is not recoverable.')).paymentHash).toBe(HASH)
  })
})

const captured = new URL('../fixtures/captured.json', import.meta.url)
describe.skipIf(!existsSync(captured))('invoice issued by a real LND node (captured)', () => {
  test('decoded fields equal what the wallet service reported for the same invoice', () => {
    const { response } = JSON.parse(readFileSync(captured, 'utf8')).makeInvoice.plain
    const inv = decodeInvoice(response.invoice)
    expect(inv.network).toBe('bcrt')
    expect(inv.paymentHash).toBe(response.payment_hash)
    expect(inv.amountMsat).toBe(BigInt(response.amount))
    expect(inv.description).toBe(response.description)
    expect(inv.timestamp + inv.expiry).toBe(response.expires_at)
  })
})