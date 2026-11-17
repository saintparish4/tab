# Threat model

What Tab protects, from whom, and where it stops. Every "Checked by" entry
names a test or script in this repo. Evidence is from regtest on one machine,
with Alby Hub 1.24.7, LND 0.21.8 and nostr-rs-relay 0.10.0. Nothing here has
been reviewed by anyone but the author.

## What is protected

| Asset                            | Held by                                | If it is lost                                                                 |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Nostr secret key (chat identity) | the device, PIN-encrypted; page memory | every stored message is readable and the thief can sign as the user, for good |
| Wallet connection string         | the device, PIN-encrypted; page memory | spending up to the wallet's budget until the user deletes the connection      |
| Message text                     | both devices; the relay, as ciphertext | orders and prices are exposed                                                 |
| The meaning of "paid"            | derived on each device, never stored   | a seller hands over goods for nothing, or a buyer pays twice                  |

## Who is not trusted

- **The relay.** It can read metadata, and can forge, drop, delay, repeat or
  reorder anything it carries.
- **The other person.** They can lie in any message, including about payment.
- **A network observer**, and **a stranger** who queries the relay.
- **Someone who copies the device's storage** or finds a leaked connection
  string.

Trusted, because nothing in the app can check them: the user's own wallet
service and Lightning node, the browser, and the code as built and served.

## Trust boundaries

Nothing crossing a boundary is believed until the guard has passed.

| #   | Boundary                        | What crosses     | Guard                                                                                                  |
| --- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| B1  | Device storage ↔ page memory    | the vault        | PIN, PBKDF2-SHA-256 (600,000 rounds) and AES-256-GCM (`src/core/vault.ts`)                             |
| B2  | Page ↔ relay                    | every frame      | `parseEvent`: structure, size caps, id and signature, on a rebuilt object (`src/core/event.ts`)        |
| B3  | Me ↔ the other person           | messages         | seal signer must equal the author; message id recomputed; payment binding; preimage check              |
| B4  | Page ↔ wallet service           | wallet responses | signer, `p`, `e` and `result_type` (`src/core/nwc.ts`). The wallet guards the other way: scope, budget |
| B5  | Wallet service ↔ Lightning node | node credentials | not ours. In the demo stack the wallet service holds an LND admin credential                           |

## Threats, handling and what is left

