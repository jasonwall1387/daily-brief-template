# Daily Brief

An AI brief of your own work, in your inbox and your notes, before you sit down.

Every morning at 5:30am, Claude reads everything you did in the last 26 hours - every git repo
on your machine, your Claude Code and Codex sessions, your Obsidian vault, your Gmail, your
calendar, your task list - and writes you one page:

- **TL;DR** - the three things that actually matter today
- **Yesterday, by project** - what moved, what is still uncommitted, what is unpushed
- **Inbox and money** - what needs a reply, what needs paying
- **Today's checklist** - synced into Todoist, carrying over what you did not finish
- **Radar** - the next 7 days

It lands as a markdown note in your Obsidian vault, a checklist in Todoist, and a push
notification that carries the TL;DR itself, so the brief is read before you open anything.

Free to run: Cloudflare D1's free tier covers it comfortably.

---

## The problem this solves (and the trick that makes it work)

A Claude **scheduled task runs in a fresh cloud session**. It has no bridge to your device. It
cannot read your disk, so it cannot see your commits, your session logs, or your notes.

Your **local machine** is the exact opposite. It can read all of that, and none of your OAuth
connectors (Gmail, Calendar, Todoist) are available to it without setting each one up by hand.

Each half is blind where the other can see. So this is a hybrid, with a cheap shared store in
the middle that both halves can reach: a **Cloudflare D1 database**.

```
5:00am   LOCAL (Task Scheduler / cron) -> collect.mjs
           scans your git repos: commits, uncommitted, unpushed, STATUS.md
           reads ~/.claude/projects and ~/.codex/sessions
           reads your Obsidian vault and any other watched folders
           -> INSERT digest JSON into D1

5:30am   CLOUD (Claude scheduled task)
           SELECT the digest from D1
           + Gmail + Google Calendar + Todoist (+ your CRM, etc.)
           -> composes the brief
           -> INSERT the brief into D1
           -> syncs the checklist into Todoist
           -> the completion notification carries the TL;DR to your phone

6:00am   LOCAL (Task Scheduler / cron) -> collect.mjs fetch-brief
           SELECT unfetched briefs from D1
           -> writes them into <vault>/daily-briefs/YYYY-MM-DD-daily-brief.md
```

**Neither half can break the other.** If your machine was off, the cloud run still produces a
connector-only brief and stamps it `LOCAL DATA STALE`. If the cloud run is missed, digests just
accumulate, and the fetcher catches up on unfetched briefs the next time it runs (the most
recent three per run), not just today's.

### Alternatives that did not work

| Approach | Why not |
|---|---|
| GitHub as the handoff store | No GitHub connector in the scheduled-task registry, and a private repo would need a PAT pasted into the prompt itself. |
| A new Supabase project | Free only if it is your first. A second project bills monthly. D1 is free and the Cloudflare connector already existed. |
| Local-only, headless `claude -p` on a timer | Full disk access, but no OAuth connectors. Gmail and the rest would each need a local MCP server and its own auth. More moving parts, more to break. |
| Cloud-only | Cannot see unpushed commits, session logs, or local files. It is the degraded mode, not the design. |

---

## What you need

- **Node 18+** (the collector uses built-in `fetch` and has zero npm dependencies)
- **A Cloudflare account** (free) with a D1 database and an API token
- **A Claude plan with scheduled tasks**, and the **Cloudflare**, **Gmail**, **Google Calendar**
  and **Todoist** connectors connected
- **Obsidian** if you want the brief filed as a note (skip it and the brief still lands in
  Todoist and your notifications)

---

## Setup

### 1. Create the database

```bash
npx wrangler d1 create daily-brief
npx wrangler d1 execute daily-brief --remote --file=./schema.sql
```

Copy the database ID that `create` prints. (You can also paste `schema.sql` into the D1 console
in the Cloudflare dashboard.)

### 2. Create the API token

Cloudflare dashboard, **My Profile -> API Tokens -> Create Token -> Custom token**:

- **D1** - Edit
- **Account Settings** - Read

That second permission is not optional. Setup calls `GET /accounts` to resolve your account ID,
and an account-owned token without `Account Settings: Read` gets a 403 there.

### 3. Configure and install

```bash
cp config.example.json config.json
# edit config.json: devRoot, vaultSearchRoots, timezone, d1DatabaseId
```

Then, on **Windows**:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

On **macOS / Linux**:

```bash
chmod +x setup.sh && ./setup.sh
```

Setup prompts for the token, resolves your account ID, does a dry run, does one real collect to
prove the write path, and registers both scheduled jobs (05:00 collect, 06:00 fetch).

**Where the token lives.** At runtime the collector checks, in order: the `CF_API_TOKEN`
environment variable, `cfApiToken` in `config.json`, then `tokenCommand` (a shell command that
prints the token - point it at your secret manager). When storing, setup prefers the safest
option it can find:

- On **Windows**: an existing `tokenCommand` is verified and left alone; else, if the Infisical
  CLI is installed, the token is stored as the `CF_D1_TOKEN` secret and the matching
  `tokenCommand` is written into `config.json`; only as a last resort does setup persist a
  `CF_API_TOKEN` user environment variable, and it warns when it does (gotcha 10).
- On **macOS / Linux**: an existing `tokenCommand` is left alone; else the token is written into
  `config.json` (gitignored, mode 600).

Whatever secret manager you use, make `tokenCommand` fully qualified. With Infisical that means:

```bash
infisical secrets get CF_D1_TOKEN --projectId <your-project-id> --env=prod --path=/ --plain --silent
```

A bare `infisical secrets get CF_D1_TOKEN --plain` resolves the CLI defaults (`env=dev`,
`path=/`) and silently returns nothing when the secret lives anywhere else (gotcha 11).

