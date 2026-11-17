#!/usr/bin/env bash
# Download the upstream test material at pinned commits and refuse it unless
# the bytes match the recorded SHA-256. The tests read these files directly, so
# "the vectors pass" means the upstream vectors, not a copy someone edited.
set -euo pipefail
mkdir -p "$(dirname "$0")/../test/fixtures"
cd "$(dirname "$0")/../test/fixtures"

fetch() { # url sha256 file
  curl -fsSL --max-time 60 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

# NIP-44 vectors. The same checksum is printed in NIP-44 itself.
fetch https://raw.githubusercontent.com/paulmillr/nip44/671a1f04bcfacaf125b0db68adc45bc9ce0e763b/nip44.vectors.json \
  269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040 nip44.vectors.json

# BOLT 11, for its "Examples" and "Examples of Invalid Invoices" sections.
fetch https://raw.githubusercontent.com/lightning/bolts/191462825ae341f0a27098765c075f01ca9bc6c2/11-payment-encoding.md \
  c659da1bc08091f7fe691cd4ce661e578dfbe1f77a0b9cd9c53d1839010ae029 bolt11.md