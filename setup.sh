#!/usr/bin/env bash
# Daily Brief - one-time setup for macOS / Linux.
#
#   chmod +x setup.sh && ./setup.sh
#
# Prereqs: Node 18+, a Cloudflare API token with D1 Edit + Account Settings Read,
# and a D1 database already created with schema.sql applied. See README.md.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0) Config must exist before we can do anything.
if [ ! -f "$HERE/config.json" ]; then
  cp "$HERE/config.example.json" "$HERE/config.json"
  echo "Created config.json from the example. Open it, fill in devRoot / vaultSearchRoots / d1DatabaseId, then re-run this script."
  exit 1
fi

# 1) Token.
TOKEN="${CF_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  read -rsp "Paste your Cloudflare API token (D1 Edit + Account Settings Read): " TOKEN
  echo
fi
export CF_API_TOKEN="$TOKEN"

# 2) Resolve the account id. Needs "Account Settings: Read" on the token.
ACCT=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  https://api.cloudflare.com/client/v4/accounts \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.success)throw new Error(JSON.stringify(j.errors));console.log(j.result[0].id)})')
echo "Cloudflare account: $ACCT"

# 3) Write the account id AND the token into config.json.
#    cron does not inherit your shell environment, so the token has to live somewhere the
#    scheduled run can read. config.json is gitignored. Prefer config.tokenCommand if you
#    keep secrets in a manager (1Password, pass, your own vault of choice).
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  cfg.cfAccountId = process.argv[2];
  if (!cfg.tokenCommand) cfg.cfApiToken = process.argv[3];
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$HERE/config.json" "$ACCT" "$TOKEN"
chmod 600 "$HERE/config.json"
echo "config.json updated (mode 600)."

# 4) Dry run: prove the collectors work before anything is uploaded.
echo
echo "--- dry run ---"
node "$HERE/collect.mjs" dry-run | head -25
echo "--- end dry run ---"
echo

# 5) Real collect: proves the D1 write path and the token permissions.
node "$HERE/collect.mjs"

# 6) Install both cron entries, replacing any previous ones.
NODE_BIN="$(command -v node)"
MARK="# daily-brief"
TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$MARK" > "$TMP" || true
{
  echo "0 5 * * * $NODE_BIN $HERE/collect.mjs >> $HERE/collect.log 2>&1 $MARK"
  echo "0 6 * * * $NODE_BIN $HERE/collect.mjs fetch-brief >> $HERE/collect.log 2>&1 $MARK"
} >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

echo
echo "Cron installed: collect 05:00, fetch 06:00 (logs in collect.log)."
echo "macOS note: grant your terminal / cron Full Disk Access if the vault lives under a protected folder."
echo "Next: create the Claude scheduled task. Paste trigger-prompt.md into Claude and ask it to run daily at 05:30."
