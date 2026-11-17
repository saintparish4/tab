/**
 * A BOLT 11 string for tests: correctly encoded, with an all-zero signature.
 * That is enough here because the decoder does not check signatures; no
 * Lightning node would accept it. Real invoices are covered in test/it.
 */
import { bech32 } from '@scure/base'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export function fakeInvoice(o: {
  paymentHash: string
  description: string
  amountMsat?: bigint
  /** defaults to 1_800_000_000, the fixed clock the unit tests use */
  timestamp?: number
  expiry?: number
  network?: string
}): string {
  const int = (n: number, words: number) =>
    Array.from({ length: words }, (_, i) => Math.floor(n / 32 ** (words - 1 - i)) % 32)
  const field = (type: number, data: number[]) => [type, ...int(data.length, 2), ...data]
  const words = [
    ...int(o.timestamp ?? 1_800_000_000, 7),
    ...field(1, bech32.toWords(hexToBytes(o.paymentHash))),
    ...field(16, new Array(52).fill(0)),
    ...field(13, bech32.toWords(utf8ToBytes(o.description))),
    ...field(6, int(o.expiry ?? 600, 4)),
    ...new Array(104).fill(0),
  ]
  return bech32.encode(`ln${o.network ?? 'bcrt'}${(o.amountMsat ?? 2_500_000n) * 10n}p`, words, false)
}
