import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { validateBriefDate, writeBriefFile } from "../brief-files.mjs";

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "brief-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault"); mkdirSync(vault);
  return { root, vault };
}
const row = (date = "2026-09-05") => ({ id: 1, brief_date: date, markdown: "Synthetic brief" });

test("rejects traversal, invalid calendar dates and non-string dates before writing", t => {
  const { vault } = fixture(t);
  for (const date of ["../../escaped", "..\\..\\escaped", "/tmp/escape", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "0000-01-01", "2026-1-01", "2026-09-05\n", null, 20260905]) {
    assert.throws(() => writeBriefFile(vault, "daily-briefs", row(date)), /Invalid brief_date/);
  }
  assert.deepEqual(readdirSync(vault), []);
  assert.equal(validateBriefDate("2024-02-29"), "2024-02-29");
});

test("writes and replaces a valid brief atomically with no temporary files left", t => {
  const { vault } = fixture(t);
  const file = writeBriefFile(vault, "notes/briefs", row());
  writeBriefFile(vault, "notes/briefs", { ...row(), markdown: "Updated synthetic brief" });
  assert.equal(readFileSync(file, "utf8"), "Updated synthetic brief");
  assert.deepEqual(readdirSync(dirname(file)), ["2026-09-05-daily-brief.md"]);
});

test("rejects folder traversal and rooted paths", t => {
  const { vault } = fixture(t);
  for (const folder of ["../outside", "a/../../outside", "/outside", "C:\\outside", "C:outside", "a\\..\\outside", ".", "", "a//b"]) {
    assert.throws(() => writeBriefFile(vault, folder, row()), /relative folder/);
  }
  assert.deepEqual(readdirSync(vault), []);
});

test("rejects linked output folders and files without changing their targets", t => {
  const { root, vault } = fixture(t);
  const outside = join(root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(vault, "linked"), "junction");
  assert.throws(() => writeBriefFile(vault, "linked/briefs", row()), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
  const briefDir = join(vault, "briefs"); mkdirSync(briefDir);
  const sentinel = join(outside, "sentinel.md"); writeFileSync(sentinel, "Keep me");
  symlinkSync(sentinel, join(briefDir, "2026-09-05-daily-brief.md"));
  assert.throws(() => writeBriefFile(vault, "briefs", row()), /symlink/);
  assert.equal(readFileSync(sentinel, "utf8"), "Keep me");
});

test("does not follow dangling links or modify another hardlink", t => {
  const { root, vault } = fixture(t);
  const dir = join(vault, "briefs"); mkdirSync(dir);
  const file = join(dir, "2026-09-05-daily-brief.md");
  const outside = join(root, "outside.md");
  symlinkSync(outside, file);
  assert.throws(() => writeBriefFile(vault, "briefs", row()), /symlink/);
  assert.equal(existsSync(outside), false);
  rmSync(file); writeFileSync(outside, "Keep me"); linkSync(outside, file);
  writeBriefFile(vault, "briefs", row());
  assert.equal(readFileSync(outside, "utf8"), "Keep me");
  assert.equal(readFileSync(file, "utf8"), "Synthetic brief");
});

test("failed writes leave existing non-files and unrelated content alone", t => {
  const { vault } = fixture(t);
  const dir = join(vault, "briefs", "2026-09-05-daily-brief.md"); mkdirSync(dir, { recursive: true });
  assert.throws(() => writeBriefFile(vault, "briefs", row()), /non-file/);
  assert.deepEqual(readdirSync(dirname(dir)), ["2026-09-05-daily-brief.md"]);
});

for (const valid of [false, true]) {
  test(`fetch-brief CLI ${valid ? "acknowledges only after the file exists" : "rejects traversal without acknowledging the row"}`, t => {
    const { root, vault } = fixture(t);
    for (const file of ["collect.mjs", "brief-files.mjs"]) cpSync(join(SOURCE, file), join(root, file));
    writeFileSync(join(root, "config.json"), JSON.stringify({ vaultPath: vault, cfAccountId: "synthetic", d1DatabaseId: "synthetic", cfApiToken: "synthetic-token" }));
    const trace = join(root, "queries.jsonl");
    const expected = join(vault, "daily-briefs", "2026-09-05-daily-brief.md");
    const preload = join(root, "mock.mjs");
    writeFileSync(preload, `import {appendFileSync,existsSync} from 'node:fs';
      globalThis.fetch=async(_,opts)=>{const {sql}=JSON.parse(opts.body);
        if(sql.startsWith('UPDATE')&&!existsSync(${JSON.stringify(expected)}))throw Error('acknowledged before write');
        appendFileSync(${JSON.stringify(trace)},JSON.stringify(sql)+'\\n');
        return {json:async()=>({success:true,result:[{results:${JSON.stringify([row(valid ? "2026-09-05" : "../../escaped")])}}]})};};`);
    const env = { ...process.env }; delete env.CF_API_TOKEN; delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(root, "collect.mjs"), "fetch-brief"], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, valid ? 0 : 1, run.stderr);
    if (!valid) assert.match(run.stderr, /Invalid brief_date/);
    const queries = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(queries.filter(sql => sql.startsWith("UPDATE")).length, valid ? 1 : 0);
    assert.equal(existsSync(join(root, "escaped-daily-brief.md")), false);
  });
}
