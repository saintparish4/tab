/**
 * NIP-47 message layer: parse a connection string, build a request, and decide
 * whether a frame from the relay is the wallet's answer to *that* request.
 * No sockets here, so every rule below can be tested without a wallet.
 *
 * The connection secret is a bearer spending capability, not an identity. The
 * strongest thing this module can say is: "the wallet service whose key is in
 * the connection string answered a request signed with this connection's key".
 *
 * Rules that are deliberate departures from "be liberal in what you accept":
 * - NIP-44 only. NIP-47 lets a client fall back to NIP-04 when the public info
 *   event lacks an `encryption` tag; the info event is unauthenticated as to
 *   freshness, so honouring that would let a relay downgrade us by replaying
 *   or withholding it. We refuse instead.
 * - A response must be signed by the wallet key, p-tag our key, and e-tag the
 *   id of the request we just sent. The e-tag is what defeats replay: request
 *   ids are unique (random NIP-44 nonce), so an old response never matches.
 * - `result_type` must equal the method we called.
 *
 * nostr-tools 2.26.0 `nip47.makeNwcRequestEvent` is not used: it encrypts with
 * NIP-04, sends no `encryption` tag and only knows `pay_invoice`.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { isHex64, parseEvent, tagValue, type Event } from './event.ts'

export const KIND_INFO = 13194
export const KIND_REQUEST = 23194
export const KIND_RESPONSE = 23195
export const REQUEST_TTL = 60

export type Conn = { walletPk: string; relay: string; secret: Uint8Array; clientPk: string }
export type NwcError = { code: string; message: string }
export type NwcReply = { ok: true; result: Record<string, unknown> } | { ok: false; error: NwcError }

export function parseConn(uri: string): Conn {
  const text = uri.trim()
  if (!text.startsWith('nostr+walletconnect://')) throw new Error('not a nostr+walletconnect:// string')
  const u = new URL(text.replace('nostr+walletconnect://', 'http://'))
  const secret = u.searchParams.get('secret')
  const relays = u.searchParams.getAll('relay')
  if (!isHex64(u.hostname)) throw new Error('wallet pubkey must be 64 hex characters')
  if (!isHex64(secret)) throw new Error('secret must be 64 hex characters')
  if (relays.length !== 1) throw new Error('exactly one relay is supported')
  const relay = new URL(relays[0])
  if (relay.protocol !== 'wss:' && relay.protocol !== 'ws:') throw new Error('relay must be ws:// or wss://')
  const sk = hexToBytes(secret)
  return { walletPk: u.hostname, relay: relay.toString(), secret: sk, clientPk: getPublicKey(sk) }
}

export function makeRequest(conn: Conn, method: string, params: Record<string, unknown>, now: number): Event {
  const key = nip44.utils.getConversationKey(conn.secret, conn.walletPk)
  return finalizeEvent(
    {
      kind: KIND_REQUEST,
      created_at: now,
      // `expiration` bounds how long a relay can sit on a payment request and
      // still have the wallet act on it.
      tags: [
        ['p', conn.walletPk],
        ['encryption', 'nip44_v2'],
        ['expiration', String(now + REQUEST_TTL)],
      ],
      content: nip44.encrypt(JSON.stringify({ method, params }), key),
    },
    conn.secret,
  )
}

/** Throws unless `raw` is this wallet's answer to request `requestId` for `method`. */
export function readResponse(conn: Conn, requestId: string, method: string, raw: unknown): NwcReply {
  const ev = parseEvent(raw)
  if (!ev || ev.kind !== KIND_RESPONSE) throw new Error('response: not a valid kind 23195 event')
  if (ev.pubkey !== conn.walletPk) throw new Error('response: not signed by the wallet service')
  if (tagValue(ev, 'p') !== conn.clientPk) throw new Error('response: not addressed to this connection')
  if (tagValue(ev, 'e') !== requestId) throw new Error('response: answers a different request')
  const body: unknown = JSON.parse(
    nip44.decrypt(ev.content, nip44.utils.getConversationKey(conn.secret, conn.walletPk)),
  )
  if (typeof body !== 'object' || body === null) throw new Error('response: body is not an object')
  const b = body as Record<string, unknown>
  if (b.result_type !== method) throw new Error('response: result_type does not match the method called')
  if (typeof b.error === 'object' && b.error !== null) {
    const e = b.error as Record<string, unknown>
    return { ok: false, error: { code: String(e.code ?? 'OTHER'), message: String(e.message ?? '') } }
  }
  if (typeof b.result !== 'object' || b.result === null) throw new Error('response: neither result nor error')
  return { ok: true, result: b.result as Record<string, unknown> }
}

export type Budget = { usedMsat: number; totalMsat: number; daily: boolean }

/**
 * Reads a `get_budget` result. Returns null when the connection has no budget
 * or the numbers make no sense. The value is for display only: it is the
 * wallet's word at one moment, and the wallet alone decides each payment.
 */
export function readBudget(result: Record<string, unknown>): Budget | null {
  const used = result.used_budget
  const total = result.total_budget
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!whole(used) || !whole(total) || total === 0) return null
  return { usedMsat: used, totalMsat: total, daily: result.renewal_period === 'daily' }
}

/** The info event is public and replayable: use it for negotiation only, never as proof. */
export function readInfo(conn: Conn, raw: unknown): { methods: string[] } {
  const ev = parseEvent(raw)
  if (!ev || ev.kind !== KIND_INFO || ev.pubkey !== conn.walletPk) throw new Error('info: not from the wallet service')
  const enc = (tagValue(ev, 'encryption') ?? '').split(' ')
  if (!enc.includes('nip44_v2')) throw new Error('info: wallet does not offer nip44_v2; refusing to downgrade')
  return { methods: ev.content.split(' ').filter(Boolean) }
}
