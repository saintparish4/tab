#!/usr/bin/env bash
# The same stack as docker-compose.yml, as plain processes on this machine.
# For when Docker is not available (for example WSL without Docker Desktop
# integration). Linux x86_64 only. Regtest only.
#
#   infra/native.sh up      download pinned binaries (once), start everything, run init
#   infra/native.sh down    stop everything; state stays in .stack/native
#
# Every download is checked against a SHA-256 recorded when this was written.
# The relay has no release binary, so it is built from its tag with cargo
# (about five minutes, once). Every step prints what it is doing, including
# the checksum results and the full compiler output, so it can be watched live.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; D="$ROOT/.stack/native"; B="$D/bin"; mkdir -p "$B" "$D/dl"
BTC="$B/bitcoin-32.1/bin"; LND="$B/lnd-linux-amd64-v0.21.8-beta"

fetch() { # url sha256 file
  if [ -f "$D/dl/$3" ]; then echo "== $3 already downloaded"
  else echo "== downloading $1"; curl -fL --progress-bar --max-time 900 -o "$D/dl/$3" "$1"; fi
  echo "== checking SHA-256 of $3 against the pinned value"
  echo "$2  $D/dl/$3" | sha256sum -c -
}

install() {
  if [ ! -x "$BTC/bitcoind" ]; then
    fetch https://bitcoincore.org/bin/bitcoin-core-32.1/bitcoin-32.1-x86_64-linux-gnu.tar.gz \
      61545c17c3120fb7412f896d248b11993af04ec8817aad3649c55b2afb044963 btc.tar.gz
    tar xzf "$D/dl/btc.tar.gz" -C "$B"
  fi
  if [ ! -x "$LND/lnd" ]; then
    fetch https://github.com/lightningnetwork/lnd/releases/download/v0.21.8-beta/lnd-linux-amd64-v0.21.8-beta.tar.gz \
      4910a14801e10164ca2ea67f5935e2486874331d56bbd0638a68c6158a8e82c9 lnd.tar.gz
    tar xzf "$D/dl/lnd.tar.gz" -C "$B"
  fi
  if [ ! -x "$B/hub/bin/albyhub" ]; then
    fetch https://github.com/getAlby/hub/releases/download/v1.24.7/albyhub-Server-Linux-x86_64.tar.bz2 \
      4826298cbcfa5fa9f1922c3b0d200f3ecca8b571912619f116f00155f6eed766 hub.tar.bz2
    mkdir -p "$B/hub" && tar xjf "$D/dl/hub.tar.bz2" -C "$B/hub"
  fi
  if [ ! -x "$B/relay/bin/nostr-rs-relay" ]; then
    echo "== building nostr-rs-relay 0.10.0 from its git tag (about 5 minutes, first run only)"
    cargo install --git https://github.com/scsibug/nostr-rs-relay --tag 0.10.0 --root "$B/relay" nostr-rs-relay
  fi
}

# Start detached with all output to a log, so this script can return.
bg() { local log="$1"; shift; setsid nohup "$@" >"$log" 2>&1 </dev/null & }

up() {
  install
  echo "== starting bitcoind (regtest) and the relay"
  mkdir -p "$D"/{btc,relay,lnd-merchant,lnd-customer,hub-merchant,hub-customer}
  "$BTC/bitcoind" -regtest -datadir="$D/btc" -daemon -server -fallbackfee=0.0002 -rpcuser=tab -rpcpassword=tab \
    -rpcport=18443 -zmqpubrawblock=tcp://127.0.0.1:28332 -zmqpubrawtx=tcp://127.0.0.1:28333 >/dev/null
  bg "$D/relay.log" "$B/relay/bin/nostr-rs-relay" --config "$ROOT/infra/relay/config.toml" --db "$D/relay"
  sleep 3
  echo "== starting two LND nodes: merchant and customer"
  local i=0 n
  for n in merchant customer; do
    i=$((i + 1))
    bg "$D/lnd-$n.log" "$LND/lnd" --lnddir="$D/lnd-$n" --noseedbackup --bitcoin.regtest --bitcoin.node=bitcoind \
      --bitcoind.rpchost=127.0.0.1:18443 --bitcoind.rpcuser=tab --bitcoind.rpcpass=tab \
      --bitcoind.zmqpubrawblock=tcp://127.0.0.1:28332 --bitcoind.zmqpubrawtx=tcp://127.0.0.1:28333 \
      --rpclisten=127.0.0.1:1000$i --restlisten=127.0.0.1:808$i --listen=127.0.0.1:973$i --alias=tab-$n
  done
  for n in merchant customer; do
    until [ -f "$D/lnd-$n/data/chain/bitcoin/regtest/admin.macaroon" ]; do sleep 1; done
  done
  echo "== starting two Alby Hub wallet services"
  i=0
  for n in merchant customer; do
    i=$((i + 1))
    (cd "$D/hub-$n" && LD_LIBRARY_PATH="$B/hub/lib" WORK_DIR="$D/hub-$n" PORT=809$i RELAY=ws://127.0.0.1:7777 \
      LN_BACKEND_TYPE=LND LND_ADDRESS=127.0.0.1:1000$i LND_CERT_FILE="$D/lnd-$n/tls.cert" \
      LND_MACAROON_FILE="$D/lnd-$n/data/chain/bitcoin/regtest/admin.macaroon" \
      SEND_EVENTS_TO_ALBY=false AUTO_LINK_ALBY_ACCOUNT=false HIDE_UPDATE_BANNER=true \
      bg "$D/hub-$n.log" "$B/hub/bin/albyhub")
  done
  echo "== running the bootstrap: channel, wallets, two scoped NWC connections"
  LND_MERCHANT_MACAROON="$D/lnd-merchant/data/chain/bitcoin/regtest/admin.macaroon" \
    LND_CUSTOMER_MACAROON="$D/lnd-customer/data/chain/bitcoin/regtest/admin.macaroon" \
    OUT="$ROOT/.stack/demo.json" node infra/init.mjs
  echo "stack is up. logs: $D/*.log   relay db: $D/relay/nostr.db"
}

down() {
  pkill -x albyhub || true
  pkill -x lnd || true
  pkill -x nostr-rs-relay || true
  "$BTC/bitcoin-cli" -regtest -rpcuser=tab -rpcpassword=tab stop 2>/dev/null || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: infra/native.sh up|down" >&2; exit 2 ;;
esac