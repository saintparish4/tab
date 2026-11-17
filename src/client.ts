/**
 * Everything the app does, without any DOM: one identity, one peer, one relay,
 * at most one wallet connection. The page and the integration tests drive the
 * same object, so what the tests exercise is what the demo runs.
 *
 * Where each decision is made:
 *  - who wrote a message        giftwrap.unwrap (seal signature)
 *  - is a request payable       pay.checkRequest via thread.buildThread
 *  - may this device try to pay session.can (a convenience gate only)
 *  - may this connection pay    the wallet service, on every request
 *  - is it paid                 pay.verifyPreimage / the merchant's own wallet
 *
 * Failure rules:
 *  - relay down: messages queue in `outbox` and are re-sent on reconnect;
 *    wallet actions are disabled because their outcome could not be read;
 *  - wallet timeout on pay: outcome UNKNOWN, shown as such, resolved by
 *    lookup_invoice. It is never shown as failed and never retried blindly;
 *  - the page never logs. Nothing here calls console.*; a notice is shown to
 *    the user and held in memory only.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { decodeInvoice } from './core/bolt11.ts'
import type { Event } from './core/event.ts'
import { makeRumor, unwrap, wrap, type Rumor } from './core/giftwrap.ts'
import { readBudget, type Budget, type Conn } from './core/nwc.ts'
import { binding, KIND_CHAT, receiptTags, requestTags, verifyPreimage, type Network } from './core/pay.ts'
import { can, initial, reduce, role, type Action, type Session } from './core/session.ts'
import { buildThread, type Item } from './core/thread.ts'
import { Relay, type Status } from './net/relay.ts'
import { Wallet, WalletTimeout } from './net/wallet.ts'

export type Options = {
  sk: Uint8Array
  peer: string
  relayUrl: string
  network: Network
  conn: Conn | null
  onChange?: () => void
}
const nowSec = () => Math.floor(Date.now() / 1000)

export class Client {
  readonly me: string
  session: Session = initial
  relayStatus: Status = 'connecting'
  notice = ''
  /** payment hashes whose pay_invoice timed out: outcome unknown */
  readonly unknown = new Set<string>()
  readonly paying = new Set<string>()
  /** what the wallet last said about this connection's spending limit; display only */
  budget: Budget | null = null
  private rumors = new Map<string, Rumor>()
  private outbox = new Map<string, Event>()
  private preimages = new Map<string, string>()
  private settled = new Set<string>()
  private relay: Relay
  private wallet: Wallet | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private o: Options

  constructor(o: Options) {
    this.o = o
    this.me = getPublicKey(o.sk)
    this.dispatch({ type: 'unlock' })
    this.relay = new Relay(o.relayUrl, {
      // NIP-42: prove to the relay that we are the p-tagged recipient.
      auth: (challenge, url) =>
        finalizeEvent(
          {
            kind: 22242,
            created_at: nowSec(),
            tags: [
              ['relay', url],
              ['challenge', challenge],
            ],
            content: '',
          },
          o.sk,
        ),
      onStatus: (s) => {
        this.relayStatus = s
        if (s === 'open') this.flush()
        this.changed()
      },
    })
    this.relay.sub({ kinds: [1059], '#p': [this.me] }, (ev) => this.receive(ev))
    // NIP-17: tell other clients where to deliver our DMs.
    this.queue(finalizeEvent({ kind: 10050, created_at: nowSec(), tags: [['relay', o.relayUrl]], content: '' }, o.sk))
    if (o.conn) {
      this.wallet = new Wallet(o.conn)
      void this.checkWallet()
    }
    this.poll = setInterval(() => void this.confirmSettlements(), 4000)
  }

  private dispatch(a: Action): void {
    this.session = reduce(this.session, a)
  }
  private changed(): void {
    this.o.onChange?.()
  }
  private say(text: string): void {
    this.notice = text
    this.changed()
  }

  get role() {
    return role(this.session, nowSec())
  }

  thread(): Item[] {
    const facts = { preimages: this.preimages, settled: this.settled }
    return buildThread(this.rumors.values(), this.me, this.o.peer, this.o.network, facts, nowSec())
  }

  isQueued(rumorId: string): boolean {
    return [...this.outbox.keys()].some((k) => k.startsWith(rumorId))
  }

  // ---- messages -----------------------------------------------------------

  private receive(ev: Event): void {
    let rumor: Rumor
    try {
      rumor = unwrap(ev, this.o.sk)
    } catch {
      return // not for us, forged, or malformed: drop silently, never display
    }
    if (this.rumors.has(rumor.id)) return
    this.rumors.set(rumor.id, rumor)
    this.changed()
    void this.confirmSettlements()
  }

  private queue(ev: Event, key = ev.id): void {
    this.outbox.set(key, ev)
    this.relay.publish(ev).then(
      () => (this.outbox.delete(key), this.changed()),
      () => this.changed(), // stays queued; flush() retries on reconnect
    )
  }

  private flush(): void {
    for (const [key, ev] of this.outbox) this.queue(ev, key)
  }

  private post(tags: string[][], content: string): Rumor {
    const now = nowSec()
    const rumor = makeRumor(this.o.sk, KIND_CHAT, tags, content, now)
    this.rumors.set(rumor.id, rumor)
    // One wrap for the peer, one for ourselves so the thread can be rebuilt.
    this.queue(wrap(rumor, this.o.sk, this.o.peer, now), rumor.id + ':peer')
    this.queue(wrap(rumor, this.o.sk, this.me, now), rumor.id + ':self')
    this.changed()
    return rumor
  }

  send(text: string): void {
    if (text.trim()) this.post([['p', this.o.peer]], text.trim())
  }

  // ---- wallet -------------------------------------------------------------

  /** The "login" check: does the wallet service answer this connection, and for what? */
  async checkWallet(): Promise<void> {
    if (!this.wallet) return
    const requestId = bytesToHex(randomBytes(8))
    this.dispatch({ type: 'checkStarted', requestId })
    this.changed()
    try {
      await this.wallet.info() // refuses wallets that cannot do NIP-44
      const reply = await this.wallet.call('get_info')
      if (!reply.ok || !Array.isArray(reply.result.methods)) throw new Error('wallet refused get_info')
      this.dispatch({ type: 'proof', requestId, methods: reply.result.methods.map(String), at: nowSec() })
      void this.refreshBudget()
    } catch (e) {
      this.dispatch({ type: 'checkFailed', requestId })
      this.notice =
        e instanceof WalletTimeout ? 'Wallet did not answer. Chat still works; payments are off.' : (e as Error).message
    }
    this.changed()
  }

  /**
   * Ask the wallet how much of this connection's budget is left, to show it
   * before the user taps Pay. It never gates a payment: the number can be
   * stale, so the wallet stays the only judge. On any failure the last value
   * is dropped instead of being shown as current.
   */
  async refreshBudget(): Promise<void> {
    if (!this.wallet || !can(this.session, 'get_budget', nowSec())) return
    try {
      const reply = await this.wallet.call('get_budget', {}, 8000)
      this.budget = reply.ok ? readBudget(reply.result) : null
    } catch {
      this.budget = null
    }
    this.changed()
  }

  private async ready(method: string): Promise<boolean> {
    if (!can(this.session, method, nowSec())) await this.checkWallet()
    return can(this.session, method, nowSec())
  }

  /** Merchant: ask the wallet for an invoice bound to this conversation and send it. */
  async requestPayment(sats: number, note: string): Promise<void> {
    if (!Number.isSafeInteger(sats) || sats <= 0) return this.say('Enter a whole number of sats.')
    if (!this.wallet || !(await this.ready('make_invoice')))
      return this.say('This wallet connection cannot create invoices.')
    const ref = bytesToHex(randomBytes(8))
    const description = binding(this.me, this.o.peer, ref)
    try {
      const reply = await this.wallet.call('make_invoice', { amount: sats * 1000, description, expiry: 600 })
      if (!reply.ok) return this.say(`Wallet refused: ${reply.error.code}`)
      const bolt11 = String(reply.result.invoice ?? '')
      // Do not relay an invoice we did not ask for.
      const inv = decodeInvoice(bolt11)
      if (inv.amountMsat !== BigInt(sats) * 1000n || inv.description !== description)
        return this.say('Wallet returned a different invoice than requested.')
      this.post(
        requestTags(this.o.peer, bolt11, ref),
        `Payment request: ${sats} sats${note ? ' for ' + note : ''}\nlightning:${bolt11}`,
      )
    } catch (e) {
      this.say((e as Error).message)
    }
  }

  /** Customer: pay a request that the thread model currently calls payable. */
  async pay(requestId: string): Promise<void> {
    const item = this.thread().find((i) => i.id === requestId)
    if (!item?.pay || item.pay.role !== 'payer' || item.pay.state !== 'payable') return
    const { paymentHash, bolt11 } = item.pay
    if (this.paying.has(paymentHash) || this.unknown.has(paymentHash)) return
    if (!this.wallet || !(await this.ready('pay_invoice'))) return this.say('This wallet connection cannot pay.')
    this.paying.add(paymentHash)
    this.changed()
    try {
      const reply = await this.wallet.call('pay_invoice', { invoice: bolt11 }, 60000)
      if (!reply.ok) {
        this.notice =
          reply.error.code === 'QUOTA_EXCEEDED'
            ? "Over this connection's spending limit."
            : `Payment failed: ${reply.error.code}`
        void this.refreshBudget()
      } else this.acceptPreimage(requestId, paymentHash, reply.result.preimage)
    } catch (e) {
      if (e instanceof WalletTimeout) {
        this.unknown.add(paymentHash)
        this.notice = 'No answer from the wallet. The payment may or may not have gone through.'
      } else this.notice = (e as Error).message
    }
    this.paying.delete(paymentHash)
    this.changed()
  }

  private acceptPreimage(requestId: string, paymentHash: string, preimage: unknown): void {
    if (!verifyPreimage(preimage, paymentHash)) {
      this.notice = 'Wallet reported success without a valid proof of payment.'
      return
    }
    this.preimages.set(paymentHash, preimage as string)
    this.unknown.delete(paymentHash)
    void this.refreshBudget()
    this.post(receiptTags(this.o.peer, requestId, preimage as string), 'Paid. Proof of payment attached.')
  }

  /**
   * Ask our own wallet about invoices still open on either side:
   *  payee: has my invoice settled?        -> `settled`
   *  payer: did a timed-out payment land?  -> preimage, or stays unknown
   */
  async confirmSettlements(): Promise<void> {
    if (!this.wallet || this.relayStatus !== 'open' || !can(this.session, 'lookup_invoice', nowSec())) return
    for (const item of this.thread()) {
      const p = item.pay
      if (!p) continue
      const open =
        (p.role === 'payee' && (p.state === 'awaiting' || p.state === 'proof')) ||
        (p.role === 'payer' && this.unknown.has(p.paymentHash))
      if (!open) continue
      try {
        const reply = await this.wallet.call('lookup_invoice', { payment_hash: p.paymentHash }, 8000)
        if (!reply.ok || reply.result.payment_hash !== p.paymentHash) continue
        const done = reply.result.state === 'settled' || typeof reply.result.settled_at === 'number'
        if (p.role === 'payee' && done && reply.result.type === 'incoming') {
          this.settled.add(p.paymentHash)
          this.changed()
        } else if (p.role === 'payer' && done) {
          this.acceptPreimage(item.id, p.paymentHash, reply.result.preimage)
          this.changed()
        } else if (p.role === 'payer' && reply.result.state === 'failed') {
          this.unknown.delete(p.paymentHash)
          this.say('The payment did not go through. Nothing was sent.')
        }
      } catch {
        // wallet unreachable: leave the state exactly as it was
      }
    }
  }

  /** Lock: drop sockets and every in-memory fact. The vault on disk is untouched. */
  close(): void {
    if (this.poll) clearInterval(this.poll)
    this.relay.close()
    this.wallet?.close()
    this.wallet = null
    this.dispatch({ type: 'lock' })
    this.rumors.clear()
    this.outbox.clear()
    this.preimages.clear()
    this.settled.clear()
    this.budget = null
  }
}
