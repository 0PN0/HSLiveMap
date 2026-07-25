/**
 * HSLiveMap backend worker.
 *
 * Replaces the old "GitHub API from the browser" approach with a small API:
 *   GET  /api/markers          -> verified markers (public)
 *   GET  /api/markers/pending  -> pending markers (public, read-only)
 *   POST /api/submit           -> submit a new marker (public, multipart/form-data)
 *   POST /api/admin/approve    -> approve a pending marker (needs X-Admin-Key)
 *   POST /api/admin/reject     -> reject/delete a marker (needs X-Admin-Key)
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

  await env.MARKERS_KV.put(`marker:${id}`, JSON.stringify(marker));
  return json({ ok: true, id, status: marker.status, hasStoredImage });
}

async function handleAdminAction(request, env, action) {
  if (!isAdmin(request, env)) return json({ error: "Bad admin key." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const id = (body.id || "").toString();
  if (!id) return json({ error: "Missing id." }, { status: 400 });

  const key = `marker:${id}`;
  const raw = await env.MARKERS_KV.get(key);
  if (!raw) return json({ error: "Marker not found." }, { status: 404 });
  const marker = JSON.parse(raw);

  if (action === "approve") {
    marker.status = "verified";
    await env.MARKERS_KV.put(key, JSON.stringify(marker));
    return json({ ok: true });
  }

  if (action === "reject") {
    await env.MARKERS_KV.delete(key);
    if (marker.image && marker.image.startsWith("/img/")) {
      await env.MARKERS_KV.delete(`image:${id}`);
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

  const key = `marker:${id}`;
  const raw = await env.MARKERS_KV.get(key);
  if (!raw) return json({ error: "Marker not found." }, { status: 404 });
  const marker = JSON.parse(raw);

  if ("x_ig" in body) marker.x_ig = numOrNull(body.x_ig);
  if ("y_ig" in body) marker.y_ig = numOrNull(body.y_ig);
  if ("z_ig" in body) marker.z_ig = numOrNull(body.z_ig);

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

      if (pathname === "/api/submit" && request.method === "POST") {
        return await handleSubmit(request, env);
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
