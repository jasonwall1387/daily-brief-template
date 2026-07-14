-- Daily Brief - Cloudflare D1 schema.
--
-- Apply with wrangler:
--   npx wrangler d1 create daily-brief
--   npx wrangler d1 execute daily-brief --remote --file=./schema.sql
--
-- Or paste it into the D1 console in the Cloudflare dashboard.

-- Written by the LOCAL collector every morning. One row per machine per day.
CREATE TABLE IF NOT EXISTS daily_digest (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date TEXT NOT NULL,               -- YYYY-MM-DD in your local timezone
  machine     TEXT NOT NULL,               -- so several machines can report into one brief
  payload     TEXT NOT NULL,               -- the digest JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_daily_digest_date ON daily_digest(digest_date);

-- Written by the CLOUD run (the Claude scheduled task). Read back by the local fetcher.
CREATE TABLE IF NOT EXISTS daily_brief (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_date TEXT NOT NULL,                -- YYYY-MM-DD
  markdown   TEXT NOT NULL,                -- the full brief, written into your vault as-is
  summary    TEXT,                         -- the TL;DR, carried by the push notification
  todos      TEXT,                         -- JSON array of today's checklist items
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fetched_at TEXT                          -- NULL until the local fetcher pulls it down
);
CREATE INDEX IF NOT EXISTS idx_daily_brief_date ON daily_brief(brief_date);
