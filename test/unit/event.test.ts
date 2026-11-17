/**
 * Property tests for the inbound gate and the gift-wrap checks.
 *
 * Establishes: for generated inputs, no single-field change to a signed event
 * survives `parseEvent`, and `unwrap` refuses each named forgery. A property
 * test samples the input space; it is strong evidence, not a proof.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import * as nip59 from 'nostr-tools/nip59'
import { parseEvent } from '../../src/core/event.ts'
import { makeRumor, unwrap, wrap, type Rumor } from '../../src/core/giftwrap.ts'

const NOW = 1_800_000_000
const tagArb = fc.array(fc.string({ maxLength: 20 }), { minLength: 1, maxLength: 4 })
// Built with `map` into a fresh literal: nostr-tools refuses to sign the
// null-prototype objects fast-check's `record` produces.
const templateArb = fc
  .tuple(fc.integer({ min: 0, max: 65535 }), fc.integer({ min: 0, max: 2 ** 32 }), fc.string({ maxLength: 200 }), fc.array(tagArb, { maxLength: 5 }))
  .map(([kind, created_at, content, tags]) => ({ kind, created_at, content, tags }))
const flipHex = (h: string, i: number) => h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1)

describe('parseEvent', () => {
  test('accepts every correctly signed event', () => {
    fc.assert(
      fc.property(templateArb, (t) => {
        const ev = finalizeEvent(t, generateSecretKey())
        const wire = JSON.parse(JSON.stringify(ev))
        expect(parseEvent(wire)).toMatchObject(wire)
      }),
      { numRuns: 100 },
    )
  })

  test('rejects any single-field change, even on an object nostr-tools already verified', () => {
    fc.assert(
      fc.property(templateArb, fc.integer({ min: 0, max: 5 }), fc.nat(), (t, field, n) => {
        // `ev` carries nostr-tools' cached "verified" Symbol; spread copies it.
        const ev = finalizeEvent(t, generateSecretKey())
        const bad: Record<string, unknown> = { ...ev }
        if (field === 0) bad.content = ev.content + 'x'
        if (field === 1) bad.created_at = ev.created_at + 1
        if (field === 2) bad.kind = (ev.kind + 1) % 65536
        if (field === 3) bad.tags = [...ev.tags, ['p', 'x']]
        if (field === 4) bad.sig = flipHex(ev.sig, n % 128)
        if (field === 5) bad.pubkey = getPublicKey(generateSecretKey())
        expect(parseEvent(bad)).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  test('rejects arbitrary JSON without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(parseEvent(v)).toBeNull()
      }),
      { numRuns: 300 },
    )
  })

  test('rejects oversized content before verifying it', () => {
    const ev = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: 'a'.repeat(70000) }, generateSecretKey())
    expect(parseEvent(ev)).toBeNull()
  })
})

describe('gift wrap', () => {
  const alice = generateSecretKey()
  const bob = generateSecretKey()
  const mallory = generateSecretKey()
  const bobPk = getPublicKey(bob)
  const alicePk = getPublicKey(alice)

  test('round-trips any chat text to the recipient and only the recipient', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 500 }), (text) => {
        const rumor = makeRumor(alice, 14, [['p', bobPk]], text, NOW)
        const w = wrap(rumor, alice, bobPk, NOW)
        expect(unwrap(JSON.parse(JSON.stringify(w)), bob)).toEqual(rumor)
        expect(() => unwrap(w, mallory)).toThrow()
      }),
      { numRuns: 50 },
    )
  })

  test('the wrap exposes neither the sender key nor the true time', () => {
    const rumor = makeRumor(alice, 14, [['p', bobPk]], 'meet at the stall at 9', NOW)
    const w = wrap(rumor, alice, bobPk, NOW)
    const wire = JSON.stringify(w)
    expect(wire).not.toContain(alicePk)
    expect(wire).not.toContain('stall')
    expect(w.created_at).toBeLessThanOrEqual(NOW)
    // ...but the recipient key is on the outside, in clear. See the contract.
    expect(w.tags).toEqual([['p', bobPk]])
  })

  test('interoperates with nostr-tools nip59 in both directions', () => {
    const rumor = makeRumor(alice, 14, [['p', bobPk]], 'hello', NOW)
    expect(nip59.unwrapEvent(wrap(rumor, alice, bobPk, NOW), bob)).toEqual(rumor)
    const theirs = nip59.wrapEvent({ kind: 14, tags: [['p', bobPk]], content: 'hi back' }, alice, bobPk)
    expect(unwrap(theirs, bob).content).toBe('hi back')
  })

  // Build a wrap by hand so each layer can be forged independently.
  function forge(rumor: object, sealSigner: Uint8Array, to: string, sealTags: string[][] = []) {
    const seal = finalizeEvent(
      { kind: 13, created_at: NOW, tags: sealTags, content: nip44.encrypt(JSON.stringify(rumor), nip44.utils.getConversationKey(sealSigner, to)) },
      sealSigner,
    )
    const k = generateSecretKey()
    return finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [['p', to]], content: nip44.encrypt(JSON.stringify(seal), nip44.utils.getConversationKey(k, to)) },
      k,
    )
  }

  test('rejects impersonation: rumor claims Alice, seal signed by Mallory', () => {
    const rumor = makeRumor(alice, 14, [['p', bobPk]], 'send the money to Mallory', NOW)
    expect(() => unwrap(forge(rumor, mallory, bobPk), bob)).toThrow(/author differs/)
  })

  test('rejects a sender-chosen rumor id (nostr-tools 2.26.0 accepts it)', () => {
    const real = makeRumor(alice, 14, [['p', bobPk]], 'first', NOW)
    const shadow: Rumor = { ...makeRumor(mallory, 14, [['p', bobPk]], 'second', NOW), id: real.id }
    const w = forge(shadow, mallory, bobPk)
    expect(() => unwrap(w, bob)).toThrow(/id does not match/)
    expect(nip59.unwrapEvent(w, bob).id).toBe(real.id)
  })

  test('rejects a seal carrying tags, a wrong inner kind, and a rumor not meant for us', () => {
    const rumor = makeRumor(alice, 14, [['p', bobPk]], 'x', NOW)
    expect(() => unwrap(forge(rumor, alice, bobPk, [['p', bobPk]]), bob)).toThrow(/tags must be empty/)
    const lifted = makeRumor(alice, 14, [['p', getPublicKey(mallory)]], 'for mallory', NOW)
    expect(() => unwrap(forge(lifted, alice, bobPk), bob)).toThrow(/not a participant/)
    const notSeal = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: 'x' }, alice)
    const k = generateSecretKey()
    const w = finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [['p', bobPk]], content: nip44.encrypt(JSON.stringify(notSeal), nip44.utils.getConversationKey(k, bobPk)) },
      k,
    )
    expect(() => unwrap(w, bob)).toThrow(/kind 13/)
  })

  test('rejects a wrap whose outer signature or p tag was altered by the relay', () => {
    const w = wrap(makeRumor(alice, 14, [['p', bobPk]], 'x', NOW), alice, bobPk, NOW)
    expect(() => unwrap({ ...w, content: w.content.slice(0, -4) + 'AAAA' }, bob)).toThrow()
    expect(() => unwrap({ ...w, tags: [['p', alicePk]] }, bob)).toThrow()
    expect(getEventHash(w)).toBe(w.id)
  })
})