/**
 * NIP-59 gift wrap carrying NIP-17 rumors, written out instead of imported so
 * every check the trust contract relies on is visible in one screen.
 *
 * What `unwrap` establishes, in order:
 *  1. the wrap is a correctly signed kind 1059 addressed to us (p tag);
 *  2. the seal inside is a correctly signed kind 13 with no tags;
 *  3. the rumor's pubkey equals the seal's signer (NIP-17 MUST: otherwise
 *     anyone can claim any author);
 *  4. the rumor's id is the hash of its own fields. nostr-tools 2.26.0
 *     `nip59.unwrapEvent` does not recompute it, and we dedupe and reference
 *     messages by rumor id, so a sender-chosen id could shadow another message;
 *  5. we are named in the rumor (p tag) or wrote it (self-copy), so a seal
 *     cannot be lifted into a conversation it was not written for.
 *
 * What it cannot establish: when the message was written (both outer
 * timestamps are randomised by design and the rumor's is the sender's claim),
 * or that the sender cannot later deny it to a third party.
 */
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { isHex64, parseEvent, type Event } from './event.ts'

export type Rumor = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

const TWO_DAYS = 2 * 24 * 60 * 60

function pastTime(now: number): number {
  return now - Math.floor(Math.random() * TWO_DAYS)
}

export function makeRumor(sk: Uint8Array, kind: number, tags: string[][], content: string, now: number): Rumor {
  const body = { pubkey: getPublicKey(sk), created_at: now, kind, tags, content }
  return { ...body, id: getEventHash(body) }
}

export function wrap(rumor: Rumor, senderSk: Uint8Array, recipientPk: string, now: number): Event {
  const sealKey = nip44.utils.getConversationKey(senderSk, recipientPk)
  const seal = finalizeEvent(
    { kind: 13, created_at: pastTime(now), tags: [], content: nip44.encrypt(JSON.stringify(rumor), sealKey) },
    senderSk,
  )
  const oneTime = generateSecretKey()
  const wrapKey = nip44.utils.getConversationKey(oneTime, recipientPk)
  return finalizeEvent(
    {
      kind: 1059,
      created_at: pastTime(now),
      tags: [['p', recipientPk]],
      content: nip44.encrypt(JSON.stringify(seal), wrapKey),
    },
    oneTime,
  )
}

function parseRumor(raw: unknown): Rumor | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isHex64(r.id) || !isHex64(r.pubkey)) return null
  if (!Number.isSafeInteger(r.kind) || !Number.isSafeInteger(r.created_at)) return null
  if (typeof r.content !== 'string' || !Array.isArray(r.tags)) return null
  if (!r.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return null
  const rumor: Rumor = {
    id: r.id,
    pubkey: r.pubkey,
    created_at: r.created_at as number,
    kind: r.kind as number,
    tags: (r.tags as string[][]).map((t) => [...t]),
    content: r.content,
  }
  return getEventHash(rumor) === rumor.id ? rumor : null
}

export function unwrap(rawWrap: unknown, mySk: Uint8Array): Rumor {
  const me = getPublicKey(mySk)
  const w = parseEvent(rawWrap)
  if (!w || w.kind !== 1059) throw new Error('wrap: not a valid kind 1059 event')
  if (!w.tags.some((t) => t[0] === 'p' && t[1] === me)) throw new Error('wrap: not addressed to us')

  const seal = parseEvent(JSON.parse(nip44.decrypt(w.content, nip44.utils.getConversationKey(mySk, w.pubkey))))
  if (!seal || seal.kind !== 13) throw new Error('seal: not a valid kind 13 event')
  if (seal.tags.length !== 0) throw new Error('seal: tags must be empty')

  const rumor = parseRumor(JSON.parse(nip44.decrypt(seal.content, nip44.utils.getConversationKey(mySk, seal.pubkey))))
  if (!rumor) throw new Error('rumor: malformed or id does not match its fields')
  if (rumor.pubkey !== seal.pubkey) throw new Error('rumor: author differs from seal signer')
  const names = (pk: string) => rumor.tags.some((t) => t[0] === 'p' && t[1] === pk)
  if (rumor.pubkey !== me && !names(me)) throw new Error('rumor: we are not a participant')
  return rumor
}