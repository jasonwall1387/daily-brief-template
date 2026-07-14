# Daily Brief - one-time setup for Windows.
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Prereqs: Node 18+, a Cloudflare API token with D1 Edit + Account Settings Read,
# and a D1 database already created with schema.sql applied. See README.md.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 0) Config must exist before we can do anything.
if (-not (Test-Path "$here\config.json")) {
  Copy-Item "$here\config.example.json" "$here\config.json"
  Write-Host "Created config.json from the example. Open it, fill in devRoot / vaultSearchRoots / d1DatabaseId, then re-run this script."
  exit 1
}
$config = Get-Content "$here\config.json" -Raw | ConvertFrom-Json

# 1) Token: prefer the environment, else prompt for it once.
$token = $env:CF_API_TOKEN
if (-not $token) {
  $sec = Read-Host "Paste your Cloudflare API token (D1 Edit + Account Settings Read)" -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# 2) Resolve the account id. This needs the "Account Settings: Read" permission on the token;
#    an account-owned token without it gets a 403 here.
$acct = (Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts" -Headers @{ Authorization = "Bearer $token" }).result[0].id
Write-Host "Cloudflare account: $acct"
$config.cfAccountId = $acct

# WriteAllText, not Set-Content: PowerShell 5.1 writes a UTF-8 BOM that Node's JSON.parse rejects.
[IO.File]::WriteAllText("$here\config.json", ($config | ConvertTo-Json -Depth 5))

# 3) Persist the token for the scheduled tasks.
[Environment]::SetEnvironmentVariable("CF_API_TOKEN", $token, "User")
# SetEnvironmentVariable(..., "User") does NOT touch the current process, so set it here too
# or the test run below fails with "No Cloudflare API token".
$env:CF_API_TOKEN = $token
Write-Host "CF_API_TOKEN stored as a user environment variable."

# 4) Dry run: prove the collectors work before anything is uploaded.
Write-Host "`n--- dry run ---"
node "$here\collect.mjs" dry-run | Select-Object -First 25
Write-Host "--- end dry run ---`n"

# 5) Real collect: proves the D1 write path and the token permissions.
node "$here\collect.mjs"

# 6) Register both scheduled tasks.
$node = (Get-Command node).Source
schtasks /Create /F /TN "DailyBrief-Collect"    /TR "`"$node`" `"$here\collect.mjs`""             /SC DAILY /ST 05:00 /RL LIMITED
schtasks /Create /F /TN "DailyBrief-FetchBrief" /TR "`"$node`" `"$here\collect.mjs`" fetch-brief" /SC DAILY /ST 06:00 /RL LIMITED

Write-Host "`nScheduled tasks registered: collect 05:00, fetch 06:00."
Write-Host "Next: create the Claude scheduled task. Paste trigger-prompt.md into Claude and ask it to run daily at 05:30."
