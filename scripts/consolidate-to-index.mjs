#!/usr/bin/env node
/**
 * One-time migration: consolidates every existing `marker:<id>` KV entry
 * (135+ of them, from the old one-key-per-marker design, including
 * verified/pending markers and anything already imported by
 * migrate-foin.mjs with status "adopted") into a single `markers:index`
 * key — id -> marker — which is what the updated worker/index.js now
 * reads and writes instead of one KV key per marker.
 *
 * Why this has to run locally instead of as a Worker request: Cloudflare
 * caps subrequests at 50 per Worker invocation on the free plan. Reading
 * 135+ individual `marker:<id>` keys in one invocation is exactly what
 * was breaking /api/markers before. This script runs as a plain Node
 * process via the wrangler CLI, so it isn't subject to that limit — it
 * just takes a little while, calling `wrangler kv key get` once per key.
 *
 * This does NOT delete the old marker:<id> keys — they're left alone as
 * an inert backup. The new worker simply stops reading them.
 *
 * Safe to re-run: it only reads existing marker:<id> keys and produces a
 * fresh markers:index; nothing is deleted. Re-running later (e.g. after
 * adding more markers some other way, or if a fresh export is helpful for
 * a backup) just regenerates the file from whatever marker:<id> keys
 * exist at that moment.
 *
 * If markers:index already has entries in KV (e.g. you already deployed
 * the new worker and someone submitted a marker in the meantime), this
 * script will NOT touch KV directly — it just writes a local file. Merge
 * it with whatever's already in KV before uploading, or upload right
 * away if `markers:index` doesn't exist yet / is still empty.
 *
 * Usage:
 *   node scripts/consolidate-to-index.mjs
 *   wrangler kv key put markers:index --binding=MARKERS_KV --remote --path=markers-index.json
 *
 * (If your wrangler version predates the `kv key` subcommand rename,
 * substitute `kv:key list` / `kv:key get` / `kv:key put` below.)
 */
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";

const OUT_FILE = "markers-index.json";

function wrangler(args) {
  return execFileSync("wrangler", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

console.error("Listing marker:* keys in MARKERS_KV…");
const listRaw = wrangler(["kv", "key", "list", "--binding=MARKERS_KV", "--remote", "--prefix=marker:"]);
const keys = JSON.parse(listRaw).map((k) => k.name);
console.error(`Found ${keys.length} marker key(s).`);

if (!keys.length) {
  console.error("Nothing to migrate — no marker:* keys found. (Already migrated?)");
  process.exit(0);
}

const index = {};
let ok = 0;
let bad = 0;

for (const key of keys) {
  try {
    const raw = wrangler(["kv", "key", "get", key, "--binding=MARKERS_KV", "--remote"]);
    const marker = JSON.parse(raw);
    const id = marker.id || key.slice("marker:".length);
    index[id] = marker;
    ok++;
  } catch (err) {
    bad++;
    console.error(`  ! Couldn't read/parse ${key}: ${err.message}`);
  }
  if (ok % 20 === 0) console.error(`  …${ok}/${keys.length}`);
}

writeFileSync(OUT_FILE, JSON.stringify(index));

console.error(`\nConsolidated ${ok} marker(s)${bad ? `, ${bad} failed (see above — fix those manually in KV afterward if needed)` : ""}.`);
console.error(`Wrote ${OUT_FILE}.`);
console.error(`\nNext:`);
console.error(`  wrangler kv key put markers:index --binding=MARKERS_KV --remote --path=${OUT_FILE}`);
console.error(`\nThen deploy the updated worker/index.js (wrangler deploy) so it starts reading from`);
console.error(`markers:index. The old marker:<id> keys are left in place untouched as a backup.`);
