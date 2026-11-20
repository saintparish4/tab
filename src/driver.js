/**
 * The demo page: starts the simulated relay and wallets, loads the Tab build
 * into two phone frames, lists what the relay sees, and can play one order
 * from start to finish by typing and tapping where a person would.
 */
import { startHub } from './hub.js'

const hub = startHub()
// The phone frames look for this (see app/sim-socket.js).
window.__tabSim = { demo: hub.demo, connect: hub.connect }

const $ = (id) => document.getElementById(id)
const frames = { seller: $('seller'), buyer: $('buyer') }
const PIN = '482915'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every visit starts from the set-up screen, with the keys made above.
for (const role of ['merchant', 'customer']) {
  try {
    localStorage.removeItem('tab.vault.' + role)
  } catch {
    // storage blocked: the app will say so itself
  }
}
frames.seller.src = './app/?demo=merchant'
frames.buyer.src = './app/?demo=customer'

// ---- which phone is on screen (narrow screens show one at a time) -----------

function show(which) {
  $('phones').dataset.show = which
  $('tab-seller').setAttribute('aria-selected', String(which === 'seller'))
  $('tab-buyer').setAttribute('aria-selected', String(which === 'buyer'))
}
$('tab-seller').addEventListener('click', () => show('seller'))
$('tab-buyer').addEventListener('click', () => show('buyer'))

// ---- what the relay sees ----------------------------------------------------

const people = new Map([
  [hub.demo.merchant.pk, "seller's phone"],
  [hub.demo.customer.pk, "buyer's phone"],
  ...hub.walletKeys,
])
const KIND = {
  1059: 'Private message (gift wrap)',
  10050: 'Where to deliver messages',
  13194: 'Wallet: what a link may do',
  23194: 'Request to a wallet',
  23195: 'Answer from a wallet',
}
let seen = 0
hub.relay.onAccept = (ev) => {
  seen += 1
  const to = ev.tags.find((t) => t[0] === 'p')?.[1]
  const row = document.createElement('tr')
  const cell = (text) => {
    const td = document.createElement('td')
    td.textContent = text
    row.append(td)
  }
  cell(KIND[ev.kind] ?? 'Kind ' + ev.kind)
  cell(to ? (people.get(to) ?? to.slice(0, 8) + '…') : 'everyone')
  cell(ev.content ? ev.content.slice(0, 44) + (ev.content.length > 44 ? '…' : '') : '(empty)')
  $('relay-log').prepend(row)
  while ($('relay-log').children.length > 60) $('relay-log').lastChild.remove()
  $('relay-count').textContent = `${seen} event${seen === 1 ? '' : 's'} so far.`
}

// ---- play -------------------------------------------------------------------

const doc = (who) => frames[who].contentDocument
const q = (who, selector) => doc(who)?.querySelector(selector) ?? null

async function until(test, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const found = test()
    if (found) return found
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what)
    await sleep(100)
  }
}
const shows = (who, selector, text) =>
  until(
    () => [...(doc(who)?.querySelectorAll(selector) ?? [])].find((n) => n.textContent.includes(text)),
    `"${text}" on the ${who}'s phone`,
  )

async function type(who, selector, text) {
  show(who)
  const input = await until(() => q(who, selector), selector)
  input.focus({ preventScroll: true })
  for (const ch of text) {
    input.value += ch
    await sleep(45)
  }
}

