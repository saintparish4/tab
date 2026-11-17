/**
 * The demo, played by itself: the real page on two phone-sized screens side
 * by side, driven at reading speed, with a caption for each step.
 *
 *   pnpm run demo:watch     opens a window and plays it live
 *   pnpm run demo:record    plays it unseen and saves .stack/walkthrough.webm
 *                           (and .mp4 when ffmpeg is installed)
 *
 * Nothing here is a mockup. Both screens are the built app from the running
 * stack, the messages cross the real relay, and the payment is a real regtest
 * Lightning payment between the two LND nodes. The script only types and taps
 * where a person would, and waits for the same labels a person would read.
 *
 * Every run starts on an empty conversation. The two screens are opened as
 * `localhost` and `127.0.0.1`, which a browser treats as different sites, so
 * each gets its own storage and a newly generated chat key. Only the two
 * wallet connections come from the stack's demo.json. Each run spends 250
 * sats of the buyer's 10,000 sat daily budget; the script stops with a
 * message when too little is left.
 *
 * Needs the stack up, and Playwright's browser:
 *   pnpm exec playwright install chromium     (or set CHROMIUM to a Chrome binary)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const RECORD = process.argv.includes('--record')
const SELLER_URL = process.env.SELLER_URL ?? 'http://localhost:8080/'
const BUYER_URL = process.env.BUYER_URL ?? 'http://127.0.0.1:8080/'
const OUT = process.env.OUT ?? './.stack/walkthrough.webm'
const PIN = '482915'
const PHONE = { width: 390, height: 780 }
const SIZE = { width: PHONE.width * 2 + 60, height: PHONE.height + 190 }
/** Reading time per caption. SPEED=2 halves every pause. */
const SPEED = Number(process.env.SPEED ?? 1)

