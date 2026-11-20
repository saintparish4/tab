/**
 * The simulated back end for the public demo: one Nostr relay and two wallet
 * services, all inside this page. The two phone frames run the unmodified Tab
 * build; `app/sim-socket.js` hands their WebSockets to `connect()` below.
 *
 * What is simulated: the relay, the two NWC wallet services, and the
 * Lightning payment between them (a shared ledger; no node, no channel, no
 * money). Invoices are correctly encoded BOLT 11 strings with an all-zero
 * signature, which no real Lightning node would pay.
 *
 * What is not simulated: every byte the app sends and checks. Events are
 * signed and verified, messages are NIP-44 encrypted gift wraps, wallet
 * requests and replies are real NIP-47 events, and "paid" still needs a
 * preimage that hashes to the invoice's payment hash.
 *
 * The wallet rules copy what the project measured on Alby Hub 1.24.7: scope
 * and budget are enforced here, not in the app; an unknown connection key
 * gets no answer; a replayed request is executed once; the preimage of an
 * unpaid invoice is not disclosed.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { bech32 } from '@scure/base'

export const RELAY_URL = 'wss://relay.simulated.invalid/'
const now = () => Math.floor(Date.now() / 1000)
const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1] ?? null

// ---- relay ------------------------------------------------------------------

function matches(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (typeof f.since === 'number' && ev.created_at < f.since) return false
  if (typeof f.until === 'number' && ev.created_at > f.until) return false
  for (const [k, want] of Object.entries(f)) {
    if (k[0] !== '#' || !Array.isArray(want)) continue
    if (!ev.tags.some((t) => t[0] === k.slice(1) && want.includes(t[1]))) return false
  }
  return true
}

export class Relay {
  events = new Map()
  conns = new Set()
  /** called with every event the relay accepts: this is what its operator can see */
  onAccept = () => {}

  /** `deliver` receives one text frame at a time, like a WebSocket message. */
  connect(deliver) {
    const conn = { subs: new Map(), authed: new Set(), challenge: bytesToHex(randomBytes(16)), open: true }
    conn.out = (frame) => {
      const text = JSON.stringify(frame)
      // Same delay for every frame, so order is kept.
      setTimeout(() => {
        if (!conn.open) return
        try {
          deliver(text)
        } catch {
          this.drop(conn) // the frame that owned this socket is gone
        }
      }, 25)
    }
    this.conns.add(conn)
    conn.out(['AUTH', conn.challenge])
    return { send: (text) => this.onFrame(conn, text), close: () => this.drop(conn) }
  }

  drop(conn) {
    conn.open = false
    this.conns.delete(conn)
  }

  /** NIP-17 as nostr-rs-relay does it with nip42_dms: a gift wrap goes only to its authenticated recipient. */
  visible(conn, ev) {
    return ev.kind !== 1059 || conn.authed.has(tag(ev, 'p'))
  }

  onFrame(conn, text) {
    let f
    try {
      f = JSON.parse(text)
    } catch {
      return
    }
    if (!Array.isArray(f)) return
    if (f[0] === 'EVENT') this.onEvent(conn, f[1])
    else if (f[0] === 'AUTH') {
      const ev = f[1]
      const ok =
        ev && verifyEvent(ev) && ev.kind === 22242 && tag(ev, 'challenge') === conn.challenge && tag(ev, 'relay') === RELAY_URL
      if (ok) conn.authed.add(ev.pubkey)
      conn.out(['OK', ev?.id ?? '', ok, ok ? '' : 'restricted: bad auth event'])
    } else if (f[0] === 'REQ') {
      const id = String(f[1])
      const filters = f.slice(2).filter((x) => x && typeof x === 'object')
      conn.subs.set(id, filters)
      const found = [...this.events.values()]
        .filter((ev) => this.visible(conn, ev) && filters.some((x) => matches(x, ev)))
        .sort((a, b) => b.created_at - a.created_at)
      const limit = Math.min(...filters.map((x) => (typeof x.limit === 'number' ? x.limit : Infinity)))
      for (const ev of found.slice(0, limit)) conn.out(['EVENT', id, ev])
      conn.out(['EOSE', id])
    } else if (f[0] === 'CLOSE') conn.subs.delete(String(f[1]))
  }

  onEvent(conn, ev) {
    if (!ev || typeof ev !== 'object' || !verifyEvent(ev)) return conn.out(['OK', ev?.id ?? '', false, 'invalid: bad event'])
    if (ev.kind === 22242) return conn.out(['OK', ev.id, false, 'invalid: auth events are not stored'])
    const ephemeral = ev.kind >= 20000 && ev.kind < 30000
    const replaceable = ev.kind === 0 || ev.kind === 3 || (ev.kind >= 10000 && ev.kind < 20000)
    if (!this.events.has(ev.id)) {
      if (replaceable)
        for (const old of this.events.values())
          if (old.kind === ev.kind && old.pubkey === ev.pubkey) this.events.delete(old.id)
      if (!ephemeral) this.events.set(ev.id, ev)
      this.onAccept(ev, !ephemeral)
      for (const c of this.conns)
        for (const [id, filters] of c.subs)
          if (this.visible(c, ev) && filters.some((x) => matches(x, ev))) c.out(['EVENT', id, ev])
    }
    conn.out(['OK', ev.id, true, ''])
  }
}

