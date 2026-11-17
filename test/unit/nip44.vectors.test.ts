/**
 * Runs the upstream NIP-44 v2 vectors (pinned and checksummed by
 * scripts/fetch-fixtures.sh) against the NIP-44 code this app actually ships:
 * nostr-tools 2.26.0.
 *
 * Establishes: the library derives the same keys, produces byte-identical
 * ciphertext for a fixed nonce, and rejects the tampered payloads the vector
 * authors thought of. Does not establish: anything about how we use it.
 *
 * Two parts of the vector file cannot be run as written, and are reported
 * rather than skipped silently:
 *  - `get_message_keys` targets an internal function nostr-tools does not
 *    export. It is exercised indirectly: `encrypt_decrypt` can only match if
 *    the message keys are right.
 *  - `invalid.encrypt_msg_lengths` lists 65536 and above as too long. NIP-44
 *    has since gained an extended length prefix (up to 2^32-1), which
 *    nostr-tools implements, so only length 0 is still invalid.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { v2 } from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'

const vectors = JSON.parse(readFileSync(new URL('../fixtures/nip44.vectors.json', import.meta.url), 'utf8')).v2

// The vectors give both secret keys; derive the second public key locally.
function pub(secHex: string): Uint8Array {
  return hexToBytes(getPublicKey(hexToBytes(secHex)))
}

describe('NIP-44 v2 upstream vectors', () => {
  test('get_conversation_key: all valid cases', () => {
    for (const v of vectors.valid.get_conversation_key) {
      expect(bytesToHex(v2.utils.getConversationKey(hexToBytes(v.sec1), v.pub2))).toBe(v.conversation_key)
    }
    expect(vectors.valid.get_conversation_key.length).toBe(35)
  })

  test('get_conversation_key: all invalid keys are refused', () => {
    for (const v of vectors.invalid.get_conversation_key) {
      expect(() => v2.utils.getConversationKey(hexToBytes(v.sec1), v.pub2), v.note).toThrow()
    }
  })

  test('calc_padded_len: all cases', () => {
    for (const [len, padded] of vectors.valid.calc_padded_len) {
      expect(v2.utils.calcPaddedLen(len)).toBe(padded)
    }
  })

  test('encrypt_decrypt: ciphertext is byte-identical for the given nonce, and decrypts', () => {
    for (const v of vectors.valid.encrypt_decrypt) {
      const key = hexToBytes(v.conversation_key)
      expect(bytesToHex(v2.utils.getConversationKey(hexToBytes(v.sec1), bytesToHex(pub(v.sec2))))).toBe(
        v.conversation_key,
      )
      expect(v2.encrypt(v.plaintext, key, hexToBytes(v.nonce))).toBe(v.payload)
      expect(v2.decrypt(v.payload, key)).toBe(v.plaintext)
    }
  })

  test('encrypt_decrypt_long_msg: checksums match', () => {
    for (const v of vectors.valid.encrypt_decrypt_long_msg) {
      const key = hexToBytes(v.conversation_key)
      const plaintext = v.pattern.repeat(v.repeat)
      expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(v.plaintext_sha256)
      const payload = v2.encrypt(plaintext, key, hexToBytes(v.nonce))
      expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(v.payload_sha256)
      expect(v2.decrypt(payload, key)).toBe(plaintext)
    }
  })

  test('invalid decrypt: every tampered payload is refused', () => {
    for (const v of vectors.invalid.decrypt) {
      expect(() => v2.decrypt(v.payload, hexToBytes(v.conversation_key)), v.note).toThrow()
    }
    expect(vectors.invalid.decrypt.length).toBe(12)
  })

  test('message length: empty is refused; 65536 is now legal (extended prefix)', () => {
    const key = hexToBytes(vectors.valid.encrypt_decrypt[0].conversation_key)
    expect(() => v2.encrypt('', key)).toThrow()
    expect(v2.decrypt(v2.encrypt('a'.repeat(65536), key), key)).toHaveLength(65536)
  })
})