const SHELL = `<!doctype html>
<meta charset="utf-8" />
<title>Tab walkthrough</title>
<style>
  body { margin: 0; background: #14171a; color: #fff; font: 16px/1.4 system-ui, sans-serif; }
  #caption { height: 110px; padding: 14px 24px 0; box-sizing: border-box; }
  #step { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: #5fd39b; margin: 0 0 4px; }
  #text { font-size: 21px; margin: 0; }
  #phones { display: flex; gap: 20px; justify-content: center; }
  figure { margin: 0; }
  figcaption { text-align: center; font-size: 14px; color: #c9d1d9; padding: 6px 0; }
  iframe { width: ${PHONE.width}px; height: ${PHONE.height}px; border: 0; border-radius: 18px; background: #fff; display: block; }
  #foot { text-align: center; font-size: 12px; color: #9aa4ae; padding: 8px 0; }
</style>
<div id="caption"><p id="step"></p><p id="text"></p></div>
<div id="phones">
  <figure><figcaption>Seller's phone</figcaption><iframe id="seller" title="Seller" src="${SELLER_URL}"></iframe></figure>
  <figure><figcaption>Buyer's phone</figcaption><iframe id="buyer" title="Buyer" src="${BUYER_URL}"></iframe></figure>
</div>
<div id="foot">The real app on a regtest Lightning network. Play money. Nothing here is a mockup.</div>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED))

async function main() {
  const demo = await fetch(new URL('demo.json', SELLER_URL)).then(
    (r) => (r.ok ? r.json() : Promise.reject(new Error('no demo.json'))),
    () => Promise.reject(new Error('page not reachable')),
  )
  const videoDir = RECORD ? mkdtempSync(join(tmpdir(), 'tab-walkthrough-')) : null
  const browser = await chromium.launch({
    headless: RECORD,
    executablePath: process.env.CHROMIUM || undefined,
    args: [
      // A localhost page may not embed 127.0.0.1 unless this check is off. It
      // is switched off for this throwaway browser only.
      '--disable-features=LocalNetworkAccessChecks',
      ...(RECORD ? [] : [`--window-size=${SIZE.width + 16},${SIZE.height + 90}`]),
    ],
  })
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: 'light',
    ...(videoDir ? { recordVideo: { dir: videoDir, size: SIZE } } : {}),
  })
  const page = await context.newPage()
  // Served from the app's own address so the page counts as a secure context,
  // which the app needs for WebCrypto inside the two frames.
  const shellUrl = new URL('__walkthrough', SELLER_URL).toString()
  await page.route(shellUrl, (route) => route.fulfill({ contentType: 'text/html', body: SHELL }))
  await page.goto(shellUrl)

  const seller = page.frameLocator('#seller')
  const buyer = page.frameLocator('#buyer')
  let n = 0
  const say = async (text, readMs = 3500) => {
    n += 1
    console.log(`${n}. ${text}`)
    await page.evaluate(
      ([step, t]) => {
        document.getElementById('step').textContent = step
        document.getElementById('text').textContent = t
      },
      [`Step ${n}`, text],
    )
    await sleep(readMs)
  }
  const type = (frame, selector, text) => frame.locator(selector).pressSequentially(text, { delay: 55 / SPEED })
  const shows = (frame, selector, text, timeout = 30_000) =>
    frame.locator(selector).filter({ hasText: text }).first().waitFor({ timeout })

  // ---- set up ---------------------------------------------------------------
  await seller.locator('#pin').waitFor()
  await buyer.locator('#pin').waitFor()
  await say('Two phones. Each makes its own chat key on the device. There is no account and no server of ours.')
  const sellerAddress = await seller.locator('#me').inputValue()
  const buyerAddress = await buyer.locator('#me').inputValue()
  await seller.locator('#peer').fill(buyerAddress)
  await buyer.locator('#peer').fill(sellerAddress)
  await say('Each person pastes the other’s address.', 2500)
  await seller.locator('#nwc').fill(demo.merchant.nwc)
  await buyer.locator('#nwc').fill(demo.customer.nwc)
  await say(
    'Each connects their own Lightning wallet. The seller’s link can only receive. The buyer’s can spend up to a limit set in the wallet.',
    5000,
  )
  await type(seller, '#pin', PIN)
  await type(buyer, '#pin', PIN)
  await say('A PIN encrypts the key and the wallet link on the device.', 2500)
  await seller.locator('button[type=submit]').click()
  await buyer.locator('button[type=submit]').click()

  await shows(seller, '#status', 'wallet: can request', 60_000)
  await shows(buyer, '#status', 'sats left', 60_000)
  const status = (await buyer.locator('#status').textContent()) ?? ''
  const found = status.match(/· ([\d,]+) of/)
  if (!found) throw new Error(`could not read the buyer's budget from the status line: "${status}"`)
  const left = Number(found[1].replace(/,/g, ''))
  if (left < 300) {
    await say(`The buyer's wallet has ${left} sats of budget left today, too little for this demo.`, 4000)
    throw new Error(
      `buyer budget too low (${left} sats left). Issue a new connection: docker compose run --rm init && docker compose restart web`,
    )
  }
  await say(
    'Each wallet has answered and said what its link may do. Seller: can request. Buyer: can pay, with the budget the wallet reports.',
    5500,
  )

  // ---- order ----------------------------------------------------------------
  await type(buyer, '#text', 'two chapati and tea please')
  await buyer.locator('#composer button').click()
  await shows(seller, '#thread li.theirs', 'two chapati and tea please')
  await say(
    'The buyer orders by message. It is encrypted to the seller’s key; the relay in between stores ciphertext.',
    4500,
  )

  // ---- request --------------------------------------------------------------
  await type(seller, '#sats', '250')
  await type(seller, '#note', 'chapati and tea')
  await seller.locator('#request button').click()
  await shows(buyer, '#thread li.theirs', '250 sats · Not paid')
  await say(
    'The seller asks for 250 sats. The seller’s wallet made a Lightning invoice tied to this one conversation.',
    4500,
  )

  // ---- pay ------------------------------------------------------------------
  await buyer.getByRole('button', { name: 'Pay 250 sats' }).click()
  await shows(buyer, '#thread', 'Paid ✓ proof verified')
  await shows(seller, '#thread', 'Paid ✓ confirmed by your wallet')
  await say(
    'One tap to pay. The buyer’s phone checked the wallet’s proof of payment. The seller’s phone asked the seller’s own wallet. Neither took the other’s word.',
    6500,
  )

  // ---- a claim is not a payment --------------------------------------------
  await type(seller, '#sats', '300')
  await type(seller, '#note', 'second order')
  await seller.locator('#request button').click()
  await shows(buyer, '#thread li.theirs', '300 sats · Not paid')
  await type(buyer, '#text', 'I already paid for that one')
  await buyer.locator('#composer button').click()
  await shows(seller, '#thread li.theirs', 'I already paid for that one')
  await shows(seller, '#thread', '300 sats · Waiting for payment')
  await say(
    'The buyer says a second order is paid. The seller’s screen still says "Waiting for payment". A message is not a payment.',
    5500,
  )

  // ---- the wallet enforces the limit ---------------------------------------
  await type(seller, '#sats', '20000')
  await type(seller, '#note', 'catering')
  await seller.locator('#request button').click()
  await shows(buyer, '#thread li.theirs', '20000 sats · Not paid')
  await buyer.getByRole('button', { name: 'Pay 20000 sats' }).click()
  await shows(buyer, '#notice', 'spending limit')
  await say(
    'A request above the buyer’s limit: the buyer’s own wallet refuses it, and it stays "Not paid". The limit is the wallet’s, not this app’s.',
    6000,
  )

  await say('That was the real app on a regtest Lightning network: real messages, real invoices, play money.', 4000)

  if (!RECORD) {
    // Leave the two phones on screen, and usable, until the window is closed.
    await say('Both phones are live: try them yourself. Close this window when you are done.', 0)
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {})
  }
  const video = page.video()
  await context.close() // the recording is complete only once the context has closed
  const made = video ? await video.path() : null
  await browser.close()
  if (videoDir && made) {
    mkdirSync(join(OUT, '..'), { recursive: true })
    rmSync(OUT, { force: true })
    renameSync(made, OUT)
    rmSync(videoDir, { recursive: true, force: true })
    console.log('saved', OUT)
    const mp4 = OUT.replace(/\.webm$/, '.mp4')
    const ff = spawnSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      OUT,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      mp4,
    ])
    console.log(ff.status === 0 ? `saved ${mp4}` : 'ffmpeg not available: kept the .webm only')
  }
}

main().catch((e) => {
  const hint =
    e.message === 'page not reachable' || e.message === 'no demo.json'
      ? `\nIs the stack up? Start it with: mkdir -p .stack && docker compose up --build -d`
      : /Executable doesn't exist/.test(e.message)
        ? '\nInstall the browser once: pnpm exec playwright install chromium'
        : ''
  console.error('walkthrough stopped: ' + e.message.split('\n')[0] + hint)
  process.exit(1)
})