// ---- Lightning, reduced to a ledger -----------------------------------------

/** A BOLT 11 string that decodes correctly and carries an all-zero signature. */
function invoiceString(paymentHash, description, amountMsat, timestamp, expiry) {
  const int = (n, words) => Array.from({ length: words }, (_, i) => Math.floor(n / 32 ** (words - 1 - i)) % 32)
  const field = (type, data) => [type, ...int(data.length, 2), ...data]
  const words = [
    ...int(timestamp, 7),
    ...field(1, bech32.toWords(hexToBytes(paymentHash))),
    ...field(16, bech32.toWords(randomBytes(32))),
    ...field(13, bech32.toWords(utf8ToBytes(description))),
    ...field(6, int(expiry, 4)),
    ...new Array(104).fill(0),
  ]
  return bech32.encode(`lnbcrt${BigInt(amountMsat) * 10n}p`, words, false)
}

export class Ledger {
  invoices = new Map()
}

// ---- wallet service (NIP-47) ------------------------------------------------

export class WalletService {
  /** `grant`: the methods this connection may call. `budgetMsat`: daily spending limit, or 0 for none. */
  constructor(relay, ledger, name, grant, budgetMsat) {
    this.ledger = ledger
    this.name = name
    this.methods = [...grant, 'get_info', 'get_budget']
    this.budgetMsat = budgetMsat
    this.usedMsat = 0
    this.paid = new Map()
    this.seen = new Set()
    this.sk = generateSecretKey()
    this.pk = getPublicKey(this.sk)
    const clientSk = generateSecretKey()
    this.clientPk = getPublicKey(clientSk)
    this.key = nip44.utils.getConversationKey(this.sk, this.clientPk)
    this.uri = `nostr+walletconnect://${this.pk}?relay=${encodeURIComponent(RELAY_URL)}&secret=${bytesToHex(clientSk)}`
    this.conn = relay.connect((text) => this.onFrame(text))
    const info = { kind: 13194, created_at: now(), tags: [['encryption', 'nip44_v2']], content: this.methods.join(' ') }
    this.conn.send(JSON.stringify(['EVENT', finalizeEvent(info, this.sk)]))
    this.conn.send(JSON.stringify(['REQ', 'requests', { kinds: [23194], '#p': [this.pk] }]))
  }

  onFrame(text) {
    const f = JSON.parse(text)
    if (f[0] !== 'EVENT') return
    const ev = f[2]
    // An unknown connection key gets no answer at all, and a request is run once.
    if (ev.pubkey !== this.clientPk || this.seen.has(ev.id)) return
    this.seen.add(ev.id)
    const expires = Number(tag(ev, 'expiration'))
    if (expires && expires < now()) return
    let method = ''
    let params = {}
    try {
      const body = JSON.parse(nip44.decrypt(ev.content, this.key))
      method = String(body.method)
      params = body.params ?? {}
    } catch {
      return
    }
    // A real wallet takes a moment, longest when it has to route a payment.
    setTimeout(() => this.reply(ev.id, method, this.run(method, params)), method === 'pay_invoice' ? 450 : 120)
  }

  reply(requestId, method, outcome) {
    const body = { result_type: method, ...outcome }
    const ev = finalizeEvent(
      {
        kind: 23195,
        created_at: now(),
        tags: [
          ['p', this.clientPk],
          ['e', requestId],
        ],
        content: nip44.encrypt(JSON.stringify(body), this.key),
      },
      this.sk,
    )
    this.conn.send(JSON.stringify(['EVENT', ev]))
  }

