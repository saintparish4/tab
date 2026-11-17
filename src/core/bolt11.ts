/**
 * Read-only BOLT 11 decoder for the five things the app must check before it
 * asks a wallet to pay: network, amount, payment hash, description, expiry.
 *
 * It does NOT verify the invoice signature or recover the payee node key.
 * That is a stated limit, not an oversight: the invoice reaches us inside a
 * seal signed by the sender's Nostr key (origin), the fields we check are in
 * the same string the wallet is given (no substitution between check and
 * pay), and the paying node verifies the signature itself. What we do not
 * learn is which Lightning node gets paid.
 *
 * Reader rules follow BOLT 11 "Requirements": fixed-length fields (`p`, `h`,
 * `s`, `n`) with the wrong length fail, exactly one `p`, exactly one `s`, and
 * exactly one of `d` / `h`.
 */
import { bech32 } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'

export type Invoice = {
  network: 'bc' | 'tb' | 'tbs' | 'bcrt'
  amountMsat: bigint | null
  timestamp: number
  expiry: number
  paymentHash: string
  description: string | null
}

const HRP = /^ln(bcrt|bc|tbs|tb)(?:([1-9][0-9]*)([munp]?))?$/
// msat per unit of the multiplier: BTC = 1e11 msat; `p` is a tenth of a msat.
const MSAT: Record<string, bigint> = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n }
const SIGNATURE_WORDS = 104

function toInt(words: number[]): number {
  return words.reduce((n, w) => n * 32 + w, 0)
}

/** 5-bit words to bytes, dropping the trailing pad bits BOLT 11 allows. */
function toBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(Math.floor((words.length * 5) / 8))
  let acc = 0
  let bits = 0
  let i = 0
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[i++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export function decodeInvoice(text: string): Invoice {
  const raw = text.trim().replace(/^lightning:/i, '')
  if (raw.length > 2048) throw new Error('invoice: too long')
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error('invoice: mixed case')
  const s = raw.toLowerCase()
  const { prefix, words } = bech32.decode(s as `${string}1${string}`, false)
  const m = HRP.exec(prefix)
  if (!m) throw new Error('invoice: unknown prefix')
  let amountMsat: bigint | null = null
  if (m[2]) {
    const n = BigInt(m[2])
    if (m[3] === 'p') {
      if (n % 10n !== 0n) throw new Error('invoice: sub-millisatoshi amount')
      amountMsat = n / 10n
    } else amountMsat = n * MSAT[m[3]]
  }
  if (words.length < 7 + SIGNATURE_WORDS) throw new Error('invoice: too short')
  const data = words.slice(0, words.length - SIGNATURE_WORDS)
  const timestamp = toInt(data.slice(0, 7))

  let paymentHash: string | null = null
  let description: string | null = null
  let hashed = false
  let secrets = 0
  let expiry = 3600
  for (let i = 7; i < data.length;) {
    if (i + 3 > data.length) throw new Error('invoice: truncated field')
    const type = data[i]
    const len = data[i + 1] * 32 + data[i + 2]
    const body = data.slice(i + 3, i + 3 + len)
    if (body.length !== len) throw new Error('invoice: truncated field')
    i += 3 + len
    if (type === 1) {
      if (len !== 52 || paymentHash) throw new Error('invoice: bad payment hash field')
      paymentHash = bytesToHex(toBytes(body))
    } else if (type === 13) {
      description = new TextDecoder('utf-8', { fatal: true }).decode(toBytes(body))
    } else if (type === 23) {
      if (len !== 52) throw new Error('invoice: bad description hash field')
      hashed = true
    } else if (type === 16) {
      if (len !== 52) throw new Error('invoice: bad payment secret field')
      secrets++
    } else if (type === 19) {
      if (len !== 53) throw new Error('invoice: bad payee field')
    } else if (type === 6) {
      expiry = toInt(body)
    }
  }
  if (!paymentHash) throw new Error('invoice: no payment hash')
  if (secrets !== 1) throw new Error('invoice: need exactly one payment secret')
  if ((description !== null) === hashed) throw new Error('invoice: need exactly one of description / description hash')
  return { network: m[1] as Invoice['network'], amountMsat, timestamp, expiry, paymentHash, description }
}
