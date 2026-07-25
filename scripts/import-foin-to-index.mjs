#!/usr/bin/env node
/**
 * Bulk-import donated waypoints from data/markers/foin/*.json directly
 * into the single `markers:index` KV key, as status: "adopted" entries.
 *
 * This replaces migrate-foin.mjs. That script wrote one `marker:<id>`
 * KV key per marker (the old one-key-per-marker design) — but
 * worker/index.js no longer reads that shape at all; it only ever reads
 * and writes the single `markers:index` key (see consolidate-to-index.mjs
 * and the big comment at the top of worker/index.js). Producing hundreds
 * of individual keys is both pointless now and reintroduces the exact
 * subrequest-limit problem that motivated the markers:index redesign.
 *
 * Each source file (data/markers/foin/<region>.json) is an array shaped
 * like:
 *   { title, category, tags, x, y, image: "", comment: "X, Y, Z" }
 * where `comment` is just the donor's in-game X, Y (height), Z as plain
 * text. This script:
 *
 *   1. Parses "X, Y, Z" out of `comment` into real x_ig/y_ig/z_ig fields.
 *   2. Assigns each marker a stable id (region-prefixed, deduped against
 *      the title if the title's already region-prefixed — no more
 *      redundant double-suffix ids).
 *   3. Sets status: "adopted" so it shows up under "Adopt a Marker"
 *      instead of the normal verified/pending lists.
 *   4. Blanks out `comment` and `image` (someone still needs to fill
 *      those in when they adopt it) and stores a `donorSnapshot` so a
 *      later reject-after-adopt can restore this exact starting state,
 *      matching handleAdminAction's "reject" branch in worker/index.js.
 *   5. MERGES into whatever markers:index already exists in the live KV
 *      (fetched via `wrangler kv key get`) rather than blindly
 *      overwriting it, and by default never clobbers an id that's
 *      already present — so re-running this after someone has started
 *      claiming waypoints won't stomp their in-progress claim back to
 *      "adopted". Pass --force to override that and reseed anyway.
 *   6. Writes ONE merged JSON file, ready for exactly one
 *      `wrangler kv key put markers:index` call — one write, not
 *      one-per-marker, same principle as consolidate-to-index.mjs.
 *
 * Usage:
 *   node scripts/import-foin-to-index.mjs [--force]
 *   wrangler kv key put markers:index --binding=MARKERS_KV --remote --path=merged-index.json
 *
 * Run this from the repo root (needs data/markers/foin/ to exist) with
 * wrangler already authenticated against the right account.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, basename } from "path";

const SRC_DIR = "data/markers/foin";
const OUT_FILE = "merged-index.json";
const FORCE = process.argv.includes("--force");

function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "marker"
  );
}

function parseCommentXYZ(comment) {
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(comment || "");
  if (!m) return null;
  return { x_ig: Number(m[1]), y_ig: Number(m[2]), z_ig: Number(m[3]) };
}

if (!existsSync(SRC_DIR)) {
  console.error(`Couldn't find ${SRC_DIR} — run this from the repo root.`);
  process.exit(1);
}

const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error(`No .json files found in ${SRC_DIR}`);
  process.exit(1);
}

// ── pull whatever's already live in markers:index, so we merge instead
//    of clobbering anything (verified/pending markers, or foin waypoints
//    someone already adopted) ──────────────────────────────────────────
let existingIndex = {};
try {
  const raw = execFileSync(
    "wrangler",
    ["kv", "key", "get", "markers:index", "--binding=MARKERS_KV", "--remote"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
  );
  existingIndex = raw.trim() ? JSON.parse(raw) : {};
  console.error(`Fetched existing markers:index — ${Object.keys(existingIndex).length} marker(s) already live.`);
} catch (err) {
  console.error("No existing markers:index found (or KV empty) — starting fresh.");
}

const index = { ...existingIndex };
let added = 0;
let skippedExisting = 0;
let unparsed = 0;

for (const file of files) {
  const region = basename(file, ".json");
  const raw = JSON.parse(readFileSync(join(SRC_DIR, file), "utf8"));

  raw.forEach((entry, i) => {
    const coords = parseCommentXYZ(entry.comment);
    if (!coords) {
      unparsed++;
      console.warn(`  ! Couldn't parse "x, y, z" from comment in ${file}[${i}] ("${entry.title}"): "${entry.comment}"`);
    }

    const titleSlug = slugify(entry.title);
    const id = titleSlug.startsWith(`${region}-`)
      ? titleSlug
      : `${region}-${titleSlug}-${String(i + 1).padStart(3, "0")}`;

    if (index[id] && !FORCE) {
      skippedExisting++;
      return;
    }

    index[id] = {
      id,
      title: entry.title,
      category: entry.category || "other",
      tags: entry.tags && entry.tags.length ? entry.tags : [region],
      x: entry.x,
      y: entry.y,
      x_ig: coords ? coords.x_ig : null,
      y_ig: coords ? coords.y_ig : null,
      z_ig: coords ? coords.z_ig : null,
      image: "",
      comment: "",
      status: "adopted",
      donorSnapshot: { title: entry.title, image: "", comment: "" },
      submittedAt: Date.now(),
    };
    added++;
  });

  console.log(`${file}: ${raw.length} marker(s) -> tagged "${region}"`);
}

writeFileSync(OUT_FILE, JSON.stringify(index));

console.log(`\nAdded ${added} marker(s).`);
if (skippedExisting) {
  console.log(`Skipped ${skippedExisting} that already existed in markers:index (pass --force to overwrite them).`);
}
if (unparsed) {
  console.log(`${unparsed} entr${unparsed === 1 ? "y" : "ies"} had a comment that wasn't a plain "x, y, z" and got null in-game coords — check those manually.`);
}
console.log(`Wrote ${Object.keys(index).length} total marker(s) to ${OUT_FILE}.`);
console.log(`\nNext (single write, not one-per-marker):`);
console.log(`  wrangler kv key put markers:index --binding=MARKERS_KV --remote --path=${OUT_FILE}`);