  run(method, p) {
    const error = (code, message) => ({ error: { code, message } })
    const known = ['get_info', 'get_budget', 'make_invoice', 'lookup_invoice', 'pay_invoice']
    if (!known.includes(method)) return error('NOT_IMPLEMENTED', 'method not supported')
    if (!this.methods.includes(method)) return error('RESTRICTED', 'this connection may not call ' + method)

    if (method === 'get_info')
      return { result: { alias: `Simulated wallet (${this.name})`, network: 'regtest', methods: this.methods } }

    if (method === 'get_budget')
      return this.budgetMsat
        ? { result: { used_budget: this.usedMsat, total_budget: this.budgetMsat, renewal_period: 'daily' } }
        : { result: {} }

    if (method === 'make_invoice') {
      const amount = Number(p.amount)
      if (!Number.isSafeInteger(amount) || amount <= 0) return error('OTHER', 'bad amount')
      const preimage = bytesToHex(randomBytes(32))
      const payment_hash = bytesToHex(sha256(hexToBytes(preimage)))
      const created_at = now()
      const expiry = Number(p.expiry) > 0 ? Number(p.expiry) : 3600
      const description = String(p.description ?? '')
      const invoice = invoiceString(payment_hash, description, amount, created_at, expiry)
      const record = { owner: this, invoice, description, payment_hash, preimage, amount, created_at, expires_at: created_at + expiry, settled_at: null }
      this.ledger.invoices.set(payment_hash, record)
      return { result: this.view(record, 'incoming') }
    }

    if (method === 'lookup_invoice') {
      const record = this.ledger.invoices.get(String(p.payment_hash ?? ''))
      if (record?.owner === this) return { result: this.view(record, 'incoming') }
      if (record && this.paid.has(record.payment_hash)) return { result: this.view(record, 'outgoing') }
      return error('NOT_FOUND', 'no such invoice or payment in this wallet')
    }

    // pay_invoice
    const record = [...this.ledger.invoices.values()].find((r) => r.invoice === p.invoice)
    if (!record) return error('PAYMENT_FAILED', 'no route: this invoice was not issued inside the simulation')
    if (record.settled_at) return error('OTHER', 'this invoice has already been paid')
    if (record.expires_at < now()) return error('PAYMENT_FAILED', 'invoice expired')
    if (this.budgetMsat && this.usedMsat + record.amount > this.budgetMsat)
      return error('QUOTA_EXCEEDED', 'this payment is over the connection budget')
    this.usedMsat += record.amount
    record.settled_at = now()
    this.paid.set(record.payment_hash, record)
    return { result: { preimage: record.preimage, fees_paid: 0 } }
  }

  view(r, type) {
    return {
      type,
      state: r.settled_at ? 'settled' : 'pending',
      invoice: r.invoice,
      description: r.description,
      payment_hash: r.payment_hash,
      // The preimage of an unpaid invoice is never given out: that is what makes it proof.
      preimage: r.settled_at ? r.preimage : '',
      amount: r.amount,
      fees_paid: 0,
      created_at: r.created_at,
      expires_at: r.expires_at,
      ...(r.settled_at ? { settled_at: r.settled_at } : {}),
    }
  }
}

/** Fresh keys, wallets and an empty relay for this visit. Nothing is reused or stored. */
export function startHub() {
  const relay = new Relay()
  const ledger = new Ledger()
  const merchantWallet = new WalletService(relay, ledger, 'seller', ['make_invoice', 'lookup_invoice'], 0)
  const customerWallet = new WalletService(relay, ledger, 'buyer', ['pay_invoice', 'lookup_invoice'], 10_000_000)
  const person = (wallet) => {
    const sk = generateSecretKey()
    return { sk: bytesToHex(sk), pk: getPublicKey(sk), nwc: wallet.uri }
  }
  const demo = { relay: RELAY_URL, merchant: person(merchantWallet), customer: person(customerWallet) }
  const walletKeys = new Map([
    [merchantWallet.pk, "seller's wallet"],
    [customerWallet.pk, "buyer's wallet"],
    [merchantWallet.clientPk, "seller's phone"],
    [customerWallet.clientPk, "buyer's phone"],
  ])
  return { relay, demo, walletKeys, connect: (_url, deliver) => relay.connect(deliver) }
}