async function tap(who, find) {
  show(who)
  const button = await until(() => {
    const b = typeof find === 'string' ? q(who, find) : find()
    return b && !b.disabled ? b : null
  }, 'a button')
  button.style.outline = '3px solid #f5a623'
  button.style.outlineOffset = '2px'
  await sleep(450)
  button.style.outline = ''
  button.click()
}
const buttonNamed = (who, name) => () =>
  [...(doc(who)?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === name)

let n = 0
async function say(text, readMs = 3800) {
  n += 1
  $('step').textContent = `Step ${n} of 9`
  $('text').textContent = text
  await sleep(readMs)
}

async function play() {
  $('play').disabled = true
  $('play').textContent = 'Playing…'
  n = 0
  await until(() => q('seller', '#pin') && q('buyer', '#pin'), 'both phones to load')

  await say(
    'Two phones. Each has its own chat key and the other person’s address. There is no account, and no server of ours.',
  )
  await type('seller', '#pin', PIN)
  await type('buyer', '#pin', PIN)
  await say('Each chooses a PIN. It encrypts the chat key and the wallet link on the device.', 2600)
  await tap('seller', 'button[type=submit]')
  await tap('buyer', 'button[type=submit]')
  await shows('seller', '#status', 'wallet: can request')
  await shows('buyer', '#status', 'sats left')
  await say(
    'Each wallet has answered and said what its link may do. Seller: can only request. Buyer: can pay, up to 10,000 sats a day.',
    5200,
  )

  await type('buyer', '#text', 'two chapati and tea please')
  await tap('buyer', '#composer button')
  await sleep(700)
  show('seller')
  await shows('seller', '#thread li.theirs', 'two chapati and tea please')
  await say('The buyer orders by message. It is encrypted to the seller’s key; the relay in between stores ciphertext.', 4200)

  await type('seller', '#sats', '250')
  await type('seller', '#note', 'chapati and tea')
  await tap('seller', '#request button')
  await sleep(900)
  show('buyer')
  await shows('buyer', '#thread li.theirs', '250 sats · Not paid')
  await say('The seller asks for 250 sats. The seller’s wallet made an invoice tied to this one conversation.', 4200)

  await tap('buyer', buttonNamed('buyer', 'Pay 250 sats'))
  await shows('buyer', '#thread', 'Paid ✓ proof verified')
  await sleep(1500)
  show('seller')
  await shows('seller', '#thread', 'Paid ✓ confirmed by your wallet')
  await say(
    'One tap to pay. The buyer’s phone checked the wallet’s proof of payment. The seller’s phone asked the seller’s own wallet. Neither took the other’s word.',
    6200,
  )

  await type('seller', '#sats', '300')
  await type('seller', '#note', 'second order')
  await tap('seller', '#request button')
  await shows('buyer', '#thread li.theirs', '300 sats · Not paid')
  await type('buyer', '#text', 'I already paid for that one')
  await tap('buyer', '#composer button')
  await sleep(700)
  show('seller')
  await shows('seller', '#thread li.theirs', 'I already paid for that one')
  await shows('seller', '#thread', '300 sats · Waiting for payment')
  await say(
    'The buyer says a second order is paid. The seller’s screen still says “Waiting for payment”. A message is not a payment.',
    5400,
  )

  await type('seller', '#sats', '20000')
  await type('seller', '#note', 'catering')
  await tap('seller', '#request button')
  await sleep(900)
  show('buyer')
  await shows('buyer', '#thread li.theirs', '20000 sats · Not paid')
  await tap('buyer', buttonNamed('buyer', 'Pay 20000 sats'))
  await shows('buyer', '#notice', 'spending limit')
  await say(
    'A request above the buyer’s limit: the buyer’s wallet refuses it, and it stays “Not paid”. The limit is the wallet’s, not the app’s.',
    5600,
  )

  n = 8
  await say('That is the whole flow. Both phones are still live: send a message or make a request yourself.', 0)
}

function finish(label) {
  $('play').disabled = false
  $('play').textContent = label
}

async function run() {
  try {
    await play()
    finish('Play again')
  } catch (e) {
    $('step').textContent = 'Stopped'
    $('text').textContent = `${e.message}. Press “Start over” to try again.`
    finish('Play the demo')
  }
}

// Play always begins from two untouched phones, so a second run reloads first.
let fresh = true
for (const who of ['seller', 'buyer']) frames[who].addEventListener('load', () => {
  doc(who)?.addEventListener('pointerdown', () => (fresh = false), { once: true })
})
$('play').addEventListener('click', () => {
  if (fresh) {
    fresh = false
    return void run()
  }
  location.hash = 'play'
  location.reload()
})
$('reset').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname)
  location.reload()
})
if (location.hash === '#play') {
  history.replaceState(null, '', location.pathname)
  fresh = false
  void run()
}
