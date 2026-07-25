#!/usr/bin/env node
/**
 * Bulk-import the donated waypoints in data/markers/foin/*.json into the
 * "Adopt a Marker" pool in KV.
 *
 * Each source file is an array of markers shaped like:
 *   { title, category, tags, x, y, image: "", comment: "X, Y, Z" }
 * where `comment` is just the donor's in-game X, Y (height), Z as plain
 * text — nothing else. This script:
 *
 *   1. Parses that "X, Y, Z" text into real x_ig/y_ig/z_ig fields.
 *   2. Assigns each marker a stable id.
 *   3. Sets status: "adopted" so it shows up under the new "Adopt a
 *      Marker" tab instead of the normal verified/pending lists.
 *   4. Blanks out `comment` and `image` (that's the whole point — someone
 *      still needs to fill those in) and stores a `donorSnapshot` so a
 *      rejected adoption can be reset back to this exact starting state.
 *
 * Usage:
 *   node scripts/migrate-foin.mjs
 *   wrangler kv bulk put foin-bulk.json --binding=MARKERS_KV --remote
 *
 * Safe to re-run: ids are derived from the region + title + index, so
 * re-running against the same source files produces the same ids and
 * `wrangler kv bulk put` will just overwrite them (as long as they haven't
 * already been claimed — see the warning below).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";

const SRC_DIR = "data/markers/foin";
const OUT_FILE = "foin-bulk.json";

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

const bulk = [];
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
      ? `${titleSlug}-${String(i + 1).padStart(3, "0")}`
      : `${region}-${titleSlug}-${String(i + 1).padStart(3, "0")}`;
    const marker = {
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
    bulk.push({ key: `marker:${id}`, value: JSON.stringify(marker) });
  });

  console.log(`${file}: ${raw.length} marker(s) -> tagged "${region}"`);
}

writeFileSync(OUT_FILE, JSON.stringify(bulk, null, 2));
console.log(`\nWrote ${bulk.length} marker(s) from ${files.length} file(s) to ${OUT_FILE}.`);
if (unparsed) {
  console.log(`${unparsed} entr${unparsed === 1 ? "y" : "ies"} had a comment that wasn't a plain "x, y, z" and got null in-game coords — check those manually before/after import.`);
}
console.log(`\nNext: wrangler kv bulk put ${OUT_FILE} --binding=MARKERS_KV --remote`);
console.log(`Warning: this always regenerates ids from scratch. Re-uploading after people have already started claiming these will stomp their in-progress claims back to "adopted". Only run this once per region file, right before its first upload.`);
