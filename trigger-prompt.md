# The cloud prompt

This is the prompt the **Claude scheduled task** runs every morning. It is the brain of the
system: the local collector only ships raw data, and this prompt turns it into the brief.

## How to install it

1. Fill in every `<PLACEHOLDER>` below.
2. Open Claude (the app or web, on a plan with scheduled tasks) and make sure your
   **Cloudflare**, **Gmail**, **Google Calendar** and **Todoist** connectors are connected.
3. Paste the filled-in prompt and say: *"Run this every day at 5:30am my time as a scheduled
   task. Turn on push and email notifications for it."*
4. Ask Claude to confirm the cron it registered. Scheduled tasks fire on **UTC** - see the
   note at the bottom.

Keep your filled-in copy somewhere private. It is the one piece of this system that does not
live in a file on disk.

---

## The prompt (copy from here)

You are producing my Daily Brief. Today is {{today}} in <YOUR_TIMEZONE>.

**Step 1 - Read the local digest.**
Query my Cloudflare D1 database `<YOUR_D1_DATABASE_NAME>`:

```sql
SELECT payload FROM daily_digest
WHERE digest_date = '<TODAY_YYYY_MM_DD>'
ORDER BY id DESC LIMIT 1;
```

The payload is JSON produced by my machine at 5:00am. It contains: `git` (per repo: commits,
uncommitted files, unpushed commits, and the contents of STATUS.md if it changed),
`claude_code_sessions`, `codex_sessions`, `watched_paths`, and `obsidian_vault_activity`.

If there is **no row for today**, do not stop. Produce the brief from the connectors alone and
put the line `LOCAL DATA STALE - no digest from <YOUR_MACHINE_NAME> today` directly under the
title. This is the degraded mode and it is expected whenever the machine was off.

**Step 2 - Read the connectors.** In this order:
- **Gmail**: unread and recent mail from the last 24 hours. You are looking for things that
  need a reply, money in or out, and anything time-sensitive. Ignore newsletters and
  notifications.
- **Google Calendar**: everything on today, plus anything in the next 7 days that needs
  preparation.
- **Todoist**: the project `<YOUR_TASK_PROJECT_NAME>` (open tasks, so you can carry over what
  did not get done), plus anything overdue or due today anywhere else.
- `<ANY_OTHER_CONNECTOR_YOU_USE>` (for example a CRM: deals that moved, replies that landed).

**Step 3 - Compose the brief.** Markdown, exactly these sections, in this order:

```markdown
# Daily Brief - <YYYY-MM-DD>

_Window: last 26 hours. <staleness note if the local digest is missing>_

## TL;DR
- (three bullets maximum, the three things that actually matter today)

## Yesterday, by project
### <project name>
- what moved: commits, what got shipped, what is sitting uncommitted or unpushed
- the honest state, not a summary of the diff

## Inbox and money
- mail that needs a reply, invoices, payments, anything with a dollar figure

## Today's checklist
1. (specific, actionable, one outcome per line)
2. (carried over from yesterday: <item>)

## Radar (next 7 days)
- deadlines, meetings that need prep, anything with a date attached
```

**Step 4 - Save the brief.** Insert it into D1. Use **parameterized queries** - the markdown
contains quotes and apostrophes that will break an inlined SQL string:

```sql
INSERT INTO daily_brief (brief_date, markdown, summary, todos) VALUES (?, ?, ?, ?);
```

`summary` is the TL;DR as plain text. `todos` is the checklist as a JSON array of strings.
My machine picks this row up at 6:00am and writes it into my Obsidian vault.

**Step 5 - Sync the checklist to Todoist.** In the project `<YOUR_TASK_PROJECT_NAME>`:
- Read the existing open tasks **first**.
- Add each new checklist item that is not already there. Match on the task text so you never
  create duplicates.
- Leave carried-over tasks alone. Do not recreate them, and do not close them.
- Do not complete anything. Only I close tasks.
- If you are on the Todoist **free plan**, do not set `deadlineDate` - it is a premium field
  and the API returns 403 PREMIUM_ONLY. Put the deadline in the task description instead.

**Step 6 - The notification.** Your completion message is what reaches my phone. Lead with the
TL;DR, in full. Do not write "the brief is ready" - carry the content.

### Hard rules
- Never mark anything done unless the data actually shows it. If a repo has uncommitted
  changes, the work is not shipped, and the brief says so.
- **Never send anything.** No emails, no messages, no calendar invites. You read and you
  write my own notes. That is all.
- Be terse. This gets read at 6am on a phone. No preamble, no "great progress yesterday!",
  no restating the section headers back at me.
- Never touch these systems: `<SYSTEMS_THAT_ARE_OFF_LIMITS - e.g. a production database, a
  client's account>`. If the data mentions them, report and do not act.
- If a connector fails or returns nothing, say so in one line under the affected section.
  Do not silently drop it, and do not invent the content.

### Style block (edit this to taste)
- Write in plain sentences. No em dashes.
- Use the project's real name, never a codename you invented in this run.
- Dates as YYYY-MM-DD. Money with the figure.

## (copy to here)

---

## Notes

**The cron is UTC.** `30 10 * * *` is 5:30am US Central in summer (CDT) but 4:30am in winter
(CST). If that matters to you, nudge the trigger to `30 11 * * *` when the clocks change, or
just pick a time you do not care about drifting by an hour.

**What this system cannot see.** Claude web and mobile chats have no read API. They only show
up here when they produce a commit, a file in a watched path, or a STATUS.md edit. Keeping a
short STATUS.md in each repo is what makes that work visible to the brief - it is the cheapest
fix for the biggest blind spot in the whole system.
