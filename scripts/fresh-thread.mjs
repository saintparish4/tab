/**
 * Start the demo on an empty conversation without rebuilding the stack.
 *
 * Every test run and rehearsal adds messages to the same two demo keys, and
 * the relay keeps them, so the demo would open on a thread full of old
 * requests. This replaces only the two throwaway Nostr keys in demo.json. The
 * wallet connections, the channel and the buyer's budget are left as they
 * are, so nothing has to be re-initialised. The old messages stay on the
 * relay, encrypted to keys nobody holds any more.
 *
 * After running it, each browser window still has the old key in its vault:
 * choose "Erase this device" on the unlock screen, then set up again.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'

const FILE = process.env.DEMO ?? './.stack/demo.json'
const demo = JSON.parse(readFileSync(FILE, 'utf8'))
for (const role of ['merchant', 'customer']) {
  const sk = generateSecretKey()
  demo[role] = { ...demo[role], sk: bytesToHex(sk), pk: getPublicKey(sk) }
}
// Delete before writing, as init.mjs does: Docker may have written the file as root.
rmSync(FILE, { force: true })
writeFileSync(FILE, JSON.stringify(demo, null, 2))
console.log('new demo keys written to', FILE)

if (existsSync('./dist')) {
  copyFileSync(FILE, './dist/demo.json')
  console.log('copied to dist/demo.json (the page served by `pnpm run preview`)')
}
console.log('Docker route: docker compose exec web cp /shared/demo.json dist/demo.json')
console.log('Then, in each browser window: Lock, "Erase this device", and set up again.')
