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

# 3) Store the token where the scheduled tasks can reach it. Preference order:
#      a) config.tokenCommand   your secret manager already serves it; nothing to store
#      b) the Infisical CLI     store it as CF_D1_TOKEN and wire tokenCommand to fetch it
#      c) a User env var        last resort: a persisted CF_API_TOKEN shadows `wrangler login`
#                               for EVERY wrangler command on this machine (wrangler reads it
#                               as a legacy alias of CLOUDFLARE_API_TOKEN, and environment
#                               tokens outrank the OAuth login)
$stored = ""

# 3a) tokenCommand already configured: verify it resolves, store nothing.
if ($config.tokenCommand) {
  Write-Host "config.tokenCommand is set; verifying it resolves a token..."
  $probe = cmd /c $config.tokenCommand | Select-Object -Last 1
  if ($probe -and $probe.Trim()) {
    Write-Host "tokenCommand resolves. Scheduled runs will use it; nothing else stored."
    $stored = "tokenCommand"
  } else {
    Write-Warning "tokenCommand returned nothing. Fix it, or let setup store the token another way below."
  }
}

# 3b) Infisical CLI available: store the secret and write the matching tokenCommand.
#     The get command is fully flagged on purpose: a bare `infisical secrets get` resolves the
#     CLI defaults (env=dev, path=/) and silently finds nothing when the secret lives elsewhere.
if (-not $stored -and (Get-Command infisical -ErrorAction SilentlyContinue)) {
  $isFlags = @("--env=prod", "--path=/")
  if ($env:INFISICAL_PROJECT_ID) { $isFlags = @("--projectId", $env:INFISICAL_PROJECT_ID) + $isFlags }
  Write-Host "Infisical CLI found. Storing the token as CF_D1_TOKEN ($($isFlags -join ' '))..."
  & infisical secrets set "CF_D1_TOKEN=$token" $isFlags --silent | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $get = "infisical secrets get CF_D1_TOKEN " + ($isFlags -join " ") + " --plain --silent"
    $config | Add-Member -NotePropertyName tokenCommand -NotePropertyValue $get -Force
    Write-Host "Stored in Infisical. config.tokenCommand now reads it back: $get"
    $stored = "infisical"
  } else {
    Write-Warning "Infisical store failed (not logged in, no linked workspace, and no INFISICAL_PROJECT_ID?). Falling back."
  }
}

# 3c) Last resort: persist a User env var, with the wrangler warning.
if (-not $stored) {
  Write-Warning "Persisting CF_API_TOKEN as a User environment variable."
  Write-Warning "A persisted CF_API_TOKEN shadows 'wrangler login' for EVERY wrangler command on this machine: wrangler reads it as a legacy alias of CLOUDFLARE_API_TOKEN, and environment tokens outrank the OAuth login. If you deploy other Cloudflare projects from here, move the token to a secret manager (config.tokenCommand) or into config.cfApiToken (config.json is gitignored), then remove the env var."
  [Environment]::SetEnvironmentVariable("CF_API_TOKEN", $token, "User")
  $stored = "envvar"
}

# A leftover User-level CF_API_TOKEN from an earlier setup overrides tokenCommand at runtime
# AND shadows wrangler login, so surface it.
if ($stored -ne "envvar" -and [Environment]::GetEnvironmentVariable("CF_API_TOKEN", "User")) {
  Write-Warning "A User-level CF_API_TOKEN already exists. It overrides tokenCommand at runtime and shadows 'wrangler login'. Remove it with:"
  Write-Warning '  [Environment]::SetEnvironmentVariable("CF_API_TOKEN", $null, "User")'
}

# WriteAllText, not Set-Content: PowerShell 5.1 writes a UTF-8 BOM that Node's JSON.parse rejects.
[IO.File]::WriteAllText("$here\config.json", ($config | ConvertTo-Json -Depth 5))

if ($stored -eq "envvar") {
  # SetEnvironmentVariable(..., "User") does NOT touch the current process, so set it here too
  # or the test run below fails with "No Cloudflare API token".
  $env:CF_API_TOKEN = $token
} else {
  # Make the test runs exercise the exact path the scheduled tasks will use (tokenCommand),
  # not a process env var the scheduled tasks will never see.
  Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
}

# 4) Dry run: prove the collectors work before anything is uploaded.
Write-Host "`n--- dry run ---"
node "$here\collect.mjs" dry-run | Select-Object -First 25
Write-Host "--- end dry run ---`n"

# 5) Real collect: proves the D1 write path, the token permissions, and the token lookup itself.
node "$here\collect.mjs"

# 6) Register both scheduled tasks.
$node = (Get-Command node).Source
schtasks /Create /F /TN "DailyBrief-Collect"    /TR "`"$node`" `"$here\collect.mjs`""             /SC DAILY /ST 05:00 /RL LIMITED
schtasks /Create /F /TN "DailyBrief-FetchBrief" /TR "`"$node`" `"$here\collect.mjs`" fetch-brief" /SC DAILY /ST 06:00 /RL LIMITED

Write-Host "`nScheduled tasks registered: collect 05:00, fetch 06:00."
Write-Host "Next: create the Claude scheduled task. Paste trigger-prompt.md into Claude and ask it to run daily at 05:30."