Check it by hand any time:

```bash
node collect.mjs dry-run     # print the digest, upload nothing
```

### 4. Create the cloud task

Open **[trigger-prompt.md](./trigger-prompt.md)**, fill in the placeholders, paste it into
Claude, and ask it to run daily at 5:30am with notifications on.

That is the whole system: two local jobs, one cloud task, one database.

---

## Gotchas

Every one of these cost real time to find. They are the actual content of this repo.

1. **PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM**, and `JSON.parse` chokes on
   it. Fixed in both directions: `setup.ps1` writes config with `[IO.File]::WriteAllText`, and
   `collect.mjs` strips a leading BOM before parsing.

2. **`[Environment]::SetEnvironmentVariable(..., "User")` does not affect the running process.**
   Setup's own test run cannot see the token it just stored unless you also set `$env:CF_API_TOKEN`
   in the session.

3. **Vault auto-detection finds your backups.** A vault backup contains a `.obsidian` folder
   too, so the naive "first `.obsidian` wins" search happily writes today's brief into a
   snapshot from last month. The detector now collects every candidate and filters out anything
   matching `backup|archive|snapshot`. Pin `vaultPath` in config to skip the guessing.

4. **A Cloudflare account-owned token cannot call `GET /accounts`** without `Account Settings: Read`.
   See step 2.

5. **Todoist's free plan rejects `deadlineDate`** with a 403 `PREMIUM_ONLY`. Put deadlines in
   the task description instead.

6. **Scheduled tasks fire on UTC.** `30 10 * * *` is 5:30am US Central in summer and 4:30am in
   winter. Either accept the drift or nudge the cron when the clocks change.

7. **Claude web and mobile chats have no read API.** Work done there is invisible to this system
   unless it lands as a commit, a file in a watched folder, or a `STATUS.md` edit. Keeping a
   short `STATUS.md` per repo is the cheapest fix for the biggest blind spot here.

8. **The cloud run's D1 inserts must be parameterized.** The brief markdown is full of quotes
   and apostrophes and will break an inlined SQL string. The trigger prompt says so explicitly,
   because the model will otherwise inline it.

9. **`2>nul` is cmd.exe syntax.** Shipped in the original Windows-only collector, it silently
   creates a junk file called `nul` on macOS and Linux. Removed here: the collector already
   discards stderr.

10. **A persisted `CF_API_TOKEN` hijacks every wrangler command on the machine.** wrangler reads
    `CF_API_TOKEN` as a legacy alias of `CLOUDFLARE_API_TOKEN`, and an environment token
    silently outranks `wrangler login`. Every deploy from that machine then authenticates as
    this narrow D1 token and fails in confusing ways. That is why setup prefers `tokenCommand`
    or Infisical storage and only falls back to the env var with a warning.

11. **A bare `infisical secrets get NAME --plain` looks in `env=dev`, `path=/`.** Those are the
    CLI defaults, so when the secret lives in another environment or folder the command quietly
    prints nothing and the collector reports no token. Pass `--projectId`, `--env`, and
    `--path` explicitly in `tokenCommand`, plus `--silent` so CLI banners cannot pollute the
    captured value.

---

## What it cannot see

- **Claude web / mobile chats** and **Cursor sessions** (see gotcha 7). Both surface indirectly
  through git activity and `STATUS.md`.
- **Anything you did on a machine that is not running the collector.** The digest is keyed by
  machine, so you can run the collector on several machines and they will all report into the
  same brief.

## Files

| File | What it is |
|---|---|
| `collect.mjs` | The local collector and fetcher. Zero dependencies. Modes: `collect`, `fetch-brief`, `dry-run`. |
| `brief-files.mjs` | Validates cloud-supplied dates and writes complete notes inside the vault. Keep it alongside `collect.mjs`. |
| `config.example.json` | Copy to `config.json` (gitignored) and fill in. |
| `schema.sql` | The two D1 tables. |
| `setup.ps1` / `setup.sh` | One-time setup: token, account ID, test run, scheduled jobs. |
| `trigger-prompt.md` | The cloud prompt. The brain of the system. |
| `SANITIZATION.md` | Checklist to run before you push a fork of this anywhere public. |

## Making it yours

The parts most worth editing:

- **The brief format** lives entirely in `trigger-prompt.md`. Change the sections, change the
  tone, change what counts as important. That file is the product.
- **What gets collected** lives in `collect.mjs`. Add a collector function, add its output to
  the `digest` object, and mention it in the prompt's Step 1 so the model knows to use it.
- **Where it lands**: swap Obsidian for any folder, or swap Todoist for whatever you use, by
  changing the connector named in the prompt.

## Security

The fetcher accepts only real calendar dates in `YYYY-MM-DD` format. `briefFolder` must
be relative to the configured vault. Existing links below the vault root, including a
linked output file, are rejected. Notes are written to a temporary file in the destination
folder and renamed into place; a D1 row is acknowledged only after that write succeeds.
The explicitly configured vault may itself resolve through a link. These checks constrain
cloud-supplied data; they do not sandbox another local process with access to your vault.

`config.json` holds your Cloudflare token and is gitignored. Never commit it. If you fork this
and publish it, run [SANITIZATION.md](./SANITIZATION.md) first: your account ID, database ID,
paths, project names and email addresses all leak through config and examples if you are not
deliberate about it.

Run the regression tests with `node --test` from this repository. They use temporary
folders and mocked D1 responses, including traversal, symlink, and failed-write cases.

## License

[MIT](./LICENSE). Use it, change it, ship it. Attribution appreciated, not required.

---

Built by Jason at [Revenue With AI](https://revenuewithai.com). If you want AI actually wired
into your business instead of just talked about, that is what I do.
