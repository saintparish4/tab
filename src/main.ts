/**
 * The page. Three screens (set up, unlock, chat) drawn with plain DOM calls.
 *
 * Rules this file keeps:
 *  - text from the network reaches the screen only through `textContent`,
 *    never as HTML, so a message cannot inject markup or script;
 *  - no framework and no web fonts: the whole app must stay small enough to
 *    load on a slow connection (the build size is checked in e2e);
 *  - secrets exist in two places only: the PIN-encrypted vault in
 *    localStorage, and this page's memory while unlocked;
 *  - the session locks itself after IDLE_LOCK_MS without interaction.
 *
 * `?demo=merchant|customer` pre-fills the set-up form from /demo.json, which
 * only exists on the regtest stack. It is a convenience for the demo, not a
 * login path. Each demo role keeps its own vault, so both roles can run in
 * one browser; without `?demo` there is one vault per origin, as for a user.
 */
import './style.css'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { Client } from './client.ts'
import { isHex64 } from './core/event.ts'
import { parseConn } from './core/nwc.ts'
import type { Network } from './core/pay.ts'
import type { Item } from './core/thread.ts'
import { open, seal, type Secrets } from './core/vault.ts'

const DEMO_PARAM = new URLSearchParams(location.search).get('demo')
const DEMO_ROLE = DEMO_PARAM === 'merchant' || DEMO_PARAM === 'customer' ? DEMO_PARAM : null
const VAULT_KEY = DEMO_ROLE ? `tab.vault.${DEMO_ROLE}` : 'tab.vault'
const IDLE_LOCK_MS = 10 * 60 * 1000
const RELAY = import.meta.env.VITE_RELAY ?? 'ws://localhost:7777'
const NETWORK = (import.meta.env.VITE_NETWORK ?? 'bcrt') as Network

const root = document.getElementById('app')!
let client: Client | null = null
let idle: ReturnType<typeof setTimeout> | null = null

type Attrs = Record<string, string | boolean | ((e: Event) => void)>
function el(tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k, v)
    else if (typeof v === 'boolean') (node as unknown as Record<string, boolean>)[k] = v
    else node.setAttribute(k, v)
  }
  node.append(...kids)
  return node
}
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const show = (...kids: Node[]) => root.replaceChildren(...kids)
const short = (pk: string) => nip19.npubEncode(pk).slice(0, 12) + '…'

function toHexKey(text: string): string {
  const t = text.trim()
  if (isHex64(t)) return t
  const d = nip19.decode(t) as { type: string; data: unknown }
  if (d.type !== 'npub') throw new Error('Enter the other person’s npub.')
  return d.data as string
}

// ---- set up -----------------------------------------------------------------

async function setupScreen(): Promise<void> {
  let sk = bytesToHex(generateSecretKey())
  let nwc = ''
  let peer = ''
  if (DEMO_ROLE) {
    const demo = await fetch('/demo.json').then((r) => r.json())
    sk = demo[DEMO_ROLE].sk
    nwc = demo[DEMO_ROLE].nwc
    peer = nip19.npubEncode(demo[DEMO_ROLE === 'merchant' ? 'customer' : 'merchant'].pk)
  }
  const error = el('p', { class: 'error', role: 'alert' })
  const form = el(
    'form',
    {
      submit: async (e) => {
        e.preventDefault()
        try {
          const pin = field('pin').value
          if (pin.length < 6) throw new Error('Choose a PIN of at least 6 characters.')
          const uri = field('nwc').value.trim()
          if (uri) parseConn(uri) // refuse a bad string now, not at first payment
          const secrets: Secrets = { sk, nwc: uri || null, peer: toHexKey(field('peer').value) }
          localStorage.setItem(VAULT_KEY, JSON.stringify(await seal(secrets, pin)))
          start(secrets)
        } catch (err) {
          error.textContent = (err as Error).message
        }
      },
    },
    el('h1', {}, 'Tab'),
    el('p', {}, 'Chat with one person and settle up in the same thread.'),
    el('label', { for: 'me' }, 'Your address (share it with them)'),
    el('input', { id: 'me', readonly: true, value: nip19.npubEncode(getPublicKey(hexToBytes(sk))) }),
    el('label', { for: 'peer' }, 'Their address (npub)'),
    el('input', { id: 'peer', required: true, autocomplete: 'off', value: peer }),
    el('label', { for: 'nwc' }, 'Wallet connection (optional, nostr+walletconnect://…)'),
    el('input', { id: 'nwc', type: 'password', autocomplete: 'off', value: nwc }),
    el(
      'p',
      { class: 'hint' },
      'Selling: give this app a receive-only connection. Buying: a connection with a small spending limit.',
    ),
    el('label', { for: 'pin' }, 'PIN to lock this device'),
    el('input', { id: 'pin', type: 'password', inputmode: 'numeric', required: true, autocomplete: 'new-password' }),
    el('button', { type: 'submit' }, 'Start'),
    error,
  )
  show(form)
}

// ---- unlock -----------------------------------------------------------------

function unlockScreen(): void {
  const error = el('p', { class: 'error', role: 'alert' })
  show(
    el(
      'form',
      {
        submit: async (e) => {
          e.preventDefault()
          try {
            start(await open(JSON.parse(localStorage.getItem(VAULT_KEY)!), field('pin').value))
          } catch {
            error.textContent = 'Wrong PIN.'
          }
        },
      },
      el('h1', {}, 'Tab'),
      el('label', { for: 'pin' }, 'PIN'),
      el('input', { id: 'pin', type: 'password', inputmode: 'numeric', required: true, autofocus: true }),
      el('button', { type: 'submit' }, 'Unlock'),
      error,
      el('button', { type: 'button', class: 'link', click: erase }, 'Erase this device'),
    ),
  )
}

