/**
 * The payment messages that travel inside the chat, and the checks that turn
 * "the other side says so" into something verified.
 *
 * Both messages are ordinary NIP-17 kind 14 rumors with readable `content`,
 * so an independent client shows them as text. This app reads only the tags.
 *
 *   request  (merchant -> customer)  tags: tab=request, bolt11, ref
 *   receipt  (customer -> merchant)  tags: tab=receipt, e=<request id>, preimage
 *
 * Binding. The invoice description must equal `binding(merchant, customer,
 * ref)`, a hash over both Nostr keys and a random ref. The merchant's
 * Lightning node signs the description, so an invoice issued for conversation
 * (M, X) cannot be presented as payable in conversation (X, V): V's client
 * recomputes the hash with its own key and refuses. Wallet services and
 * routing nodes see only an opaque 32-hex string.
 *
 * Paid. `sha256(preimage) == payment_hash` is the whole test. A receipt whose
 * preimage does not hash to the invoice in the request it points at proves
 * nothing and must never change what is shown as paid.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { decodeInvoice, type Invoice } from './bolt11.ts'
import { isHex64, tagValue } from './event.ts'
import type { Rumor } from './giftwrap.ts'

export const KIND_CHAT = 14
export type Network = Invoice['network']

export function binding(merchantPk: string, customerPk: string, ref: string): string {
  const digest = sha256(utf8ToBytes(`tab/v1|${merchantPk}|${customerPk}|${ref}`))
  return 'tab1' + bytesToHex(digest).slice(0, 32)
}

export function verifyPreimage(preimage: unknown, paymentHash: string): boolean {
  return isHex64(preimage) && bytesToHex(sha256(hexToBytes(preimage))) === paymentHash
}

export function requestTags(customerPk: string, bolt11: string, ref: string): string[][] {
  return [
    ['p', customerPk],
    ['tab', 'request'],
    ['bolt11', bolt11],
    ['ref', ref],
  ]
}

export function receiptTags(merchantPk: string, requestId: string, preimage: string): string[][] {
  return [
    ['p', merchantPk],
    ['tab', 'receipt'],
    ['e', requestId],
    ['preimage', preimage],
  ]
}

export type Checked = { ok: true; invoice: Invoice; bolt11: string } | { ok: false; reason: string }

/**
 * Is this request rumor one we would let the user pay? `customerPk` is the
 * key the request is addressed to. Expiry is the caller's concern: it changes
 * with the clock, while everything checked here is fixed once written.
 */
export function checkRequest(rumor: Rumor, customerPk: string, network: Network): Checked {
  const bolt11 = tagValue(rumor, 'bolt11')
  const ref = tagValue(rumor, 'ref')
  if (rumor.kind !== KIND_CHAT || tagValue(rumor, 'tab') !== 'request' || !bolt11 || !ref) {
    return { ok: false, reason: 'not a payment request' }
  }
  let invoice: Invoice
  try {
    invoice = decodeInvoice(bolt11)
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  if (invoice.network !== network) return { ok: false, reason: `invoice is for network ${invoice.network}` }
  if (invoice.amountMsat === null || invoice.amountMsat <= 0n) return { ok: false, reason: 'invoice has no amount' }
  if (invoice.description !== binding(rumor.pubkey, customerPk, ref)) {
    return { ok: false, reason: 'invoice was not issued for this conversation' }
  }
  return { ok: true, invoice, bolt11 }
}
