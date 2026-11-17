/**
 * NIP-17 interop with an implementation this repo shares no code with:
 * `nak` (Go, built on fiatjaf's nostr library), driven as a subprocess.
 * Set NAK to the binary's path; the suite is skipped if it is not found.
 *
 * Establishes: our wrap is readable by an independent NIP-59 implementation
 * and theirs by ours, byte format and all, including delivery through the
 * relay into the app's thread. It is one other implementation, not all of them.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, test } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { Client } from '../../src/client.ts'
import { makeRumor, unwrap, wrap } from '../../src/core/giftwrap.ts'
import { Relay } from '../../src/net/relay.ts'
import { demo, RELAY } from './stack.ts'

const NAK = process.env.NAK ?? 'nak'
const hasNak = spawnSync(NAK, ['--version']).status === 0
// With no input, stdin must be closed outright or `nak event` waits on it.
const nak = (args: string[], input?: string) =>
  execFileSync(NAK, args, {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  }).trim()
// Use plain identity keys on both ends, not nak's optional decoupled keys.
const PLAIN = ['--use-our-identity-key', '--use-their-identity-key']

describe.skipIf(!hasNak)('NIP-17 round trip with nak', () => {
  const d = demo()
  const theirSk = bytesToHex(generateSecretKey())
  const theirPk = getPublicKey(hexToBytes(theirSk))
  const ourSk = hexToBytes(d.merchant.sk)
  const now = Math.floor(Date.now() / 1000)
  const client = new Client({ sk: ourSk, peer: theirPk, relayUrl: RELAY, network: 'bcrt', conn: null })
  afterAll(() => client.close())

  test('nak wraps, we unwrap', () => {
    const event = nak(['event', '--sec', theirSk, '-k', '14', '-c', 'hello from nak', '-p', d.merchant.pk])
    const wrapped = JSON.parse(nak(['gift', 'wrap', '--sec', theirSk, '-p', d.merchant.pk, ...PLAIN], event))
    expect(wrapped.kind).toBe(1059)
    const rumor = unwrap(wrapped, ourSk)
    expect(rumor).toMatchObject({ kind: 14, pubkey: theirPk, content: 'hello from nak' })
  })

  test('we wrap, nak unwraps to the identical rumor', () => {
    const rumor = makeRumor(ourSk, 14, [['p', theirPk]], 'hello from tab', now)
    const out = JSON.parse(nak(['gift', 'unwrap', '--sec', theirSk], JSON.stringify(wrap(rumor, ourSk, theirPk, now))))
    expect(out).toMatchObject({
      id: rumor.id,
      pubkey: rumor.pubkey,
      kind: 14,
      content: 'hello from tab',
      tags: [['p', theirPk]],
    })
  })

  test("a nak-wrapped message published to the relay shows up in the app's thread", async () => {
    const text = 'via relay ' + Date.now()
    const event = nak(['event', '--sec', theirSk, '-k', '14', '-c', text, '-p', d.merchant.pk])
    const wrapped = JSON.parse(nak(['gift', 'wrap', '--sec', theirSk, '-p', d.merchant.pk, ...PLAIN], event))
    const relay = new Relay(RELAY)
    await relay.publish(wrapped)
    relay.close()
    for (let i = 0; i < 100 && !client.thread().some((m) => m.text === text); i++)
      await new Promise((r) => setTimeout(r, 100))
    expect(client.thread().find((m) => m.text === text)).toMatchObject({ mine: false, text })
  })
})