function erase(): void {
  if (
    !confirm(
      'Erase your key and wallet connection from this device? The wallet connection stays valid until you delete it in your wallet.',
    )
  )
    return
  client?.close()
  client = null
  localStorage.removeItem(VAULT_KEY)
  void setupScreen()
}

function lock(): void {
  client?.close()
  client = null
  if (idle) clearTimeout(idle)
  unlockScreen()
}

function touch(): void {
  if (idle) clearTimeout(idle)
  idle = setTimeout(lock, IDLE_LOCK_MS)
}

// ---- chat -------------------------------------------------------------------

function start(secrets: Secrets): void {
  client = new Client({
    sk: hexToBytes(secrets.sk),
    peer: secrets.peer!,
    relayUrl: RELAY,
    network: NETWORK,
    conn: secrets.nwc ? parseConn(secrets.nwc) : null,
    onChange: draw,
  })
  touch()
  chatScreen(secrets)
}

function chatScreen(secrets: Secrets): void {
  const c = client!
  show(
    el(
      'header',
      {},
      el('strong', {}, short(secrets.peer!)),
      el('span', { id: 'status' }),
      el('button', { class: 'link', click: lock }, 'Lock'),
    ),
    el('p', { id: 'notice', class: 'notice', role: 'status' }),
    el('ol', { id: 'thread' }),
    el(
      'form',
      {
        id: 'composer',
        submit: (e) => {
          e.preventDefault()
          c.send(field('text').value)
          field('text').value = ''
        },
      },
      el('input', { id: 'text', placeholder: 'Message', autocomplete: 'off', 'aria-label': 'Message' }),
      el('button', { type: 'submit' }, 'Send'),
    ),
    el(
      'form',
      {
        id: 'request',
        hidden: true,
        submit: (e) => {
          e.preventDefault()
          void c.requestPayment(Number(field('sats').value), field('note').value.trim())
          field('sats').value = ''
          field('note').value = ''
        },
      },
      el('input', {
        id: 'sats',
        inputmode: 'numeric',
        placeholder: 'Sats',
        required: true,
        'aria-label': 'Amount in sats',
      }),
      el('input', { id: 'note', placeholder: 'For (optional)', maxlength: '60', 'aria-label': 'What it is for' }),
      el('button', { type: 'submit' }, 'Request payment'),
    ),
  )
  root.addEventListener('pointerdown', touch)
  root.addEventListener('keydown', touch)
  draw()
}

const LABEL: Record<string, string> = {
  payable: 'Not paid',
  paid: 'Paid ✓ proof verified',
  awaiting: 'Waiting for payment',
  proof: 'Proof received, checking wallet…',
  settled: 'Paid ✓ confirmed by your wallet',
  expired: 'Expired',
}

function bubble(item: Item): HTMLElement {
  const c = client!
  const li = el('li', { class: item.mine ? 'mine' : 'theirs', 'data-id': item.id })
  // Show the human line only; the invoice itself is in the tags.
  li.append(el('p', {}, item.text.split('\nlightning:')[0]))
  if (item.warn) li.append(el('p', { class: 'warn' }, '⚠ ' + item.warn))
  if (item.pay) {
    const p = item.pay
    const unknown = c.unknown.has(p.paymentHash)
    const busy = c.paying.has(p.paymentHash)
    li.append(
      el(
        'p',
        { class: 'pay ' + p.state, 'data-state': unknown ? 'unknown' : p.state },
        `${p.amountMsat / 1000n} sats · ${unknown ? 'Unknown, checking with wallet…' : LABEL[p.state]}`,
      ),
    )
    if (p.role === 'payer' && p.state === 'payable' && !unknown) {
      li.append(
        el(
          'button',
          { disabled: busy || !c.role.canPay, click: () => void c.pay(item.id) },
          busy ? 'Paying…' : `Pay ${p.amountMsat / 1000n} sats`,
        ),
      )
    }
  }
  if (item.mine && c.isQueued(item.id)) li.append(el('p', { class: 'hint' }, 'Sending…'))
  return li
}

const sats = (msat: number) => Math.floor(msat / 1000).toLocaleString('en-US')

function draw(): void {
  const c = client
  const list = document.getElementById('thread')
  if (!c || !list) return
  const s = c.session
  const wallet =
    !s.unlocked || s.wallet.w === 'none'
      ? 'no wallet'
      : s.wallet.w === 'ready'
        ? c.role.canPay
          ? 'wallet: can pay' +
            (c.budget
              ? ` · ${sats(c.budget.leftMsat)} of ${sats(c.budget.totalMsat)} sats left${c.budget.daily ? ' today' : ''}`
              : '')
          : c.role.canRequest
            ? 'wallet: can request'
            : 'wallet: no useful permission'
        : `wallet ${s.wallet.w}`
  document.getElementById('status')!.textContent =
    `${c.relayStatus === 'open' ? 'online' : c.relayStatus === 'refused' ? 'relay refused login' : 'offline, will retry'} · ${wallet}`
  document.getElementById('notice')!.textContent = c.notice
  ;(document.getElementById('request') as HTMLFormElement).hidden = !c.role.canRequest
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
  list.replaceChildren(...c.thread().map(bubble))
  if (atBottom) list.scrollTop = list.scrollHeight
}

if (localStorage.getItem(VAULT_KEY)) unlockScreen()
else void setupScreen()
