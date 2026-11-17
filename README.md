# Tab

**Chat with one person and settle up in the same thread. A seller sends a
Lightning payment request as a message, the buyer pays it from the chat, and
each phone shows "paid" only when it has checked the proof itself.**

It does not make anyone anonymous, and connecting a wallet does not prove who
you are. It makes a payment checkable by both sides without trusting either.

Built for the [Dakar Bitcoin Hack by BTrust](https://dakar-bitcoin-hack-2026.devpost.com/)
(online, organised by Dakar Bitcoin Days, November 2026), whose brief is to create tools
that improve the lives of African people, built on Bitcoin, Lightning, Nostr and AI.
Regtest only. Not audited. Do not connect a wallet that holds real funds.

---

## The problem

A small seller who takes orders by text message gets paid somewhere else. The
order is in one app, the payment in another, and the proof is a screenshot:

- the seller cannot verify a screenshot;
- the buyer can pay a stale or wrong invoice;
- the chat provider reads every order.

**Who it is for:** a seller who already takes orders by message and accepts
Lightning, such as a food stall, a kiosk or a tailor, in Dakar and across Africa.

**One daily workflow:** an order arrives as a message, the seller states a
price, the buyer pays, the seller confirms and hands over the goods.

**Reach: at most 5 merchants in Dakar today, and none served yet.** We have
not tested this with a seller, so merchants served per week is zero. What we
can count is who could use Tab today:

- [BTC Map](https://btcmap.org/) lists **5 merchants** inside its Dakar area
  on 2026-11-17: two restaurants, a bar, a gaming shop and a surf camp.
- **3 of the 5** are tagged as accepting Lightning; the other two only say
  they accept bitcoin.
- All five were last verified in 2022 or 2023, so some may have stopped.

That is an upper bound on today's users, not a forecast. Tab only becomes
useful to more sellers as more of them accept Lightning. Anyone can repeat the
count:

```bash
curl -s 'https://api.btcmap.org/v4/places/search?lat=14.72&lon=-17.35&radius_km=60'
# then keep the places inside the polygon from https://api.btcmap.org/v2/areas/dakar
```

What is still to do before we claim more:

1. Ask those merchants how orders arrive now. If most say "in person", this
   workflow is not theirs, and we will say so.
2. Run one scripted session with a seller ([`docs/user-test.md`](docs/user-test.md)):
   completion, time per task, and where they got stuck.

## How it works

| Step             | Today                             | With Tab                                                                                |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| Ask for payment  | paste an invoice from another app | one field in the thread; the seller's wallet makes an invoice tied to this conversation |
| Pay              | copy it into a wallet app         | one tap; the buyer's wallet enforces its own spending limit                             |
| Confirm          | screenshot, or search the wallet  | the seller's phone asks the seller's own wallet                                         |
| "I already paid" | an argument                       | changes nothing on screen                                                               |

Built on open protocols, with no server of our own:

- **Messages:** Nostr private messages ([NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)),
  end-to-end encrypted with [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md).
- **Wallet:** [Nostr Wallet Connect](https://github.com/nostr-protocol/nips/blob/master/47.md)
  (NIP-47), so the app talks to the user's own Lightning wallet over Nostr.
- **Payments:** Lightning invoices ([BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)).

## Authentication with NWC: what it proves

There is no account to log in to. "Signed in" is two local facts:

1. **Unlocked:** this device decrypted its key with your PIN. That Nostr key is
   your identity in the chat.
2. **Wallet ready:** within the last 10 minutes, your wallet answered a signed,
   encrypted request from this session and listed what this connection may do.

This is the hackathon's "authentication method using NWC", done in a way
we can defend. The second fact proves the app can use that wallet within the
limits you set.
It does not prove who you are, that the wallet has money, or anything at all
to the other person. A wallet connection is a spending permission, not an
identity, so Tab uses it for permissions only.

What the other person _can_ check is each payment:

- **Bound to the conversation.** The invoice's description is a hash of both
  chat keys and a random reference. An invoice issued for one conversation is
  refused in another.
- **Paid means proven.** The buyer's phone checks that the wallet's preimage
  hashes to the invoice's payment hash. The seller's phone asks the seller's
  own wallet whether the invoice settled. A message saying "paid" does neither.

## Goals

The hackathon's five judging criteria, and how Tab meets each.

| Criterion                     | What we aim for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Usefulness & local impact** | One primary user (a seller who takes orders by message), one daily workflow (order, request, pay, confirm), and a reach bound built on a public count (5 merchants in Dakar on BTC Map), not a guess                                                                                                                                                                                                                                                                                                |
| **Security by design**        | Threat model and trust boundaries written down in [`docs/threat-model.md`](docs/threat-model.md). Least privilege: the seller's wallet connection cannot spend, and the buyer's has a budget, both enforced by the wallet. Secrets PIN-encrypted on the device and never sent to a server. Every relay event validated before use. No logging at all in the app. Proven libraries for the cryptography (`nostr-tools`, `@noble`); our own code only where a library helper was unsafe for this use. |
| **UX/UI quality**             | One small page with no framework, web fonts or images, so it loads on a slow link and a mid-range phone. Large touch targets (48 px), 16 px text, and text contrast above the WCAG minimum in light and dark mode. Plain labels ("Paid ✓ confirmed by your wallet", "Waiting for payment"), and a timed-out payment shown as "unknown", never as "failed".                                                                                                                                          |
| **Working MVP**               | One command (`docker compose up`, or `infra/native.sh up` without Docker). Seed data: a funded regtest channel and two ready-made wallet connections. A happy path anyone can run, and tests against the real wallet and Lightning nodes, not mockups.                                                                                                                                                                                                                                              |
| **Clear pitch & docs**        | A 3-minute demo (problem, solution, impact, next steps), and this README: setup, architecture diagram, constraints, metrics and the next iteration.                                                                                                                                                                                                                                                                                                                                                 |

The submission asks for a brief presentation, a prototype, and at least one
Bitcoin or Lightning wallet implementation. Ours is Nostr Wallet Connect,
tested against [Alby Hub](https://github.com/getAlby/hub) on two LND nodes.
Two of the hackathon's own example ideas are combined here: a messaging app
built on Nostr, and an authentication method using NWC.

## Scope

In scope: one kind of user, one workflow, one 1:1 conversation, one relay, one
wallet connection per person.

Out of scope: group chat, multiple wallets, media, zaps, contact discovery.

## Status

| Part                                                                                          | State                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Regtest stack: bitcoind, two LND nodes with a channel, relay, two Alby Hubs                   | working, with `docker compose` or `infra/native.sh` |
| Bootstrap: funding, channel, two scoped wallet connections                                    | working                                             |
| Protocol logic: event checks, gift wrap, NWC, invoices, payment binding, thread, login, vault | working, with unit and property tests               |
| The app: chat, payment request, pay, "paid" verified on both sides                            | working on regtest, tested against the real stack   |
| Tests of the wallet refusing out-of-scope and over-budget requests                            | passing against Alby Hub and LND on regtest         |
| Browser tests on a throttled phone profile                                                    | passing: the full flow on two emulated phones       |
| Test with a real seller                                                                       | not yet done                                        |

## Run it

Needs Linux x86_64 (or WSL 2), Node 24 and pnpm 12.

```bash
git clone <this repo> tab && cd tab
pnpm install
```

**With Docker:** starts the stack, runs the bootstrap, then serves the app on
<http://localhost:8080>.

```bash
mkdir -p .stack && docker compose up --build -d
# stop: docker compose down     wipe all regtest state: docker compose down -v
```

**Without Docker:** this downloads about 190 MB of pinned releases, checks
each against a SHA-256, and builds the relay from source (about 5 minutes,
first run only). Every step prints as it runs.

```bash
infra/native.sh up       # stop with: infra/native.sh down
pnpm run build && cp .stack/demo.json dist/demo.json && pnpm run preview
```

Either route ends by writing `.stack/demo.json`: two throwaway Nostr keys and
two wallet connection strings, for regtest only. That file is in `.gitignore`.
Stop the stack before shutting the machine down: a regtest chain that is not
stopped cleanly can be lost while the Lightning nodes remember it.

### Try it

Open two windows, one per person:

- seller: <http://localhost:8080/?demo=merchant>
- buyer: <http://localhost:8080/?demo=customer>

`?demo=` fills in the throwaway keys and wallet connections from
`.stack/demo.json`. In each window, choose a PIN of six or more characters and
press Start. The seller's status line reads `online · wallet: can request`, the
buyer's `online · wallet: can pay · 10,000 of 10,000 sats left today`. That
number is what the wallet reports for this connection. It is shown for
information only: the Pay button never depends on it, and the wallet decides
each payment.

Every run adds to the same conversation, and the relay keeps it. To start
again from an empty thread without rebuilding the stack, run
`pnpm run demo:fresh` (it replaces the two throwaway chat keys and keeps the
wallet connections), then choose "Erase this device" in each window.

1. Send a message from either side.
2. Seller: `250` in **Sats**, `chapati` in **For**, then **Request payment**.
3. Buyer: **Pay 250 sats**. The buyer's line becomes `Paid ✓ proof verified`,
   the seller's `Paid ✓ confirmed by your wallet`.
4. Seller: request `20000`. The buyer taps Pay and sees
   `Over this connection's spending limit.`: the buyer's wallet refused it, and
   the request stays `Not paid`.

### Watch it play by itself

The same flow, driven on two phone-sized screens side by side with a caption
for each step. It uses the real page and the running stack, and each run
starts a new conversation with newly generated chat keys.

```bash
pnpm exec playwright install chromium   # once: the browser it drives
pnpm run demo:watch                     # opens a window and plays it; the phones stay usable afterwards
pnpm run demo:record                    # no window: saves .stack/walkthrough.webm (and .mp4 with ffmpeg)
```

It takes about a minute and pays 250 regtest sats from the buyer's budget.
`demo:watch` needs a desktop to open a window on.

### Run the tests

```bash
scripts/fetch-fixtures.sh   # once: upstream test vectors at pinned commits, checksummed
pnpm test                   # unit and property tests; no stack needed
pnpm run test:it            # with the stack up: real relay, Alby Hubs and LND nodes
pnpm run test:e2e           # with the stack up: the page itself, on two emulated phones
pnpm run check              # type check

pnpm verify                 # format check, type check and unit tests in one go
pnpm verify:all             # the same, then the integration and browser tests
```

As of 2026-11-17: 100 unit tests, 18 integration tests and 2 browser tests
pass. There is no CI; these are local runs.

A pre-commit hook runs `pnpm verify`. Turn it on once per clone:

```bash
git config core.hooksPath .githooks
```

The integration and browser tests pay real regtest invoices from the buyer's
10,000 sat daily budget, so many runs in one day can exhaust it.

Two scripts check what the stack keeps on disk:

```bash
docker compose logs --no-color > .stack/all.log
node scripts/scan-logs.ts .stack/all.log          # keys, secrets or preimages in any log
docker compose cp relay:/usr/src/app/db .stack/relay-db
node scripts/scan-relay-db.ts .stack/relay-db/nostr.db   # what the relay operator can read
```

### Check it yourself

The relay is up and requires sign-in (NIP-42) for private messages:

```bash
curl -s -H 'Accept: application/nostr+json' http://localhost:7777/
```

Each wallet publishes what its connection may do. Anyone can read this, which
is a privacy cost of NWC:

```bash
(echo '["REQ","s",{"kinds":[13194]}]'; sleep 2) | websocat ws://localhost:7777
```

The seller's connection lists `make_invoice` but not `pay_invoice`: it cannot
spend. The buyer's lists `pay_invoice`, with a 10,000 sat daily budget that
the wallet enforces.

## Architecture

```
 seller's phone                              buyer's phone
┌───────────────┐                          ┌───────────────┐
│ Tab (browser) │                          │ Tab (browser) │
│ chat key, PIN │                          │ chat key, PIN │
│ NWC: receive  │                          │ NWC: pay ≤cap │
└──┬─────────┬──┘                          └──┬─────────┬──┘
   │ chat    │ wallet requests       chat     │         │ wallet requests
   ▼         ▼                                ▼         ▼
┌──────────────────────────── relay ────────────────────────────┐
│ stores ciphertext; sees recipient keys, kinds, timing, IPs    │
└──────────┬─────────────────────────────────────────┬──────────┘
           ▼                                         ▼
   seller's wallet service                   buyer's wallet service
   (Alby Hub): enforces scope                (Alby Hub): scope + budget
           │                                         │
     Lightning node  ◄──────── payment ────────  Lightning node
```

| Component      | Version     | Role                                                                 |
| -------------- | ----------- | -------------------------------------------------------------------- |
| Bitcoin Core   | 32.1        | regtest chain                                                        |
| LND            | 0.21.8-beta | one Lightning node per user; its records are the proof of settlement |
| Alby Hub       | 1.24.7      | NWC wallet service; decides what each connection may do              |
| nostr-rs-relay | 0.10.0      | the one relay, with NIP-42 sign-in for private messages              |
| nostr-tools    | 2.26.0      | signing, event hashing, NIP-44 encryption                            |

| Path                               | What it is                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/core/`                        | the protocol logic, pure functions with no network: start here                            |
| `src/core/event.ts`                | the one gate every relay event passes before use                                          |
| `src/core/pay.ts`, `thread.ts`     | payment binding, and "paid" derived only from a verified preimage                         |
| `src/net/`                         | one WebSocket to the relay; wallet requests and their three outcomes                      |
| `src/client.ts`                    | the whole app without a screen; the page and the integration tests share it               |
| `src/main.ts`, `src/style.css`     | the three screens: set up, unlock, chat                                                   |
| `test/unit/`                       | upstream test vectors, property tests, and the app logic against a scripted wallet        |
| `test/it/`                         | the full flow, the wallet's refusals and an independent client, against the running stack |
| `infra/init.mjs`                   | bootstrap: channel, wallet set-up, the two scoped connections                             |
| `infra/native.sh`                  | the same stack without Docker                                                             |
| `infra/relay/config.toml`          | relay settings that the privacy claims depend on                                          |
| `e2e/`                             | the page on two emulated phones (Playwright)                                              |
| `scripts/`                         | fixture capture, log and relay-disk scans, `demo:fresh`, the self-playing walkthrough     |
| `docs/`                            | the threat model, the demo script and the scripted task for a seller                      |
| `docker-compose.yml`, `Dockerfile` | the one-command stack                                                                     |

## The two secrets

|                  | Nostr key (identity)                                                 | Wallet connection (permission)                                           |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Can do           | read your messages, sign as you                                      | spend or invoice within the wallet's limits                              |
| Cannot do        | move money                                                           | read or sign messages                                                    |
| If it leaks      | every stored conversation is readable, with no way to revoke the key | spending up to the budget until you delete the connection in your wallet |
| Where it lives   | on the device, PIN-encrypted                                         | on the device, PIN-encrypted                                             |
| Sent to a server | never                                                                | never                                                                    |

Erasing the app does not revoke the wallet connection. Delete it in the wallet.

## Limits, stated plainly

- **The relay sees metadata.** Message contents are encrypted, but every stored
  message carries the recipient's public key in clear. The relay also sees IP
  addresses and timing, and can link a chat key to a wallet connection by when
  they are used.
- **No forward secrecy.** Anyone who later gets your Nostr key can read every
  message the relay kept (NIP-44 says this itself).
- **No deniability.** Treat every message as attributable to you.
- **No instant revocation.** Deleting a wallet connection works on its next
  request; a payment already sent is not recalled.
- **A short PIN slows down a thief; it does not stop one.** Someone who copies
  the phone's storage can try every 6-digit PIN in under a day on one core.
- **The app does not verify invoice signatures.** The paying Lightning node
  does, but the app cannot show which node gets paid.
- **One relay is a single point of failure** and can censor.
- **Tested with one wallet, on regtest only:** Alby Hub 1.24.7 on LND 0.21.8,
  with nostr-rs-relay 0.10.0. Other wallets may refuse or report differently.
- **The page must be served from `localhost` or over HTTPS.** Browsers only
  expose WebCrypto there, and the vault needs it.
- **The relay's `relay_url` must be the address browsers connect to**
  (`infra/relay/config.toml`), or it rejects the sign-in for private messages.

## If something is down

- **No relay:** messages queue in memory and send on reconnect. The status
  line reads `offline, will retry`.
- **No wallet:** chat still works and the payment buttons are off.
- **A payment that gets no answer** is shown as unknown, never as failed,
  until the wallet says which.

## Demo and user test

- [`docs/demo.md`](docs/demo.md): the three-minute demo, how to prepare it,
  and what to do if the live payment fails.
- [`docs/threat-model.md`](docs/threat-model.md): what is protected, from
  whom, which test checks each threat, and what is left open.
- [`docs/user-test.md`](docs/user-test.md): the scripted task for one seller.
  Its results table is empty: no session has taken place.

## Metrics we track

| Metric                                                        | How                                                                        | Today                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Page download size                                            | browser test byte counter                                                  | 32,857 bytes for the first load                                                                   |
| Text contrast, light and dark mode                            | computed from the page's colours (WCAG ratio; 4.5 is the minimum for text) | 5.2 or better in light mode, 8.2 or better in dark mode; white on the green button is 5.2         |
| Load time on a throttled mid-range phone profile              | browser test                                                               | about 2.5 s to the set-up form (400 kbit/s, 400 ms latency, CPU 4x slower)                        |
| Time from tapping Pay to the seller's wallet confirming       | integration and browser tests                                              | about 1.3 s on one machine: 0.35 s to the buyer's "Paid", then 0.9 s to the seller's confirmation |
| Payments shown as paid without proof                          | must be zero; unit and integration tests                                   | zero in every current test                                                                        |
| Wallet requests refused out of scope or over budget           | must be all; integration tests against Alby Hub                            | all refused in the current tests                                                                  |
| A first-time seller's time per task, and where they got stuck | scripted session with a real seller                                        | not done                                                                                          |

The timings are from one browser-test run on one laptop on 2026-11-17, with
every service on the same machine. The browser's throttling slows the page
download but not WebSocket frames, so the payment timings say nothing about a
slow link.

## Next iteration

What we would ship next, in order:

1. **A session with a real seller in Dakar**, using the scripted task, and fix
   what they got stuck on.
2. **Move the Nostr key out of the page** into a remote signer (NIP-46), so a
   compromised web page cannot read it.
3. **A real phone wallet on mainnet** with a small budget (1,000 sats),
   served over HTTPS.
4. **Show which Lightning node gets paid**, by verifying the invoice signature
   and remembering each seller's node.
5. **Payment notifications from the wallet** instead of polling every few
   seconds, to save battery and data.
