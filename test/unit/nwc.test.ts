/**
 * The NWC message rules, attacked offline with a wallet service we play
 * ourselves, then checked against frames a real Alby Hub produced.
 *
 * Establishes: a response is accepted only if it is signed by the wallet key
 * in the connection string, addressed to this connection, answers the request
 * just sent, and names the method called. Does not establish: that any real
 * wallet enforces scopes or budgets. That is test/it/wallet.it.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { makeRequest, parseConn, readInfo, readResponse, type Conn } from '../../src/core/nwc.ts'
import { tagValue } from '../../src/core/event.ts'

const NOW = 1_800_000_000
const walletSk = generateSecretKey()
const walletPk = getPublicKey(walletSk)
const secret = bytesToHex(generateSecretKey())
const uri = `nostr+walletconnect://${walletPk}?relay=${encodeURIComponent('ws://localhost:7777')}&secret=${secret}`
const conn = parseConn(uri)

/** What an honest wallet service would send back, with every field overridable. */
function respond(
  c: Conn,
  requestId: string,
  body: unknown,
  o: { signer?: Uint8Array; p?: string; kind?: number; encryptTo?: string } = {},
) {
  const signer = o.signer ?? walletSk
  const key = nip44.utils.getConversationKey(signer, o.encryptTo ?? c.clientPk)
  return finalizeEvent(
    {
      kind: o.kind ?? 23195,
      created_at: NOW,
      tags: [
        ['p', o.p ?? c.clientPk],
        ['e', requestId],
      ],
      content: nip44.encrypt(JSON.stringify(body), key),
    },
    signer,
  )
}
const okInfo = { result_type: 'get_info', error: null, result: { methods: ['make_invoice'] } }

describe('parseConn', () => {
  test('reads a well-formed connection string', () => {
    expect(conn.walletPk).toBe(walletPk)
    expect(conn.relay).toBe('ws://localhost:7777/')
    expect(conn.clientPk).toBe(getPublicKey(hexToBytes(secret)))
  })

  test('refuses malformed strings instead of guessing', () => {
    const bad = [
      '',
      'https://example.com',
      uri.replace('nostr+walletconnect', 'nostr+wc'),
      uri.replace(walletPk, walletPk.slice(2)),
      uri.replace(secret, secret.slice(2)),
      uri.replace(secret, 'Z'.repeat(64)),
      uri.replace('ws%3A', 'http%3A'),
      uri + '&relay=wss%3A%2F%2Fsecond.example',
      `nostr+walletconnect://${walletPk}?secret=${secret}`,
    ]
    for (const b of bad) expect(() => parseConn(b), b).toThrow()
  })

  test('never throws anything but Error on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseConn(s)
        } catch (e) {
          expect(e).toBeInstanceOf(Error)
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('makeRequest', () => {
  test('is signed by the connection key, NIP-44 encrypted, expiring, and unique per call', () => {
    const a = makeRequest(conn, 'get_info', {}, NOW)
    const b = makeRequest(conn, 'get_info', {}, NOW)
    expect(a.pubkey).toBe(conn.clientPk)
    expect(a.kind).toBe(23194)
    expect(tagValue(a, 'p')).toBe(walletPk)
    expect(tagValue(a, 'encryption')).toBe('nip44_v2')
    expect(tagValue(a, 'expiration')).toBe(String(NOW + 60))
    expect(a.id).not.toBe(b.id) // same method, same second, different nonce
    const plain = nip44.decrypt(a.content, nip44.utils.getConversationKey(walletSk, conn.clientPk))
    expect(JSON.parse(plain)).toEqual({ method: 'get_info', params: {} })
    expect(a.content).not.toContain('get_info')
  })
})

describe('readResponse: the login proof', () => {
  const req = makeRequest(conn, 'get_info', {}, NOW)

  test('accepts the wallet service answering this request', () => {
    expect(readResponse(conn, req.id, 'get_info', respond(conn, req.id, okInfo))).toEqual({
      ok: true,
      result: { methods: ['make_invoice'] },
    })
  })

  test('returns a wallet error as a value, not as success', () => {
    const body = { result_type: 'pay_invoice', error: { code: 'RESTRICTED', message: 'no' }, result: null }
    expect(readResponse(conn, req.id, 'pay_invoice', respond(conn, req.id, body))).toEqual({
      ok: false,
      error: { code: 'RESTRICTED', message: 'no' },
    })
  })

  test('forged: signed by anyone other than the wallet service', () => {
    const mallory = generateSecretKey()
    expect(() => readResponse(conn, req.id, 'get_info', respond(conn, req.id, okInfo, { signer: mallory }))).toThrow(
      /not signed by the wallet/,
    )
  })

  test('forged: signed with the leaked connection secret itself', () => {
    // Whoever holds the connection string can sign as the client, never as the wallet.
    const forged = respond(conn, req.id, okInfo, { signer: conn.secret, encryptTo: walletPk })
    expect(() => readResponse(conn, req.id, 'get_info', forged)).toThrow(/not signed by the wallet/)
  })

  test('replayed: a genuine response to an earlier request', () => {
    const earlier = makeRequest(conn, 'get_info', {}, NOW - 3600)
    const old = respond(conn, earlier.id, okInfo)
    expect(readResponse(conn, earlier.id, 'get_info', old).ok).toBe(true)
    expect(() => readResponse(conn, req.id, 'get_info', old)).toThrow(/different request/)
  })

  test('replayed: any earlier request id is refused, for generated ids', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/), (otherId) => {
        fc.pre(otherId !== req.id)
        expect(() => readResponse(conn, req.id, 'get_info', respond(conn, otherId, okInfo))).toThrow()
      }),
      { numRuns: 50 },
    )
  })

  test('cross-connection: a genuine response meant for another connection', () => {
    const other = parseConn(uri.replace(secret, bytesToHex(generateSecretKey())))
    const theirs = respond(other, req.id, okInfo)
    expect(() => readResponse(conn, req.id, 'get_info', theirs)).toThrow(/not addressed/)
  })

  test('confused deputy: the answer to a different method', () => {
    const body = { result_type: 'get_balance', error: null, result: { balance: 1 } }
    expect(() => readResponse(conn, req.id, 'get_info', respond(conn, req.id, body))).toThrow(/result_type/)
  })

  test('malformed: wrong kind, tampered content, non-object body, neither result nor error', () => {
    expect(() => readResponse(conn, req.id, 'get_info', respond(conn, req.id, okInfo, { kind: 23194 }))).toThrow()
    const good = respond(conn, req.id, okInfo)
    expect(() =>
      readResponse(conn, req.id, 'get_info', { ...good, content: good.content.slice(0, -4) + 'AAAA' }),
    ).toThrow()
    expect(() => readResponse(conn, req.id, 'get_info', respond(conn, req.id, 'hello'))).toThrow()
    expect(() => readResponse(conn, req.id, 'get_info', respond(conn, req.id, { result_type: 'get_info' }))).toThrow(
      /neither/,
    )
  })
})

