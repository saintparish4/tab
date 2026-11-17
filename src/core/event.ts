/**
 * Inbound event gate. Everything that arrives from a relay is untrusted bytes
 * until it has passed `parseEvent`: the relay can forge, truncate, replay or
 * reorder, so no other module may read a field of a relay frame directly.
 *
 * Invariants:
 * - The returned object is rebuilt from the seven NIP-01 fields. nostr-tools
 *   caches its verdict under a Symbol on the object it verified, and object
 *   spread copies that Symbol, so verifying a caller-supplied object could
 *   return a stale "true" for content that was changed afterwards.
 * - Size caps come first, so a hostile relay cannot make us hash megabytes.
 * - This proves "the holder of `pubkey` signed exactly these fields". It says
 *   nothing about freshness: replay is handled by the caller (ids, e-tags).
 */
import { verifyEvent, type Event } from 'nostr-tools/pure'

export type { Event }

export const MAX_CONTENT = 65536
export const MAX_TAGS = 64

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

export function isHex64(x: unknown): x is string {
  return typeof x === 'string' && HEX64.test(x)
}

export function parseEvent(raw: unknown): Event | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isHex64(r.id) || !isHex64(r.pubkey)) return null
  if (typeof r.sig !== 'string' || !HEX128.test(r.sig)) return null
  if (!Number.isSafeInteger(r.kind) || (r.kind as number) < 0 || (r.kind as number) > 65535) return null
  if (!Number.isSafeInteger(r.created_at) || (r.created_at as number) < 0) return null
  if (typeof r.content !== 'string' || r.content.length > MAX_CONTENT) return null
  if (!Array.isArray(r.tags) || r.tags.length > MAX_TAGS) return null
  const tags: string[][] = []
  for (const t of r.tags) {
    if (!Array.isArray(t) || t.length === 0 || t.length > 8) return null
    if (!t.every((x) => typeof x === 'string' && x.length <= 4096)) return null
    tags.push([...(t as string[])])
  }
  const ev: Event = {
    id: r.id,
    pubkey: r.pubkey,
    sig: r.sig,
    kind: r.kind as number,
    created_at: r.created_at as number,
    content: r.content,
    tags,
  }
  return verifyEvent(ev) ? ev : null
}

/** First value of the first tag called `name`, or null */
export function tagValue(ev: { tags: string[][] }, name: string): string | null {
  const t = ev.tags.find((x) => x[0] === name)
  return t && typeof t[1] === 'string' ? t[1] : null
}
