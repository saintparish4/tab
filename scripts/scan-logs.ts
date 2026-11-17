/**
 * Search log files for things that must never be written down: either Nostr
 * secret key, either NWC connection secret, and message plaintext.
 *
 *   docker compose logs --no-color > .stack/all.log
 *   node scripts/scan-logs.ts .stack/all.log [more files...]
 *
 * Exits non-zero on any hit. It also counts lines that mention an invoice or
 * a payment hash. Those are not secrets, but they are what the wallet side
 * can see, so the number is printed for the contract.
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('usage: node scripts/scan-logs.ts <logfile...>')
const demo = JSON.parse(readFileSync(process.env.DEMO ?? './.stack/demo.json', 'utf8'))
const secretOf = (uri: string) => new URL(uri.replace('nostr+walletconnect://', 'http://')).searchParams.get('secret')!
const forbidden: Record<string, string> = {
  [demo.merchant.sk]: 'merchant Nostr secret key',
  [demo.customer.sk]: 'customer Nostr secret key',
  [secretOf(demo.merchant.nwc)]: 'merchant NWC secret',
  [secretOf(demo.customer.nwc)]: 'customer NWC secret',
  chapati: 'message plaintext',
  'Payment request:': 'message plaintext',
}

let hits = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  let invoices = 0
  for (const [i, line] of lines.entries()) {
    if (/lnbcrt1|payment_hash|paymentHash/i.test(line)) invoices++
    for (const [needle, what] of Object.entries(forbidden)) {
      if (line.includes(needle)) {
        hits++
        console.log(`${file}:${i + 1}: ${what}`)
      }
    }
  }
  console.log(`${file}: ${lines.length} lines, ${invoices} mention an invoice or payment hash`)
}
console.log(
  hits
    ? `FAIL: ${hits} forbidden occurrence(s)`
    : 'PASS: no secret key, connection secret or message plaintext in the logs',
)
process.exit(hits ? 1 : 0)
