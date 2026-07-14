# Sanitization checklist

Run this before pushing this template, or any fork of it, anywhere public.

This system reads your entire working life. Its config and examples are exactly where your
private details leak from. Nothing here is theoretical: every line below is something that was
in the original build and had to be stripped.

## The two non-negotiables

1. **Never migrate history from a private repo.** Secrets live in git *history*, not just in the
   current files. Start the public repo empty and copy clean files in. Do not rewrite a real
   repo's history and hope.
2. **No real credential ever, in any file, at any point.** Not "temporarily", not in a commit you
   plan to amend. Once it is pushed, treat it as burned and rotate it.

## Checklist

- [ ] `config.json` is **not** committed (it is in `.gitignore`; confirm with `git status`)
- [ ] No Cloudflare **account ID** or **D1 database ID** in any tracked file (they belong only in
      the gitignored `config.json`)
- [ ] No **API tokens** or bearer strings anywhere: `git grep -iE '(token|bearer|secret|api[_-]?key)\s*[:=]\s*["'\'']?[A-Za-z0-9_-]{16,}'`
- [ ] No **Claude scheduled-task / trigger IDs** (`trig_...`)
- [ ] No **Todoist project IDs**, or any other connector's internal IDs
- [ ] No **real file paths** that name you, your machine, your employer, or your clients
      (`C:\work\acme-client\...`, `/Users/yourname/...`)
- [ ] No **real project or client names** in examples, sample config, or the prompt
- [ ] No **real email addresses or phone numbers** (use `you@example.com`, `+15555550123`)
- [ ] No **network paths** or NAS / internal hostnames
- [ ] No references to a **private secret manager** path or vault name
- [ ] `trigger-prompt.md` uses `<PLACEHOLDER>` everywhere and carries **none** of your real
      projects, rules, or business context
- [ ] Personal style rules are presented as a **configurable block**, not as the template's own
      opinion
- [ ] `README.md` states the prerequisites: which accounts and connectors a stranger needs
- [ ] The whole thing was run **from a clean clone**, with a fresh config, on a machine that is
      not yours, before you claim it works

## Grep before every push

```bash
# Replace these with your own real values, then confirm every one returns nothing.
git grep -InE '<your-account-id>|<your-db-id>|<your-machine-name>|<your-domain>|trig_'
```

If any of them hit, the push does not happen.
