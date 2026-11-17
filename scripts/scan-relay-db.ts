/**
 * Read the relay's own SQLite file and report what an operator, or anyone who
 * takes the disk, can learn. This looks at storage directly instead of asking
 * the relay, so it does not depend on the relay's access rules.
 *
 *   node scripts/scan-relay-db.ts <path/to/nostr.db> [plaintext words...]
 *
 * Exits non-zero if any stored event contains a plaintext word, a demo
 * secret, or a gift wrap / seal authored by a real participant key.
 * It PRINTS, without failing, where participant keys do appear: that is
 * expected (recipient p tags, relay lists) and belongs in the contract.
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const [dbPath, ...extraWords] = process.argv.slice(2)
if (!dbPath) throw new Error('usage: node scripts/scan-relay-db.ts <nostr.db> [words...]')
const demo = JSON.parse(readFileSync(process.env.DEMO ?? './.stack/demo.json', 'utf8'))
const secretOf = (uri: string) => new URL(uri.replace('nostr+walletconnect://', 'http://')).searchParams.get('secret')!
const secrets = [demo.merchant.sk, demo.customer.sk, secretOf(demo.merchant.nwc), secretOf(demo.customer.nwc)]
const words = ['chapati', 'Payment request', 'Proof of payment', 'lnbcrt', 'tab1', ...extraWords]
const people: Record<string, string> = { [demo.merchant.pk]: 'merchant', [demo.customer.pk]: 'customer' }

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare('SELECT content FROM event').all() as { content: string }[]
const byKind = new Map<number, number>()
const sightings = new Map<string, number>()
const failures: string[] = []

for (const { content } of rows) {
  const ev = JSON.parse(content)
  byKind.set(ev.kind, (byKind.get(ev.kind) ?? 0) + 1)
  for (const w of words)
    if (content.includes(w)) failures.push(`kind ${ev.kind} ${ev.id.slice(0, 8)} contains plaintext "${w}"`)
  for (const s of secrets)
    if (content.includes(s)) failures.push(`kind ${ev.kind} ${ev.id.slice(0, 8)} contains a secret`)
  for (const [pk, who] of Object.entries(people)) {
    if (ev.pubkey === pk) {
      sightings.set(
        `${who} is AUTHOR of kind ${ev.kind}`,
        (sightings.get(`${who} is AUTHOR of kind ${ev.kind}`) ?? 0) + 1,
      )
      if (ev.kind === 1059 || ev.kind === 13)
        failures.push(`kind ${ev.kind} ${ev.id.slice(0, 8)} is authored by ${who}`)
    }
    if (ev.tags.some((t: string[]) => t.includes(pk))) {
      sightings.set(
        `${who} is TAGGED in kind ${ev.kind}`,
        (sightings.get(`${who} is TAGGED in kind ${ev.kind}`) ?? 0) + 1,
      )
    }
  }
}

console.log(`events stored: ${rows.length}`)
for (const [kind, n] of [...byKind].sort((a, b) => a[0] - b[0])) console.log(`  kind ${kind}: ${n}`)
console.log('participant keys visible in storage:')
for (const [what, n] of [...sightings].sort()) console.log(`  ${what}: ${n}`)
if (sightings.size === 0) console.log('  none')
console.log(
  failures.length
    ? 'FAIL\n  ' + failures.join('\n  ')
    : 'PASS: no plaintext, no secrets, no participant-authored wraps or seals',
)
process.exit(failures.length ? 1 : 0)