describe('readInfo', () => {
  const info = (tags: string[][], signer = walletSk) =>
    finalizeEvent({ kind: 13194, created_at: NOW, tags, content: 'pay_invoice get_info' }, signer)

  test('reads methods when NIP-44 is offered', () => {
    expect(readInfo(conn, info([['encryption', 'nip44_v2 nip04']]))).toEqual({ methods: ['pay_invoice', 'get_info'] })
  })

  test('refuses to downgrade to NIP-04, and refuses an info event from another key', () => {
    expect(() => readInfo(conn, info([['encryption', 'nip04']]))).toThrow(/downgrade/)
    expect(() => readInfo(conn, info([]))).toThrow(/downgrade/)
    expect(() => readInfo(conn, info([['encryption', 'nip44_v2']], generateSecretKey()))).toThrow(/not from the wallet/)
  })
})

const captured = new URL('../fixtures/captured.json', import.meta.url)
describe.skipIf(!existsSync(captured))('frames captured from a real Alby Hub (scripts/capture.ts)', () => {
  const c = existsSync(captured) ? JSON.parse(readFileSync(captured, 'utf8')) : null
  const real = () =>
    parseConn(`nostr+walletconnect://${c.walletPk}?relay=${encodeURIComponent(c.relay)}&secret=${c.secret}`)

  test('the real info event and get_info response satisfy every rule above', () => {
    expect(readInfo(real(), c.info).methods).toContain('make_invoice')
    const reply = readResponse(real(), c.getInfo.request.id, 'get_info', c.getInfo.response)
    expect(reply.ok && (reply.result.methods as string[]).includes('make_invoice')).toBe(true)
  })

  test('the real get_info response is refused as the answer to the make_invoice request', () => {
    expect(() => readResponse(real(), c.makeInvoice.request.id, 'get_info', c.getInfo.response)).toThrow(
      /different request/,
    )
  })

  test('on the wire: only kinds, keys and ciphertext are visible', () => {
    const wire = JSON.stringify([c.getInfo.request, c.getInfo.response, c.makeInvoice.request, c.makeInvoice.response])
    for (const secretWord of [
      'get_info',
      'make_invoice',
      'tab1capture',
      c.makeInvoice.plain.response.payment_hash,
      c.secret,
    ]) {
      expect(wire).not.toContain(secretWord)
    }
  })
})
