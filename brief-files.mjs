// D1/model output is untrusted. Only dated briefs may cross into the local vault.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";

export function validateBriefDate(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid brief_date: expected a calendar date in YYYY-MM-DD format.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid brief_date: expected a calendar date in YYYY-MM-DD format.");
  }
  return value;
}

function info(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function requireContained(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Brief output must stay inside the configured vault.");
  }
}

function checkTarget(file) {
  const stat = info(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error("Brief output cannot replace a symlink or a non-file.");
  }
}

export function writeBriefFile(vault, folder = "daily-briefs", row) {
  const date = validateBriefDate(row.brief_date);
  if (typeof row.markdown !== "string") throw new Error("Brief markdown must be text.");
  // Accept nested relative folders on either platform, but never traversal/rooted paths.
  if (typeof folder !== "string" || isAbsolute(folder) || win32.isAbsolute(folder) || folder.includes(":")) {
    throw new Error("briefFolder must be a relative folder inside the vault.");
  }
  const parts = folder.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("briefFolder must be a relative folder inside the vault.");
  }
  // The explicitly configured vault may itself be a link (for example a synced folder).
  // Below that trusted root, reject links rather than following them out of the vault.
  const root = realpathSync(vault);
  if (!lstatSync(root).isDirectory()) throw new Error("The configured vault must be a directory.");
  const dir = resolve(root, ...parts);
  requireContained(root, dir);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!info(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Brief folders must be directories, not symlinks.");
    }
  }
  const file = join(dir, `${date}-daily-brief.md`);
  requireContained(dir, file);
  checkTarget(file);
  const temporary = join(dir, `.${date}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, row.markdown, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    checkTarget(file);
    // Same-directory rename avoids partial notes and does not modify a hardlink's target.
    renameSync(temporary, file);
    return file;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
