#!/usr/bin/env node
// Daily Brief local collector.
//
// Modes:
//   node collect.mjs              collect the last N hours of local activity, upload a digest to Cloudflare D1
//   node collect.mjs fetch-brief  pull finished briefs from D1 and write them into your Obsidian vault
//   node collect.mjs dry-run      collect and print the digest JSON, upload nothing
//
// Zero npm dependencies. Requires Node 18+ (built-in fetch).
// Config: copy config.example.json to config.json next to this file and fill it in.
// Cloudflare token, in priority order: env CF_API_TOKEN, config.cfApiToken, config.tokenCommand.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");

if (!existsSync(CONFIG_PATH)) {
  console.error("No config.json found. Copy config.example.json to config.json and fill it in.");
  process.exit(1);
}

// Strip a UTF-8 BOM before parsing: PowerShell's `Set-Content -Encoding UTF8` writes one and JSON.parse rejects it.
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));

const MODE = process.argv[2] || "collect";
const HOURS = cfg.lookbackHours || 26;
const CUTOFF = Date.now() - HOURS * 3600 * 1000;
const TZ = cfg.timezone || "UTC";
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // en-CA renders as YYYY-MM-DD

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

function getToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  if (cfg.cfApiToken) return cfg.cfApiToken;
  if (cfg.tokenCommand) {
    // Optional: shell out to a secret manager, e.g. "op read op://vault/cloudflare/token"
    const t = sh(cfg.tokenCommand);
    if (t) return t.split(/\r?\n/).pop().trim();
  }
  throw new Error("No Cloudflare API token. Set CF_API_TOKEN, or config.cfApiToken, or config.tokenCommand.");
}

async function d1(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.cfAccountId}/d1/database/${cfg.d1DatabaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!body.success) throw new Error("D1 query failed: " + JSON.stringify(body.errors));
  return body.result[0];
}

// ---------- collectors ----------

function findGitRepos(root, maxDepth = 3) {
  const repos = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", ".astro", "__pycache__", ".venv"]);
  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      repos.push(dir);
      if (dir !== root) return; // do not descend into a repo, but do allow repos nested under the root
    }
    for (const e of entries) {
      if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return repos;
}

function gitActivity() {
  if (!cfg.devRoot || !existsSync(cfg.devRoot)) return [];
  const out = [];
  for (const repo of findGitRepos(cfg.devRoot)) {
    const name = repo === cfg.devRoot ? "(code root)" : repo.slice(cfg.devRoot.length + 1);
    const commits = sh(
      `git log --all --since="${HOURS} hours ago" --pretty=format:"%h|%an|%ad|%s" --date=format:"%Y-%m-%d %H:%M"`,
      repo
    );
    const dirty = sh("git status -s", repo);
    const branch = sh("git rev-parse --abbrev-ref HEAD", repo);

    // No `2>nul` here: that is cmd.exe syntax and would create a junk file named "nul" on macOS/Linux.
    // sh() already discards stderr.
    let unpushed = "";
    if (sh("git rev-parse --abbrev-ref @{u}", repo)) unpushed = sh("git log @{u}..HEAD --oneline", repo);

    // STATUS.md is how work done outside this machine (web chats, cloud sessions) becomes visible.
    let status = "";
    const statusPath = join(repo, "STATUS.md");
    if (existsSync(statusPath) && statSync(statusPath).mtimeMs > CUTOFF - 24 * 3600 * 1000) {
      status = readFileSync(statusPath, "utf8").slice(0, 4000);
    }

    if (commits || dirty || unpushed) {
      out.push({
        repo: name,
        branch,
        commits: commits ? commits.split("\n").slice(0, 30) : [],
        uncommitted: dirty ? dirty.split("\n").slice(0, 25) : [],
        unpushed: unpushed ? unpushed.split("\n").slice(0, 15) : [],
        status_md: status || undefined,
      });
    }
  }
  return out;
}

function claudeSessions() {
  const projDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projDir)) return [];
  const sessions = [];
  for (const proj of readdirSync(projDir)) {
    const dir = join(projDir, proj);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      const st = statSync(p);
      if (st.mtimeMs < CUTOFF) continue;
      let firstUserMsg = "";
      let msgCount = 0;
      let summary = "";
      try {
        const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
        msgCount = lines.length;
        for (const line of lines.slice(0, 80)) {
          try {
            const j = JSON.parse(line);
            if (j.type === "summary" && j.summary && !summary) summary = j.summary;
            if (!firstUserMsg && j.type === "user" && j.message) {
              const c = j.message.content;
              const text =
                typeof c === "string" ? c : Array.isArray(c) ? c.find((x) => x.type === "text")?.text || "" : "";
              // Skip harness-injected turns (system reminders, local-command caveats).
              if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) firstUserMsg = text.slice(0, 300);
            }
            if (summary && firstUserMsg) break;
          } catch {}
        }
      } catch {}
      sessions.push({
        project: proj, // Claude encodes the cwd as a folder name; left raw because the encoding is lossy
        modified: new Date(st.mtimeMs).toISOString(),
        entries: msgCount,
        summary: summary || undefined,
        first_prompt: firstUserMsg || undefined,
      });
    }
  }
  return sessions.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 40);
}

