/**
 * The login state machine under generated action sequences, and the vault.
 *
 * Establishes: no ordering of the modelled actions (including proofs with
 * request ids the session never issued) reaches a state where a wallet action
 * is offered without a matching, fresh proof. It covers the reducer only;
 * whether the app dispatches these actions at the right moments is what the
 * integration and browser tests are for.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { can, initial, PROOF_TTL, reduce, role, type Action, type Session } from '../../src/core/session.ts'
import { open, seal, type Secrets } from '../../src/core/vault.ts'

const id = fc.constantFrom('r1', 'r2', 'r3')
const methods = fc.subarray(['pay_invoice', 'make_invoice', 'lookup_invoice', 'get_info'])
const at = fc.integer({ min: 0, max: 5000 })
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ type: 'unlock' }),
  fc.constant<Action>({ type: 'lock' }),
  fc.constant<Action>({ type: 'logout' }),
  fc.constant<Action>({ type: 'disconnect' }),
  id.map((requestId): Action => ({ type: 'checkStarted', requestId })),
  id.map((requestId): Action => ({ type: 'checkFailed', requestId })),
  fc.tuple(id, methods, at).map(([requestId, m, t]): Action => ({ type: 'proof', requestId, methods: m, at: t })),
)
const run = (actions: Action[]) => actions.reduce(reduce, initial)

describe('session reducer', () => {
  test('ready is reached only through a proof for the request currently pending', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let s: Session = initial
        let pending: string | null = null
        for (const a of actions) {
          const before = s
          s = reduce(s, a)
          const becameReady = s.unlocked && s.wallet.w === 'ready' && s !== before
          if (becameReady) {
            expect(a.type).toBe('proof')
            expect(before.unlocked && before.wallet.w === 'checking').toBe(true)
            expect((a as { requestId: string }).requestId).toBe(pending)
          }
          pending = s.unlocked && s.wallet.w === 'checking' ? s.wallet.requestId : null
        }
      }),
      { numRuns: 1000 },
    )
  })

  test('lock, logout and disconnect leave no wallet fact behind', () => {
    fc.assert(
      fc.property(
        fc.array(action, { maxLength: 30 }),
        fc.constantFrom<Action['type']>('lock', 'logout', 'disconnect'),
        at,
        (actions, end, now) => {
          const s = reduce(run(actions), { type: end } as Action)
          for (const m of ['pay_invoice', 'make_invoice', 'lookup_invoice']) expect(can(s, m, now)).toBe(false)
          expect(JSON.stringify(s)).not.toContain('methods')
        },
      ),
      { numRuns: 500 },
    )
  })

  test('can() requires unlocked, ready, fresh, and listed', () => {
    fc.assert(
      fc.property(
        fc.array(action, { maxLength: 30 }),
        at,
        fc.constantFrom('pay_invoice', 'make_invoice'),
        (actions, now, m) => {
          const s = run(actions)
          if (can(s, m, now)) {
            expect(s.unlocked && s.wallet.w === 'ready').toBe(true)
            if (s.unlocked && s.wallet.w === 'ready') {
              expect(s.wallet.methods).toContain(m)
              expect(now - s.wallet.provenAt).toBeGreaterThanOrEqual(0)
              expect(now - s.wallet.provenAt).toBeLessThanOrEqual(PROOF_TTL)
            }
          }
        },
      ),
      { numRuns: 1000 },
    )
  })

  test('a replayed proof for an earlier check does not restore a session', () => {
    const proof: Action = { type: 'proof', requestId: 'r1', methods: ['pay_invoice'], at: 100 }
    const live = run([{ type: 'unlock' }, { type: 'checkStarted', requestId: 'r1' }, proof])
    expect(can(live, 'pay_invoice', 100)).toBe(true)
    // same proof again after lock + unlock, after disconnect, and during a newer check
    expect(
      can(
        run([
          { type: 'unlock' },
          { type: 'checkStarted', requestId: 'r1' },
          proof,
          { type: 'lock' },
          { type: 'unlock' },
          proof,
        ]),
        'pay_invoice',
        100,
      ),
    ).toBe(false)
    expect(can(reduce(reduce(live, { type: 'disconnect' }), proof), 'pay_invoice', 100)).toBe(false)
    expect(can(reduce(reduce(live, { type: 'checkStarted', requestId: 'r2' }), proof), 'pay_invoice', 100)).toBe(false)
    expect(can(reduce(initial, proof), 'pay_invoice', 100)).toBe(false)
  })

  test('a proof goes stale, and roles follow the methods the wallet listed', () => {
    const s = run([
      { type: 'unlock' },
      { type: 'checkStarted', requestId: 'r1' },
      { type: 'proof', requestId: 'r1', methods: ['make_invoice', 'lookup_invoice'], at: 100 },
    ])
    expect(role(s, 100)).toEqual({ canRequest: true, canPay: false })
    expect(role(s, 100 + PROOF_TTL)).toEqual({ canRequest: true, canPay: false })
    expect(role(s, 101 + PROOF_TTL)).toEqual({ canRequest: false, canPay: false })
    expect(role(s, 99)).toEqual({ canRequest: false, canPay: false })
  })
})

describe('vault', () => {
  const secrets: Secrets = {
    sk: 'ab'.repeat(32),
    nwc: 'nostr+walletconnect://' + 'cd'.repeat(32) + '?relay=ws%3A%2F%2Fx&secret=' + 'ef'.repeat(32),
    peer: null,
  }
  const FAST = 1000 // iteration count for tests only; the app uses the default

  test('round-trips, and the stored blob contains neither secret', async () => {
    const blob = await seal(secrets, '4812', FAST)
    expect(await open(blob, '4812', FAST)).toEqual(secrets)
    const stored = JSON.stringify(blob)
    expect(stored).not.toContain(secrets.sk)
    expect(stored).not.toContain('ef'.repeat(32))
    expect(stored).not.toContain('walletconnect')
  })

  test('a wrong PIN or a modified blob fails closed', async () => {
    const blob = await seal(secrets, '4812', FAST)
    await expect(open(blob, '4813', FAST)).rejects.toThrow()
    const ct = atob(blob.ct)
    const flipped = btoa(String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1))
    await expect(open({ ...blob, ct: flipped }, '4812', FAST)).rejects.toThrow()
  })

  test('sealing twice gives different ciphertext (fresh salt and IV)', async () => {
    const a = await seal(secrets, '4812', FAST)
    const b = await seal(secrets, '4812', FAST)
    expect(a.ct).not.toBe(b.ct)
    expect(a.salt).not.toBe(b.salt)
  })
})
