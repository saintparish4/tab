/**
 * At-rest storage for the two secrets, as one PIN-encrypted blob.
 *
 *   nostr secret key   identity: can read every past and future message and
 *                      sign as the user. Cannot move money.
 *   NWC connection     spending capability within the wallet's own limits.
 *                      Cannot read or sign messages.
 *
 * PBKDF2-SHA-256 then AES-256-GCM, both from WebCrypto, so there is no extra
 * code to download or audit. The derived key is non-extractable.
 *
 * What this buys: someone who copies localStorage (shared phone, backup,
 * synced profile) gets ciphertext. What it does not buy:
 *  - a short PIN is searchable offline. One guess at 600 000 iterations took
 *    73 ms on one desktop core when measured, so every 6-digit PIN falls in
 *    under a day on that core and far faster on a GPU: a delay, not a wall;
 *  - once unlocked, both secrets are in page memory. Any script running in
 *    this origin can read them; the defence against that is the CSP and
 *    having no third-party script, not this file.
 */
export type Secrets = { sk: string; nwc: string | null; peer: string | null }
export type Blob = { v: 1; salt: string; iv: string; ct: string }

export const ITERATIONS = 600_000

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function seal(secrets: Secrets, pin: string, iterations = ITERATIONS): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(pin, salt, iterations)
  const plain = new TextEncoder().encode(JSON.stringify(secrets))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
}

/** Throws on a wrong PIN or a modified blob: GCM authenticates both. */
export async function open(blob: Blob, pin: string, iterations = ITERATIONS): Promise<Secrets> {
  const key = await deriveKey(pin, unb64(blob.salt), iterations)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource)
  return JSON.parse(new TextDecoder().decode(plain)) as Secrets
}