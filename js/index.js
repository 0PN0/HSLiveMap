/**
 * HSLiveMap backend worker.
 *
 * Replaces the old "GitHub API from the browser" approach with a small API:
 *   GET  /api/markers          -> verified markers (public)
 *   GET  /api/markers/pending  -> pending markers (public, read-only)
 *   GET  /api/markers/adopted  -> "Adopt a Marker" pool: donated waypoints
 *                                 with no photo/comment yet (public, read-only)
 *   POST /api/submit           -> submit a brand-new marker (public, multipart/form-data)
 *   POST /api/adopt            -> claim + fill in one donated waypoint (public, multipart/form-data)
 *   POST /api/admin/approve    -> approve a pending marker (needs X-Admin-Key)
 *   POST /api/admin/reject     -> reject a pending marker (needs X-Admin-Key)
 *   POST /api/admin/edit       -> update a marker's x_ig/y_ig/z_ig (needs X-Admin-Key)
 *   GET  /img/<id>             -> serves an uploaded image
 *
 * Everything else falls through to the static assets binding, exactly like
 * the old assets-only worker did.
 *
 * Storage: everything lives in a single Workers KV namespace (free, no
 * credit card required, unlike R2):
 *   - `marker:<id>` -> marker JSON (metadata only, no image bytes)
 *   - `image:<id>`  -> base64-encoded JPEG bytes for that marker's photo
 *
 * Free-tier KV limits worth knowing: 1GB total storage, 1,000 writes/day,
 * 100,000 reads/day. A submission uses at most 2 writes (marker + image),
 * so this comfortably supports a small/medium community project. If you
 * ever outgrow it, R2 is a drop-in swap for the image half only.
 *
 * ── Marker status lifecycle ──────────────────────────────────────────
 *   "verified" -> live on the public map
 *   "pending"  -> awaiting owner review (visible under "Verified + Pending")
 *   "adopted"  -> a donated waypoint with no image/comment yet, sitting in
 *                 the "Adopt a Marker" pool waiting for someone to claim it
 *
 * Claiming an adopted marker (POST /api/adopt) flips that SAME record's
 * status straight to "pending" (or "verified" if an owner does it) and
 * fills in title/image/comment. It does not create a second copy. The
 * marker's original donor title/image/comment are snapshotted the first
 * time it's claimed (`donorSnapshot`), so that:
 *   - approve  -> status becomes "verified". Gone from Adopt a Marker for good.
 *   - reject   -> title/image/comment reset from donorSnapshot and status
 *                 goes back to "adopted", so it reappears in the pool for
 *                 someone else to try. (The in-game coords, tags, and
 *                 category are never touched by a claim, so nothing is
 *                 lost either way.)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB safety cap (images are resized client-side first)

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { headers: JSON_HEADERS, ...init });
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

async function listMarkers(env, status) {
  const out = [];
  let cursor;
  do {
    const page = await env.MARKERS_KV.list({ prefix: "marker:", cursor });
    cursor = page.cursor;
    for (const key of page.keys) {
      const raw = await env.MARKERS_KV.get(key.name);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        if (!status || m.status === status) out.push(m);
      } catch {
        // skip corrupt entry
      }
    }
    if (page.list_complete) break;
  } while (cursor);
  out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  return out;
}

// Looks a marker up by id. Falls back to a full scan matching on the id
// *inside* the stored JSON in case a KV key ever doesn't exactly match
// `marker:<id>` (e.g. older/migrated entries).
async function findMarkerKeyAndData(env, id) {
  const directKey = `marker:${id}`;
  const raw = await env.MARKERS_KV.get(directKey);
  if (raw) return { key: directKey, marker: JSON.parse(raw) };

  let cursor;
  do {
    const page = await env.MARKERS_KV.list({ prefix: "marker:", cursor });
    cursor = page.cursor;
    for (const k of page.keys) {
      const r = await env.MARKERS_KV.get(k.name);
      if (!r) continue;
      let m;
      try { m = JSON.parse(r); } catch { continue; }
      if (m.id === id || k.name === `marker:${id}` || k.name.slice(7) === id) {
        return { key: k.name, marker: m };
      }
    }
    if (page.list_complete) break;
  } while (cursor);

  return null;
}

async function storeUploadedImage(env, id, file) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Image too large (max 4MB)."), { status: 400 });
  }
  const buf = await file.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  await env.MARKERS_KV.put(`image:${id}`, base64);
  return `/img/${id}`;
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
    try {
      image = await storeUploadedImage(env, id, file);
      hasStoredImage = true;
    } catch (err) {
      return json({ error: err.message }, { status: err.status || 500 });
    }
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

  await env.MARKERS_KV.put(`marker:${id}`, JSON.stringify(marker));
  return json({ ok: true, id, status: marker.status, hasStoredImage });
}

// Claim + fill in one marker from the "Adopt a Marker" pool. Mutates the
// SAME record in place (no duplicate KV entry) so approve/reject can act
// on it directly through the normal admin endpoints below.
async function handleAdopt(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const form = await request.formData();
  const id = (form.get("id") || "").toString().trim();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const found = await findMarkerKeyAndData(env, id);
  if (!found) return json({ error: `Marker not found (id: "${id}").` }, { status: 404 });
  const { key, marker } = found;
  if (!marker.id) marker.id = id;

  if (marker.status !== "adopted") {
    return json({ error: "This marker isn't available to adopt anymore." }, { status: 409 });
  }

  const title = (form.get("title") || "").toString().trim();
  const comment = (form.get("comment") || "").toString().trim();
  const imageUrl = (form.get("imageUrl") || "").toString().trim();
  const file = form.get("image");

  if (!title) return json({ error: "Title is required." }, { status: 400 });

  // Snapshot the donor's original text once, so a later rejection can put
  // it back exactly as it was.
  if (!marker.donorSnapshot) {
    marker.donorSnapshot = {
      title: marker.title,
      image: marker.image || "",
      comment: marker.comment || "",
    };
  }

  let image = marker.image || "";
  if (imageUrl) image = imageUrl;
  if (file && typeof file === "object" && file.size > 0) {
    try {
      image = await storeUploadedImage(env, marker.id, file);
    } catch (err) {
      return json({ error: err.message }, { status: err.status || 500 });
    }
  }

  const admin = isAdmin(request, env);
  marker.title = title;
  marker.comment = comment;
  marker.image = image;
  marker.status = admin ? "verified" : "pending";
  marker.submittedAt = Date.now();

  await env.MARKERS_KV.put(key, JSON.stringify(marker));
  return json({ ok: true, id: marker.id, status: marker.status });
}

async function handleAdminAction(request, env, action) {
  if (!isAdmin(request, env)) return json({ error: "Bad admin key." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const found = await findMarkerKeyAndData(env, id);
  if (!found) return json({ error: "Marker not found." }, { status: 404 });
  const { key, marker } = found;

  if (action === "approve") {
    marker.status = "verified";
    await env.MARKERS_KV.put(key, JSON.stringify(marker));
    return json({ ok: true });
  }

  if (action === "reject") {
    if (marker.donorSnapshot) {
      // This came from Adopt a Marker — restore it to the pool instead of
      // deleting it, so it's available for someone else to try.
      marker.title = marker.donorSnapshot.title;
      marker.image = marker.donorSnapshot.image;
      marker.comment = marker.donorSnapshot.comment;
      marker.status = "adopted";
      await env.MARKERS_KV.put(key, JSON.stringify(marker));
      return json({ ok: true, restoredToAdoptPool: true });
    }

    await env.MARKERS_KV.delete(key);
    if (marker.image && marker.image.startsWith("/img/")) {
      await env.MARKERS_KV.delete(`image:${marker.id || id}`);
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

async function handleAdminEdit(request, env) {
  if (!isAdmin(request, env)) return json({ error: "Bad admin key." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const found = await findMarkerKeyAndData(env, id);
  if (!found) return json({ error: `Marker not found (id: "${id}").` }, { status: 404 });
  const { key, marker } = found;
  if (!marker.id) marker.id = id; // backfill so future lookups hit the fast path

  if ("x_ig" in body) marker.x_ig = numOrNull(body.x_ig);
  if ("y_ig" in body) marker.y_ig = numOrNull(body.y_ig);
  if ("z_ig" in body) marker.z_ig = numOrNull(body.z_ig);
  // Optional: the client recomputes the map-pixel position from the new
  // in-game X/Z (inverse of the calibration fit) and sends it along so the
  // pin actually moves, not just its label.
  if (body.x !== undefined && body.x !== null && Number.isFinite(Number(body.x))) marker.x = Number(body.x);
  if (body.y !== undefined && body.y !== null && Number.isFinite(Number(body.y))) marker.y = Number(body.y);

  await env.MARKERS_KV.put(key, JSON.stringify(marker));
  return json({ ok: true, marker });
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
