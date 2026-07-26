/**
 * HSLiveMap backend worker.
 *
 * Replaces the old "GitHub API from the browser" approach with a small API:
 *   GET  /api/markers          -> verified markers (public)
 *   GET  /api/markers/pending  -> pending markers (public, read-only)
 *   GET  /api/markers/adopted  -> donated waypoints waiting to be claimed (public, read-only)
 *   POST /api/submit           -> submit a new marker (public, multipart/form-data)
 *   POST /api/adopt            -> claim a donated waypoint (public, multipart/form-data)
 *   POST /api/admin/verify     -> checks whether an X-Admin-Key is valid
 *   POST /api/admin/approve    -> approve a pending marker (needs X-Admin-Key)
 *   POST /api/admin/reject     -> reject a marker (needs X-Admin-Key) — restores
 *                                 claimed adoptions back to "adopted" instead of
 *                                 deleting them outright, using their donorSnapshot
 *   POST /api/admin/delete     -> permanently delete a marker of any status
 *                                 (needs X-Admin-Key) — unlike reject, this never
 *                                 restores a claimed adoption; it's just gone
 *   POST /api/admin/edit       -> edit a marker's in-game X/Y/Z (needs X-Admin-Key)
 *   GET  /img/<id>             -> serves an uploaded image
 *
 * Everything else falls through to the static assets binding, exactly like
 * the old assets-only worker did.
 *
 * Storage: everything lives in a single Workers KV namespace (free, no
 * credit card required, unlike R2):
 *   - `markers:index` -> ONE JSON object of every marker, keyed by id
 *     (metadata only, no image bytes)
 *   - `image:<id>`    -> base64-encoded JPEG bytes for that marker's photo
 *
 * Why a single index key instead of one `marker:<id>` key per marker (the
 * old design): listing markers means reading every marker. Workers KV's
 * list() only returns key NAMES, not values, so the old listMarkers() had
 * to call KV.get() once per marker to build the page. Cloudflare caps
 * subrequests at 50 per invocation on the free plan (1000 on paid) — with
 * 135+ markers in just one region, a single hit to /api/markers blew past
 * that and failed with "Too many API requests by single Worker
 * invocation". Storing all markers as one JSON object under `markers:index`
 * makes listing (and every write) cost exactly one KV read (+ one write for
 * writes), no matter how many markers exist. A single KV value can hold up
 * to 25MB, so this comfortably scales to many thousands of markers before
 * it'd need revisiting.
 *
 * Trade-off worth knowing: reads/writes to the index are last-write-wins,
 * so two admin actions (e.g. two approvals) landing in the same instant
 * could in theory clobber each other. For a small community's submission
 * volume this is very unlikely to matter in practice, but it's a real
 * difference from the old one-key-per-marker design, which had no such
 * collision.
 *
 * Free-tier KV limits worth knowing: 1GB total storage, 1,000 writes/day,
 * 100,000 reads/day. A submission uses at most 2 writes (index + image),
 * so this comfortably supports a small/medium community project. If you
 * ever outgrow it, R2 is a drop-in swap for the image half only.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB safety cap (images are resized client-side first)
const INDEX_KEY = "markers:index";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { headers: JSON_HEADERS, ...init });
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

function slugify(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "marker"
  );
}

// Parses an optional numeric form field ("" or missing -> null instead of NaN)
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = v.toString().trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── single-key marker index ──────────────────────────────────────────────
async function loadIndex(env) {
  const raw = await env.MARKERS_KV.get(INDEX_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt index would otherwise wipe every marker on the next save —
    // fail loud instead of silently starting from empty.
    throw new Error("markers:index is corrupt — refusing to overwrite it. Check KV manually.");
  }
}

async function saveIndex(env, index) {
  await env.MARKERS_KV.put(INDEX_KEY, JSON.stringify(index));
}

async function listMarkers(env, status) {
  const index = await loadIndex(env);
  const out = Object.values(index).filter((m) => !status || m.status === status);
  out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return out;
}

async function handleSubmit(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const form = await request.formData();
  const title = (form.get("title") || "").toString().trim();
  const category = (form.get("category") || "other").toString().trim();
  const comment = (form.get("comment") || "").toString().trim();
  const x = Number(form.get("x"));
  const y = Number(form.get("y"));
  const x_ig = numOrNull(form.get("x_ig"));
  const y_ig = numOrNull(form.get("y_ig"));
  const z_ig = numOrNull(form.get("z_ig"));
  const tags = (form.get("tags") || "")
    .toString()
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const imageUrl = (form.get("imageUrl") || "").toString().trim();
  const file = form.get("image");

  if (!title) return json({ error: "Title is required." }, { status: 400 });
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return json({ error: "Missing marker coordinates." }, { status: 400 });
  }

  const id = `${slugify(title)}-${Date.now().toString(36).slice(-5)}`;
  let image = imageUrl;
  let hasStoredImage = false;

  if (file && typeof file === "object" && file.size > 0) {
    if (file.size > MAX_IMAGE_BYTES) {
      return json({ error: "Image too large (max 4MB)." }, { status: 400 });
    }
    const buf = await file.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    await env.MARKERS_KV.put(`image:${id}`, base64);
    image = `/img/${id}`;
    hasStoredImage = true;
  }

  const admin = isAdmin(request, env);
  const marker = {
    id,
    title,
    category,
    tags,
    x,
    y,
    x_ig,
    y_ig,
    z_ig,
    image,
    comment,
    status: admin ? "verified" : "pending",
    submittedAt: Date.now(),
  };

  const index = await loadIndex(env);
  index[id] = marker;
  await saveIndex(env, index);

  return json({ ok: true, id, status: marker.status, hasStoredImage });
}

// Claiming a donated ("adopted") waypoint: same shape as a fresh submission,
// but it fills in an existing marker record (found by id) instead of
// creating a new one, and only markers currently in the "adopted" pool are
// eligible.
async function handleAdopt(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const form = await request.formData();
  const id = (form.get("id") || "").toString();
  const title = (form.get("title") || "").toString().trim();
  const comment = (form.get("comment") || "").toString().trim();
  const imageUrl = (form.get("imageUrl") || "").toString().trim();
  const file = form.get("image");

  if (!id) return json({ error: "Missing marker id." }, { status: 400 });
  if (!title) return json({ error: "Title is required." }, { status: 400 });

  const index = await loadIndex(env);
  const marker = index[id];
  if (!marker) return json({ error: "Marker not found." }, { status: 404 });
  if (marker.status !== "adopted") {
    return json({ error: "That waypoint isn't available to adopt anymore." }, { status: 409 });
  }

  let image = imageUrl;
  let hasStoredImage = false;
  if (file && typeof file === "object" && file.size > 0) {
    if (file.size > MAX_IMAGE_BYTES) {
      return json({ error: "Image too large (max 4MB)." }, { status: 400 });
    }
    const buf = await file.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    await env.MARKERS_KV.put(`image:${id}`, base64);
    image = `/img/${id}`;
    hasStoredImage = true;
  }

  const admin = isAdmin(request, env);
  marker.title = title;
  marker.comment = comment;
  marker.image = image;
  marker.status = admin ? "verified" : "pending";
  marker.submittedAt = Date.now();
  // marker.donorSnapshot is left untouched so a later reject can restore
  // this exact starting state back into the adopt pool.

  index[id] = marker;
  await saveIndex(env, index);

  return json({ ok: true, id, status: marker.status, hasStoredImage });
}

// Owner-only: correct a marker's in-game X/Y/Z, and (if provided) the map
// pixel coordinates the pin should move to so it stays in sync.
async function handleAdminEdit(request, env) {
  if (!isAdmin(request, env)) return json({ error: "Bad admin key." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const index = await loadIndex(env);
  const marker = index[id];
  if (!marker) return json({ error: "Marker not found." }, { status: 404 });

  if ("x_ig" in body) marker.x_ig = body.x_ig;
  if ("y_ig" in body) marker.y_ig = body.y_ig;
  if ("z_ig" in body) marker.z_ig = body.z_ig;
  if (typeof body.x === "number" && Number.isFinite(body.x)) marker.x = body.x;
  if (typeof body.y === "number" && Number.isFinite(body.y)) marker.y = body.y;

  index[id] = marker;
  await saveIndex(env, index);
  return json({ marker });
}

async function handleAdminAction(request, env, action) {
  if (!isAdmin(request, env)) return json({ error: "Bad admin key." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const index = await loadIndex(env);
  const marker = index[id];
  if (!marker) return json({ error: "Marker not found." }, { status: 404 });

  if (action === "approve") {
    marker.status = "verified";
    await saveIndex(env, index);
    return json({ ok: true });
  }

  if (action === "reject") {
    // A claimed donation goes back into the Adopt-a-Marker pool instead of
    // being deleted outright — that's what donorSnapshot is for.
    if (marker.donorSnapshot) {
      index[id] = {
        ...marker,
        title: marker.donorSnapshot.title,
        image: marker.donorSnapshot.image,
        comment: marker.donorSnapshot.comment,
        status: "adopted",
      };
      await saveIndex(env, index);
      if (marker.image && marker.image.startsWith("/img/")) {
        await env.MARKERS_KV.delete(`image:${id}`);
      }
      return json({ ok: true, restored: true });
    }

    delete index[id];
    await saveIndex(env, index);
    if (marker.image && marker.image.startsWith("/img/")) {
      await env.MARKERS_KV.delete(`image:${id}`);
    }
    return json({ ok: true });
  }

  if (action === "delete") {
    // Hard delete: unlike "reject", this never restores a claimed adoption
    // back into the Adopt-a-Marker pool — it just removes the marker
    // outright, whatever its status (verified, pending, or adopted).
    delete index[id];
    await saveIndex(env, index);
    if (marker.image && marker.image.startsWith("/img/")) {
      await env.MARKERS_KV.delete(`image:${id}`);
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

async function handleImage(env, id) {
  const base64 = await env.MARKERS_KV.get(`image:${id}`);
  if (!base64) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(base64, "base64");
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/debug/env") {
      return json({ bindingKeys: Object.keys(env) });
    }
        
    try {
      if (pathname === "/api/markers" && request.method === "GET") {
        const markers = await listMarkers(env, "verified");
        return json(markers, { headers: { ...JSON_HEADERS, "cache-control": "public, max-age=15" } });
      }

      if (pathname === "/api/markers/pending" && request.method === "GET") {
        const markers = await listMarkers(env, "pending");
        return json(markers, { headers: { ...JSON_HEADERS, "cache-control": "no-store" } });
      }

      if (pathname === "/api/markers/adopted" && request.method === "GET") {
        const markers = await listMarkers(env, "adopted");
        return json(markers, { headers: { ...JSON_HEADERS, "cache-control": "public, max-age=15" } });
      }

      if (pathname === "/api/submit" && request.method === "POST") {
        return await handleSubmit(request, env);
      }

      if (pathname === "/api/adopt" && request.method === "POST") {
        return await handleAdopt(request, env);
      }

      if (pathname === "/api/admin/verify" && request.method === "POST") {
        return json({ ok: isAdmin(request, env) });
      }

      if (pathname === "/api/admin/approve" && request.method === "POST") {
        return await handleAdminAction(request, env, "approve");
      }

      if (pathname === "/api/admin/reject" && request.method === "POST") {
        return await handleAdminAction(request, env, "reject");
      }

      if (pathname === "/api/admin/delete" && request.method === "POST") {
        return await handleAdminAction(request, env, "delete");
      }

      if (pathname === "/api/admin/edit" && request.method === "POST") {
        return await handleAdminEdit(request, env);
      }

      if (pathname.startsWith("/img/") && request.method === "GET") {
        return await handleImage(env, pathname.replace(/^\/img\//, ""));
      }
    } catch (err) {
      return json({ error: err.message || "Server error" }, { status: 500 });
    }

    // Everything else: serve the static site (index.html, css, js, data/tiles.json, etc.)
    return env.ASSETS.fetch(request);
  },
};