| Threat                                                | At  | Handling                                                          | Checked by                                         | What is left                                                           |
| ----------------------------------------------------- | --- | ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| Forge a message as the other person                   | B3  | seal signature must equal the message author                      | `test/unit/event.test.ts`                          | none known                                                             |
| Reuse another message's id to shadow it               | B3  | id recomputed from the message's own fields                       | `test/unit/event.test.ts`                          | none known                                                             |
| Relay alters a message or its tags                    | B2  | signatures at each layer                                          | `test/unit/event.test.ts`                          | none known                                                             |
| Oversized or malformed events                         | B2  | size caps before hashing; the parser never throws                 | `test/unit/event.test.ts`                          | none known                                                             |
| Forge or replay a wallet response                     | B4  | must be signed by the wallet key and answer the request just sent | `test/unit/nwc.test.ts`, `test/it/wallet.test.ts`  | none known                                                             |
| Downgrade wallet traffic to older encryption (NIP-04) | B4  | NIP-44 only; a wallet without it is refused                       | `test/unit/nwc.test.ts`                            | none known                                                             |
| Present an invoice from another conversation          | B3  | invoice description commits to both chat keys                     | `test/unit/thread.test.ts`                         | a seller can still issue an invoice that pays any node they choose     |
| Claim a payment that did not happen                   | B3  | "paid" needs a preimage that hashes to the invoice                | `test/unit/thread.test.ts`, `test/it/chat.test.ts` | none known                                                             |
| Seller denies receiving a payment                     | B3  | the buyer holds the preimage; anyone can hash it                  | `test/it/wallet.test.ts`                           | proves that invoice was paid, not what was promised for it             |
| Show a timed-out payment as failed, then pay again    | B4  | recorded as unknown; resolved only by the wallet                  | `test/unit/client.test.ts`                         | scripted wallet only: no real node has timed out under this app        |
| Spend from the seller's connection                    | B4  | scope, enforced by the wallet                                     | `test/it/wallet.test.ts`                           | none known                                                             |
| Spend past the buyer's limit                          | B4  | budget, enforced by the wallet                                    | `test/it/wallet.test.ts`                           | one-off payments to a node key (keysend) fall under the same scope     |
| Use a leaked connection string                        | B4  | budget; deleting the connection in the wallet                     | `test/it/wallet.test.ts`                           | **spends up to the budget until it is deleted**                        |
| Replay a payment request to the wallet                | B4  | the wallet remembers request ids                                  | `test/it/wallet.test.ts`                           | **a request held back and delivered late still runs** (read, not seen) |
| Relay reads message content                           | B2  | end-to-end encryption (NIP-44)                                    | `scripts/scan-relay-db.ts`                         | **metadata, below**                                                    |
| Relay serves someone's messages to a stranger         | B2  | relay sign-in (NIP-42) for private messages                       | `test/it/chat.test.ts`                             | depends on the relay's own settings                                    |
| Secrets or message text in logs or storage            | all | the app never logs; the vault is the only stored item             | `scripts/scan-logs.ts`, `e2e/flow.spec.ts`         | wallet logs hold invoices and payment hashes                           |
| Copied device storage                                 | B1  | PIN-encrypted vault                                               | `test/unit/session.test.ts`                        | **a 6-digit PIN falls in under a day on one core**                     |
| A message injects markup or script                    | B1  | text-only rendering; strict Content-Security-Policy               | `e2e/flow.spec.ts`                                 | a compromised build or dependency reads everything in the page         |
| Relay drops, delays or reorders messages              | B2  | thread built from a set, not an order; queue and retry            | `test/unit/thread.test.ts`, `e2e/flow.spec.ts`     | **one relay can censor entirely; there is no fallback**                |
| Flood of messages from strangers                      | B2  | none                                                              | none                                               | **open: no spam control**                                              |

## What each party can see

| Party                         | Sees                                                                                                                                                                   | Does not see                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Relay operator, or its disk   | **the recipient's public key on every message**; which key signed in from which IP and when; sizes and timing; each wallet connection's public keys and what it may do | message text, invoices, amounts, preimages; who sent a message |
| Relay, by timing              | that a chat key and a wallet connection belong together, and that two keys talk to each other                                                                          |                                                                |
| A stranger querying the relay | every wallet's public advert: connection keys and whether each can pay                                                                                                 | anyone else's messages, signed in or not                       |
| Buyer's wallet service        | every invoice paid: amount, payee node, time                                                                                                                           | chat keys, message text, who the seller is in the chat         |
| Seller's wallet service       | every invoice created, its settlement and preimage                                                                                                                     | chat keys, message text, who the buyer is                      |
| The other person              | your chat public key, what you send them, a preimage for what you paid them                                                                                            | your wallet connection, your balance, your other conversations |

## Not promised

- **Anonymity.** The relay sees recipient keys and IP addresses.
- **Forward secrecy.** Anyone who records the relay's ciphertext and later
  gets either chat key reads the whole history. NIP-44 says so itself.
- **Deniability.** Treat every message as attributable.
- **Instant revocation.** Deleting a wallet connection works on its next
  request. A payment already handed to the node is not recalled.
- **Knowing which Lightning node gets paid.** The app does not verify invoice
  signatures. The paying node does.
- **Identity from a wallet.** A wallet connection is a spending permission.
  It proves nothing about who holds it.

## Not tested

- Any wallet other than Alby Hub, any relay other than nostr-rs-relay, and
  anything on mainnet or over more than one Lightning hop.
- A wallet request delivered late by the relay, and deleting a connection
  while a payment is in flight.
- A real phone, and a real slow network for the payment itself.