function codexSessions() {
  const dir = join(homedir(), ".codex", "sessions");
  if (!existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = statSync(p);
          if (st.mtimeMs > CUTOFF) out.push({ file: e.name, modified: new Date(st.mtimeMs).toISOString() });
        } catch {}
      }
    }
  })(dir);
  return out.slice(0, 20);
}

function recentFiles(root, label, maxFiles = 60) {
  if (!root || !existsSync(root)) return { label, root, note: "path not found", files: [] };
  const files = [];
  const skip = new Set([".obsidian", ".trash", ".git", "node_modules", "#recycle", "@eaDir"]);
  (function walk(d, depth) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(join(d, e.name), depth + 1);
      } else {
        const p = join(d, e.name);
        try {
          const st = statSync(p);
          if (st.mtimeMs > CUTOFF) files.push({ path: p.slice(root.length + 1), modified: new Date(st.mtimeMs).toISOString(), bytes: st.size });
        } catch {}
      }
    }
  })(root, 0);
  return { label, root, files };
}

function findVault() {
  if (cfg.vaultPath && cfg.vaultPath !== "auto") return cfg.vaultPath;
  const roots = (cfg.vaultSearchRoots || []).filter(Boolean);
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    (function walk(d, depth) {
      if (depth > 4) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isDirectory() && e.name === ".obsidian")) {
        hits.push(d);
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "#recycle" && e.name !== "@eaDir") {
          walk(join(d, e.name), depth + 1);
        }
      }
    })(root, 0);
  }
  // A vault backup also contains a .obsidian folder. Never write today's brief into one.
  const live = hits.filter((h) => !/backup|archive|snapshot|\.trash/i.test(h));
  const pick = live[0] || null;
  if (hits.length > 1) {
    console.log(
      `Vault candidates: ${hits.join(" | ")} -> using ${pick || "NONE (all look like backups; set vaultPath in config.json)"}`
    );
  }
  return pick;
}

// ---------- modes ----------

async function collect() {
  const vault = findVault();
  const watch = (cfg.watchPaths || []).filter((w) => w && w.path).map((w) => recentFiles(w.path, w.label || "watched"));

  const digest = {
    generated_at: new Date().toISOString(),
    machine: cfg.machine || hostname(),
    lookback_hours: HOURS,
    git: gitActivity(),
    claude_code_sessions: claudeSessions(),
    codex_sessions: codexSessions(),
    watched_paths: watch,
    obsidian_vault_activity: vault ? recentFiles(vault, "obsidian-vault") : { note: "vault not found" },
    vault_path_resolved: vault,
  };

  const json = JSON.stringify(digest);
  if (MODE === "dry-run") {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }

  await d1("INSERT INTO daily_digest (digest_date, machine, payload) VALUES (?, ?, ?)", [today, digest.machine, json]);
  console.log(
    `Digest uploaded for ${today}: ${digest.git.length} active repos, ${digest.claude_code_sessions.length} Claude sessions, ${json.length} bytes.`
  );
}

async function fetchBrief() {
  const vault = findVault();
  if (!vault) throw new Error("Obsidian vault not found. Set vaultPath in config.json.");

  // Pull unfetched briefs (up to 3 per run), not just today's, so a missed run self-heals.
  const r = await d1("SELECT id, brief_date, markdown FROM daily_brief WHERE fetched_at IS NULL ORDER BY id DESC LIMIT 3");
  if (!r.results.length) {
    console.log("No new brief to fetch.");
    return;
  }

  for (const row of r.results) {
    const dir = join(vault, cfg.briefFolder || "daily-briefs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${row.brief_date}-daily-brief.md`);
    writeFileSync(file, row.markdown, "utf8");
    await d1("UPDATE daily_brief SET fetched_at = datetime('now') WHERE id = ?", [String(row.id)]);
    console.log(`Brief written: ${file}`);
  }
}

if (MODE === "--help" || MODE === "-h" || MODE === "help") {
  console.log("Usage: node collect.mjs [collect|fetch-brief|dry-run]");
  process.exit(0);
}

(MODE === "fetch-brief" ? fetchBrief() : collect()).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
