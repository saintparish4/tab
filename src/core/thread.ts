/**
 * The conversation as a pure function of (set of rumors, wallet facts, clock).
 *
 * A relay may deliver events late, twice, out of order or not at all, so the
 * view must not depend on arrival order: rumors are deduplicated by id and
 * sorted by (created_at, id) before anything is derived. Feeding the same set
 * in any order, any number of times, yields the same thread.
 *
 * Payment state is derived, never stored, and only from evidence:
 *   payer  (request came from the peer)
 *     payable -> paid      a preimage that hashes to the invoice's payment
 *                          hash, from my own wallet or my own receipt
 *     payable -> expired   the invoice's own expiry has passed
 *   payee  (I sent the request)
 *     awaiting -> proof    the peer's receipt carries a matching preimage
 *     ...      -> settled  MY wallet reports the invoice settled
 *
 * "settled" outranks "proof": a matching preimage shows the payment happened,
 * but the merchant's own wallet is the record they will be paid from.
 * Nothing the peer writes can produce "paid" or "settled" on its own.
 */
import { tagValue } from './event.ts'
import type { Rumor } from './giftwrap.ts'
import { checkRequest, KIND_CHAT, verifyPreimage, type Network } from './pay.ts'

export type PayView = {
  role: 'payer' | 'payee'
  state: 'payable' | 'paid' | 'awaiting' | 'proof' | 'settled' | 'expired'
  amountMsat: bigint
  paymentHash: string
  bolt11: string
}
export type Item = { id: string; mine: boolean; at: number; text: string; pay?: PayView; warn?: string }
export type Facts = {
  /** payment hash -> preimage returned by my own wallet's pay_invoice */
  preimages: ReadonlyMap<string, string>
  /** payment hashes my own wallet reported as settled incoming invoices */
  settled: ReadonlySet<string>
}

export function buildThread(
  rumors: Iterable<Rumor>,
  me: string,
  peer: string,
  network: Network,
  facts: Facts,
  now: number,
): Item[] {
  const byId = new Map<string, Rumor>()
  for (const r of rumors) {
    const names = (pk: string) => r.tags.some((t) => t[0] === 'p' && t[1] === pk)
    const inThread = (r.pubkey === me && names(peer)) || (r.pubkey === peer && names(me))
    if (r.kind === KIND_CHAT && inThread) byId.set(r.id, r)
  }
  const sorted = [...byId.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
  const receipts = sorted.filter((r) => tagValue(r, 'tab') === 'receipt')

  return sorted.map((r): Item => {
    const mine = r.pubkey === me
    const item: Item = { id: r.id, mine, at: r.created_at, text: r.content }
    const kind = tagValue(r, 'tab')

    if (kind === 'request') {
      const customer = mine ? peer : me
      const checked = checkRequest(r, customer, network)
      if (!checked.ok) return { ...item, warn: 'Not payable: ' + checked.reason }
      const hash = checked.invoice.paymentHash
      const proven =
        verifyPreimage(facts.preimages.get(hash), hash) ||
        receipts.some(
          (x) => x.pubkey === customer && tagValue(x, 'e') === r.id && verifyPreimage(tagValue(x, 'preimage'), hash),
        )
      const expired = checked.invoice.timestamp + checked.invoice.expiry <= now
      let state: PayView['state']
      if (mine) state = facts.settled.has(hash) ? 'settled' : proven ? 'proof' : expired ? 'expired' : 'awaiting'
      else state = proven ? 'paid' : expired ? 'expired' : 'payable'
      return {
        ...item,
        pay: {
          role: mine ? 'payee' : 'payer',
          state,
          amountMsat: checked.invoice.amountMsat!,
          paymentHash: hash,
          bolt11: checked.bolt11,
        },
      }
    }

    if (kind === 'receipt') {
      const target = byId.get(tagValue(r, 'e') ?? '')
      if (!target) return { ...item, warn: 'Refers to a request this device has not received' }
      const checked = checkRequest(target, r.pubkey, network)
      const good =
        checked.ok && target.pubkey !== r.pubkey && verifyPreimage(tagValue(r, 'preimage'), checked.invoice.paymentHash)
      return good ? item : { ...item, warn: 'Payment claim without valid proof' }
    }
    return item
  })
}
