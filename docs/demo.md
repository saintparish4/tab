# Three-minute demo

Two browser windows side by side, phone-sized. Left: seller
(`/?demo=merchant`). Right: buyer (`/?demo=customer`). Both already past the
PIN screen before you start talking. A terminal behind them, ready with the
two commands in "Show the evidence".

## Before you start

```bash
docker compose up --build -d          # or: infra/native.sh up, then build and preview
pnpm run demo:fresh                   # an empty thread: new throwaway chat keys
docker compose exec web cp /shared/demo.json dist/demo.json
docker compose cp relay:/usr/src/app/db .stack/relay-db   # for the scan in "Show the evidence"
```

In each window choose **Erase this device** if it shows Unlock, then set up
again with a PIN. Check the status lines: `online · wallet: can request` on
the left, `online · wallet: can pay · … sats left today` on the right. The
buyer needs at least 300 sats left; the budget renews daily.

## 0:00 Problem (30 s)

> A seller here takes orders in a chat app and gets paid somewhere else. The
> proof of payment is a screenshot. The seller cannot check a screenshot, the
> buyer can paste the wrong invoice, and the chat app sees every order.

> We built this for a seller in Dakar who takes orders by message and accepts
> Lightning: a food stall, a kiosk, a tailor. We have not tested it with a
> seller yet.

## 0:30 Solution (90 s)

1. Buyer types `two chapati and tea`. It appears on the left.
   > Encrypted to the seller's key. The relay stores ciphertext.
2. Seller types `250`, `chapati`, taps **Request payment**.
   > The seller's wallet connection can create invoices and nothing else. It
   > cannot spend. The wallet enforces that, not our app.
3. Buyer taps **Pay 250 sats**. Right side turns to `Paid ✓ proof verified`,
   left side to `Paid ✓ confirmed by your wallet`. The buyer's status line
   shows 250 sats fewer left.
   > Neither side took the other's word. The buyer's phone checked that the
   > wallet's preimage hashes to the invoice. The seller's phone asked the
   > seller's own wallet.
4. Buyer types `I paid twice, refund me` and nothing changes on the left.
   > A message is not a payment.

If there is time, seller requests `20000`. Buyer taps Pay and sees
`Over this connection's spending limit.`

> The buyer's wallet refused that, not our app. The limit is set in the
> wallet.

## 2:00 Show the evidence (30 s)

```bash
pnpm run test:it 2>&1 | tail -4        # the wallet refusing out-of-scope and over-budget requests
node scripts/scan-relay-db.ts .stack/relay-db/nostr.db   # what the relay holds
```

> The wallet itself rejects a spend from the seller's connection. The relay's
> database has no plaintext. It does have the recipient's public key on every
> message, and we say so.

## 2:30 Impact and next steps (30 s)

> What "sign in with your wallet" honestly means here: the app can use this
> wallet within limits you set. It is not an identity, and we do not pretend
> it is. Next: one session with a real seller in Dakar, using a scripted
> task, timing each step and fixing where they get stuck.

## If the live payment fails

Regtest has no outside dependency, so a failure is local. In order:

1. Status line says `offline, will retry`: the relay container stopped.
   `docker compose up -d relay` and wait for `online`.
2. Status line says `wallet unreachable`: restart the wallets and issue new
   keys and connection strings, then **Erase this device** in both windows
   and set up again with `?demo=`.

   ```bash
   docker compose restart hub-merchant hub-customer
   docker compose run --rm init
   docker compose restart web
   ```

3. Buyer sees `Over this connection's spending limit.` on the 250: the daily
   budget is used up. The commands in 2 issue a fresh one.
4. Payment sits at `Unknown, checking with wallet…`: say what it is. "The
   wallet has not answered. The app will not call this failed or paid until
   the wallet says which." That is the designed behaviour, and it is a better
   demo of the contract than a success.
5. Nothing works: run `pnpm run test:it` in the terminal and narrate the test
   names. It performs the same flow against the same wallets.
6. Hands are shaking or time is short: `pnpm run demo:watch` plays the same
   flow by itself in one window, with captions. Narrate over it.
7. No stack at all: play `.stack/walkthrough.mp4`. Make it the night before
   with `pnpm run demo:record`, and copy it somewhere outside the repo folder.
