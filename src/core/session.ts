/**
 * The login state machine, as a pure reducer so it can be attacked with
 * generated event sequences.
 *
 * "Logged in" here means two separate, local facts, and nothing more:
 *   unlocked      this device decrypted its vault, so it holds the Nostr key
 *   wallet ready  the wallet service answered a get_info request that this
 *                 session sent, for the connection currently loaded
 *
 * The wallet check is a capability check, not authentication of a person. It
 * is evidence for a limited time (`PROOF_TTL`); after that the UI must stop
 * offering wallet actions until it is repeated. Even while fresh it only gates
 * buttons: every real authorization decision is made by the wallet service
 * when a request arrives.
 *
 * Properties the tests hold this to:
 *  - `ready` is reachable only through a `proof` whose request id equals the
 *    id recorded by the most recent `checkStarted` (a replayed or forged
 *    proof, or one for a previous connection, is ignored);
 *  - lock, logout and disconnect discard every wallet fact;
 *  - `can()` is false unless unlocked, ready, fresh, and the method was listed.
 */
export const PROOF_TTL = 600

export type WalletState =
  | { w: 'none' }
  | { w: 'checking'; requestId: string }
  | { w: 'ready'; methods: string[]; provenAt: number }
  | { w: 'unreachable' }

export type Session = { unlocked: false } | { unlocked: true; wallet: WalletState }

export type Action =
  | { type: 'unlock' }
  | { type: 'lock' }
  | { type: 'logout' }
  | { type: 'disconnect' }
  | { type: 'checkStarted'; requestId: string }
  | { type: 'proof'; requestId: string; methods: string[]; at: number }
  | { type: 'checkFailed'; requestId: string }

export const initial: Session = { unlocked: false }

export function reduce(s: Session, a: Action): Session {
  if (a.type === 'lock' || a.type === 'logout') return { unlocked: false }
  if (a.type === 'unlock') return s.unlocked ? s : { unlocked: true, wallet: { w: 'none' } }
  if (!s.unlocked) return s
  switch (a.type) {
    case 'disconnect':
      return { unlocked: true, wallet: { w: 'none' } }
    case 'checkStarted':
      return { unlocked: true, wallet: { w: 'checking', requestId: a.requestId } }
    case 'proof':
      if (s.wallet.w !== 'checking' || s.wallet.requestId !== a.requestId) return s
      return { unlocked: true, wallet: { w: 'ready', methods: [...a.methods], provenAt: a.at } }
    case 'checkFailed':
      if (s.wallet.w !== 'checking' || s.wallet.requestId !== a.requestId) return s
      return { unlocked: true, wallet: { w: 'unreachable' } }
  }
}

export function can(s: Session, method: string, now: number): boolean {
  if (!s.unlocked || s.wallet.w !== 'ready') return false
  if (now < s.wallet.provenAt || now - s.wallet.provenAt > PROOF_TTL) return false
  return s.wallet.methods.includes(method)
}

/** What the wallet connection lets this user do, as the UI names it. */
export function role(s: Session, now: number): { canRequest: boolean; canPay: boolean } {
  return {
    canRequest: can(s, 'make_invoice', now) && can(s, 'lookup_invoice', now),
    canPay: can(s, 'pay_invoice', now),
  }
}
