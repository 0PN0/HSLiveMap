/* global L */
(() => {
  // ── status toast ─────────────────────────────────────────────────────
  const toastEl = document.getElementById("status-toast");
  let toastTimer;
  function toast(msg, ms = 3500) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ── completion tracking (per-browser, local only — not shared) ──────
  const DONE_KEY = "map-explorer:completed";
  function loadDoneSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY)) || []); }
    catch { return new Set(); }
  }
  const doneSet = loadDoneSet();
  function saveDoneSet() {
    localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet]));
  }
  function isDone(id) { return doneSet.has(id); }
  function setDone(id, val) {
    if (val) doneSet.add(id); else doneSet.delete(id);
    saveDoneSet();
  }

  // registry of every rendered marker so bulk actions can find them: id -> { marker, data }
  const registry = new Map();
  // reverse lookup so popup-level features (instant-complete) can find an id from a Leaflet marker
  const markerToId = new Map();

  // ── known regions (special tags — always listed even with 0 markers yet) ─
  // Add new region names here as they're introduced; everything else typed
  // into the "tags" field just becomes a normal filterable tag.
  const REGION_TAGS = [
    "seaglass village",
    "seabreak cove",
    "blackfen",
    "thornvale",
    "glacaris",
    "solmara",
    "the hollow",
  ];

  // ── sidebar filter / appearance settings (persisted) ─────────────────
  const SETTINGS_KEY = "map-explorer:ui-settings";
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      return {
        theme: ["light", "eastern", "royal", "plasma"].includes(s.theme) ? s.theme : "dark",
        instantComplete: !!s.instantComplete,
        showDone: s.showDone !== false,
        showNotDone: s.showNotDone !== false,
        regions: s.regions && typeof s.regions === "object" ? s.regions : {},
        tags: s.tags && typeof s.tags === "object" ? s.tags : {},
      };
    } catch {
      return { theme: "dark", instantComplete: false, showDone: true, showNotDone: true, regions: {}, tags: {} };
    }
  }
  const settings = loadSettings();
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  // default: regions start ON; tags start OFF except "chest"
  function isRegionEnabled(r) {
    return Object.prototype.hasOwnProperty.call(settings.regions, r) ? settings.regions[r] : true;
  }
  function isTagEnabled(t) {
    return Object.prototype.hasOwnProperty.call(settings.tags, t) ? settings.tags[t] : t === "chest";
  }

  // ── custom per-type marker images (persisted, this browser only) ────
  const PIN_IMAGES_KEY = "map-explorer:pin-images";
  function loadPinImages() {
    try { return JSON.parse(localStorage.getItem(PIN_IMAGES_KEY)) || {}; }
    catch { return {}; }
  }
  let pinImages = loadPinImages();
  function savePinImages() {
    localStorage.setItem(PIN_IMAGES_KEY, JSON.stringify(pinImages));
  }
  const STYLE_GROUPS = [
    { key: "chest", label: "Chests" },
    { key: "collectible", label: "Collectibles" },
    { key: "quest", label: "Quest markers" },
    { key: "enemy / boss", label: "Enemies (generic)" },
    { key: "boss", label: "Bosses (tag: boss)" },
    { key: "miniboss", label: "Mini-bosses (tag: miniboss)" },
    { key: "resource / material", label: "Resources / materials" },
    { key: "viewpoint", label: "Viewpoints" },
    { key: "other", label: "Other" },
  ];

  function matchesTag(data, tag) {
    if (!tag) return false;
    const t = tag.trim().toLowerCase();
    if (!t) return false;
    if ((data.category || "").toLowerCase() === t) return true;
    return (data.tags || []).some((x) => (x || "").toLowerCase() === t);
  }

  function refreshMarkerVisual(id) {
    const entry = registry.get(id);
    if (!entry) return;
    const { marker, data, pending } = entry;
    const kind = isDone(id) ? "done" : pending ? "pending" : "verified";
    marker.setIcon(pinIcon(kind, data));
    if (marker.isPopupOpen()) marker.setPopupContent(popupHtml(data, pending, id));
  }

  function refreshAllVisuals() {
    registry.forEach((_entry, id) => refreshMarkerVisual(id));
  }

  // Which style group a marker belongs to for custom-image / built-in glyph
  // purposes: "boss"/"miniboss" tags win over the generic category, since
  // those are the ones players most want to tell apart at a glance.
  function styleGroupFor(data) {
    if (!data) return "other";
    const tags = (data.tags || []).map((t) => (t || "").toLowerCase());
    if (tags.includes("boss")) return "boss";
    if (tags.includes("miniboss") || tags.includes("mini-boss") || tags.includes("mini boss")) return "miniboss";
    return (data.category || "other").toLowerCase();
  }

  function uncompleteWhere(predicate) {
    let count = 0;
    registry.forEach((entry, id) => {
      if (isDone(id) && predicate(entry.data)) {
        setDone(id, false);
        refreshMarkerVisual(id);
        count++;
      }
    });
    updateProgressCount();
    toast(count ? `Uncompleted ${count} waypoint${count === 1 ? "" : "s"}.` : "Nothing matched — no waypoints reset.");
  }

  function updateProgressCount() {
    const total = registry.size;
    const done = [...registry.keys()].filter(isDone).length;
    document.getElementById("progress-count").textContent = `${done} of ${total} completed`;
  }

  function renderTagChips() {
    const wrap = document.getElementById("tag-chip-list");
    const tags = new Set();
    registry.forEach(({ data }) => {
      if (data.category) tags.add(data.category.toLowerCase());
      (data.tags || []).forEach((t) => t && tags.add(t.toLowerCase()));
    });
    wrap.innerHTML = "";
    [...tags].sort().forEach((t) => {
      const b = document.createElement("button");
      b.className = "tag-chip-btn";
      b.textContent = t;
      b.onclick = () => uncompleteWhere((d) => matchesTag(d, t));
      wrap.appendChild(b);
    });
  }

  // ── owner mode: an admin key that unlocks instant publish + the review queue ─
  const ADMIN_KEY = "map-explorer:admin-key";
  const getAdminKey = () => localStorage.getItem(ADMIN_KEY) || "";
  const isOwner = () => !!getAdminKey();
  const adminHeaders = () => ({ "X-Admin-Key": getAdminKey() });

  // ── coordinate helpers ───────────────────────────────────────────────
  // Tiles/markers are authored in "map pixel" space with y increasing
  // downward (like an image). Leaflet's CRS.Simple has lat increasing
  // upward, so we negate y when converting.
  const toLatLng = (x, y) => L.latLng(-y, x);

  // ── map pixel -> in-game X/Z ─────────────────────────────────────────
  // A top-down map click only tells you where something is on the ground
  // plane (in-game X and Z) — it can never tell you height (in-game Y),
  // so that one is always left for a human to fill in.
  // Coefficients below are an affine fit (a*mx + b*my + c) from 3 known
  // calibration pairs of (map x,y) -> (in-game X,Z). Re-derive these if
  // the map tiles/tile scale ever change.
  const GAME_COORD_FIT = {
    x: { a: 116709 / 189205, b: -21 / 37841, c: -397194537 / 189205 },
    z: { a: -27 / 37841, e: 23411 / 37841, c: -64683928 / 37841 },
  };
  function mapToGameXZ(mx, my) {
    const fx = GAME_COORD_FIT.x;
    const fz = GAME_COORD_FIT.z;
    const x_ig = Math.round(fx.a * mx + fx.b * my + fx.c);
    const z_ig = Math.round(fz.a * mx + fz.e * my + fz.c);
    return { x_ig, z_ig };
  }
  // Inverse of the fit above: given in-game X/Z, find the map pixel they
  // came from. Needed so that hand-typed/edited in-game coordinates can
  // actually move the pin, not just relabel it.
  const GAME_COORD_FIT_INV = {
    mx: { p: 117055 / 72204, q: 35 / 24068, r: 81970289 / 24068 },
    my: { s: 45 / 24068, t: 38903 / 24068, u: 66593737 / 24068 },
  };
  function gameXZToMap(x_ig, z_ig) {
    const fmx = GAME_COORD_FIT_INV.mx;
    const fmy = GAME_COORD_FIT_INV.my;
    const mx = Math.round(fmx.p * x_ig + fmx.q * z_ig + fmx.r);
    const my = Math.round(fmy.s * x_ig + fmy.t * z_ig + fmy.u);
    return { mx, my };
  }
  const tileBounds = (t) => L.latLngBounds(toLatLng(t.x, t.y + t.height), toLatLng(t.x + t.width, t.y));

  // ── map setup ────────────────────────────────────────────────────────
  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 4,
    zoomSnap: 0.25,
    attributionControl: false,
    // Markers are direct-child divIcons, so animating them WITH the zoom
    // transform makes the pins themselves visibly stretch/shrink for the
    // whole transition, not just the tiles underneath. Turning this off
    // makes markers pop to their correct size once the zoom settles,
    // instead of scaling continuously and jarringly through it.
    markerZoomAnimation: false,
    // Leaflet's built-in drag-to-pan is a left-button (and single-finger
    // touch) gesture, but left click/tap is reserved for selecting markers
    // here — panning is reimplemented by hand further down, on a held
    // right mouse button (desktop) or a single-finger drag (touch).
    dragging: false,
  });

  const verifiedLayer = L.layerGroup().addTo(map);
  const pendingLayer = L.layerGroup(); // added/removed by the view toggle
  const adoptLayer = L.layerGroup(); // added/removed by the view toggle
  const adoptMarkerData = new Map(); // id -> raw marker data, for opening the adopt modal

  function pinIcon(kind, data) {
    const group = styleGroupFor(data);
    const custom = pinImages[group];
    if (custom) {
      return L.divIcon({
        className: "",
        html: `<div class="pin-custom ${kind}" style="background-image:url('${custom}')"></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 28],
        popupAnchor: [0, -28],
      });
    }
    const groupClass = `group-${group.replace(/[^a-z0-9]+/g, "-")}`;
    return L.divIcon({
      className: "",
      html: `<div class="pin ${kind} ${groupClass}"></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 24],
      popupAnchor: [0, -26],
    });
  }

  // ── load tiles ───────────────────────────────────────────────────────
  async function loadTiles() {
    const res = await fetch("data/tiles.json", { cache: "no-store" });
    const data = await res.json();
    if (!data.tiles || !data.tiles.length) {
      toast("No tiles yet — run calibrate.html and commit data/tiles.json", 6000);
      map.setView([0, 0], -2);
      return;
    }
    let overall = null;
    data.tiles.forEach((t) => {
      const b = tileBounds(t);
      L.imageOverlay(t.file, b).addTo(map);
      overall = overall ? overall.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    });
    map.fitBounds(overall);
    // No setMaxBounds here on purpose — panning is left completely free,
    // no soft or hard limit at the edges.
  }

  // ── marker card popup ────────────────────────────────────────────────
  function popupHtml(m, pending, id) {
    const img = m.image
      ? `<img src="${escapeHtml(m.image)}" alt="" onerror="this.style.display='none'">`
      : "";
    const pendingTag = pending
      ? `<span class="pr-tag">Pending review</span>`
      : "";
    const done = isDone(id);
    const tagChips = (m.tags || []).length
      ? `<div class="tag-chips">${m.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    const ownerActions = pending && isOwner()
      ? `<div class="owner-review-actions">
           <button class="btn primary approve-btn" data-wp-id="${escapeHtml(id)}">Approve</button>
           <button class="btn danger reject-btn" data-wp-id="${escapeHtml(id)}">Reject</button>
         </div>`
      : "";
    const hasIg = m.x_ig != null || m.y_ig != null || m.z_ig != null;
    const igReadout = hasIg
      ? `<p class="ig-coords">In-game: ${m.x_ig ?? "?"}, ${m.y_ig ?? "?"}, ${m.z_ig ?? "?"}</p>`
      : "";
    const igEdit = isOwner()
      ? `<div class="ig-edit-row" style="display:flex; gap:6px; margin-top:6px;">
           <input class="ig-edit-x" type="number" step="1" placeholder="X" value="${m.x_ig ?? ""}" style="flex:1;width:0;" />
           <input class="ig-edit-y" type="number" step="1" placeholder="Y" value="${m.y_ig ?? ""}" style="flex:1;width:0;" />
           <input class="ig-edit-z" type="number" step="1" placeholder="Z" value="${m.z_ig ?? ""}" style="flex:1;width:0;" />
           <button class="btn ig-edit-save" data-wp-id="${escapeHtml(id)}">Save</button>
         </div>`
      : "";
    return `<div class="marker-card ${done ? "done" : ""}">
      ${img}
      <div class="body">
        <div class="cat">${escapeHtml(m.category || "marker")}</div>
        <h3>${escapeHtml(m.title || "Untitled")}</h3>
        <p>${escapeHtml(m.comment || "")}</p>
        ${igReadout}
        ${igEdit}
        ${tagChips}
        ${pendingTag}
        ${ownerActions}
        <button class="complete-toggle ${done ? "is-done" : ""}" data-wp-id="${escapeHtml(id)}">
          ${done ? "✓ Completed — click to undo" : "Mark completed"}
        </button>
        <button class="report-flag" data-wp-id="${escapeHtml(id)}" title="Report a problem with this marker">⚑ Report a problem</button>
      </div>
    </div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── Adopt-a-Marker popup: donated waypoint, no photo/comment yet ─────
  function adoptPopupHtml(m, id) {
    const tagChips = (m.tags || []).length
      ? `<div class="tag-chips">${m.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    return `<div class="marker-card">
      <div class="body">
        <div class="cat">${escapeHtml(m.category || "marker")}</div>
        <h3>${escapeHtml(m.title || "Untitled")}</h3>
        <p class="ig-coords">In-game: ${m.x_ig ?? "?"}, ${m.y_ig ?? "?"}, ${m.z_ig ?? "?"}</p>
        ${tagChips}
        <button class="btn primary adopt-btn" data-wp-id="${escapeHtml(id)}" style="width:100%;margin-top:10px;">Adopt this marker</button>
      </div>
    </div>`;
  }

  // ── verified markers: one fast call to our own API ───────────────────
  async function loadVerifiedMarkers() {
    try {
      const res = await fetch("/api/markers", { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const markers = await res.json();
      verifiedLayer.clearLayers();
      markers.forEach((m) => {
        const id = m.id;
        const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "verified", m) })
          .bindPopup(popupHtml(m, null, id))
          .addTo(verifiedLayer);
        registry.set(id, { marker, data: m, pending: null });
        markerToId.set(marker, id);
      });
      updateProgressCount();
      renderTagChips();
      renderFilterLists();
      applyFilters();
    } catch (e) {
      console.warn("Could not load verified markers", e);
      toast("Couldn't load markers — try refreshing.");
    }
  }

  // ── pending markers: awaiting owner review ───────────────────────────
  let pendingLoaded = false;
  async function loadPendingMarkers() {
    try {
      const res = await fetch("/api/markers/pending", { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const markers = await res.json();
      pendingLayer.clearLayers();
      markers.forEach((m) => {
        const id = m.id;
        const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "pending", m) })
          .bindPopup(popupHtml(m, {}, id))
          .addTo(pendingLayer);
        registry.set(id, { marker, data: m, pending: {} });
        markerToId.set(marker, id);
      });
      pendingLoaded = true;
      updateProgressCount();
      renderTagChips();
      renderFilterLists();
      applyFilters();
    } catch (e) {
      console.warn("Could not load pending markers", e);
      toast("Couldn't load pending submissions.");
    }
  }

  // ── Adopt a Marker: donated waypoints waiting to be claimed ──────────
  let adoptLoaded = false;
  async function loadAdoptedMarkers() {
    try {
      const res = await fetch("/api/markers/adopted", { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const markers = await res.json();
      adoptLayer.clearLayers();
      adoptMarkerData.clear();
      markers.forEach((m) => {
        const id = m.id;
        const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon("adopt", m) })
          .bindPopup(adoptPopupHtml(m, id))
          .addTo(adoptLayer);
        adoptMarkerData.set(id, m);
      });
      adoptLoaded = true;
    } catch (e) {
      console.warn("Could not load the adopt-a-marker pool", e);
      toast("Couldn't load donated waypoints.");
    }
  }

  // ── view toggle ──────────────────────────────────────────────────────
  // "Verified" and "Verified + Pending" always keep the verified layer on;
  // "Adopt a Marker" is its own exclusive view of the donated-waypoint pool.
  document.getElementById("view-toggle").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    map.removeLayer(pendingLayer);
    map.removeLayer(adoptLayer);

    if (btn.dataset.view === "all") {
      toast("Loading pending submissions…", 2000);
      await loadPendingMarkers();
      pendingLayer.addTo(map);
    } else if (btn.dataset.view === "adopt") {
      toast("Loading donated waypoints…", 2000);
      await loadAdoptedMarkers();
      adoptLayer.addTo(map);
    }
  });

  // click "Adopt this marker" inside a pin's popup -> open the adopt modal
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    const btn = container && container.querySelector(".adopt-btn");
    if (!btn) return;
    btn.addEventListener("click", () => openAdoptModal(btn.dataset.wpId));
  });

  const adoptModal = document.getElementById("adopt-modal");
  let currentAdoptId = null;

  function openAdoptModal(id) {
    const m = adoptMarkerData.get(id);
    if (!m) return;
    currentAdoptId = id;
    document.getElementById("adopt-title").value = m.title || "";
    document.getElementById("adopt-comment").value = "";
    document.getElementById("adopt-image").value = "";
    document.getElementById("adopt-photo").value = "";
    document.getElementById("adopt-photo-hint").textContent = "";
    document.getElementById("adopt-hint").textContent = "";
    document.getElementById("adopt-coord-readout").textContent =
      `In-game: ${m.x_ig ?? "?"}, ${m.y_ig ?? "?"}, ${m.z_ig ?? "?"}`;
    map.closePopup();
    adoptModal.classList.add("show");
  }

  document.getElementById("adopt-modal-cancel").onclick = () => adoptModal.classList.remove("show");

  const adoptPhotoInput = document.getElementById("adopt-photo");
  adoptPhotoInput.addEventListener("change", () => {
    const f = adoptPhotoInput.files[0];
    document.getElementById("adopt-photo-hint").textContent = f
      ? `Selected: ${f.name} (${Math.round(f.size / 1024)} KB — will be resized before upload)`
      : "";
  });

  document.getElementById("adopt-modal-submit").onclick = async () => {
    if (!currentAdoptId) return;
    const title = document.getElementById("adopt-title").value.trim();
    const comment = document.getElementById("adopt-comment").value.trim();
    const imageUrl = document.getElementById("adopt-image").value.trim();
    const photoFile = adoptPhotoInput.files[0] || null;
    const hint = document.getElementById("adopt-hint");
    const submitBtn = document.getElementById("adopt-modal-submit");

    if (!title) {
      hint.textContent = "Give it a name first.";
      hint.style.color = "var(--danger)";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    try {
      const form = new FormData();
      form.append("id", currentAdoptId);
      form.append("title", title);
      form.append("comment", comment);
      if (imageUrl) form.append("imageUrl", imageUrl);
      if (photoFile) {
        toast("Resizing photo…", 2000);
        const resized = await resizeImage(photoFile);
        form.append("image", resized, "photo.jpg");
      }

      const res = await fetch("/api/adopt", {
        method: "POST",
        headers: adminHeaders(),
        body: form,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `API ${res.status}`);

      adoptModal.classList.remove("show");
      toast(
        result.status === "verified"
          ? "Published! Reloading the map…"
          : "Submitted for review! It's off the Adopt a Marker list and will show under \"Verified + Pending\" until an admin approves it.",
        6000
      );
      await Promise.all([loadAdoptedMarkers(), loadPendingMarkers(), loadVerifiedMarkers()]);
    } catch (err) {
      console.error(err);
      hint.textContent = `Couldn't submit: ${err.message}`;
      hint.style.color = "var(--danger)";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for review";
    }
  };

  // approve/reject buttons inside popups (owner only)
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    if (!container) return;
    const approveBtn = container.querySelector(".approve-btn");
    const rejectBtn = container.querySelector(".reject-btn");
    if (approveBtn) approveBtn.addEventListener("click", () => handleReview(approveBtn.dataset.wpId, "approve"));
    if (rejectBtn) rejectBtn.addEventListener("click", () => handleReview(rejectBtn.dataset.wpId, "reject"));
  });

  // owner-only: save edited in-game X/Y/Z coordinates on an existing marker
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    const saveBtn = container && container.querySelector(".ig-edit-save");
    if (!saveBtn) return;
    saveBtn.addEventListener("click", async () => {
      const id = saveBtn.dataset.wpId;
      const xEl = container.querySelector(".ig-edit-x");
      const yEl = container.querySelector(".ig-edit-y");
      const zEl = container.querySelector(".ig-edit-z");
      const toNumOrNull = (v) => (v.trim() === "" ? null : Number(v));
      const x_ig = toNumOrNull(xEl.value);
      const y_ig = toNumOrNull(yEl.value);
      const z_ig = toNumOrNull(zEl.value);
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const body = { id, x_ig, y_ig, z_ig };
        // If both X and Z are set, recompute where the pin actually belongs
        // on the map so it moves to match the corrected in-game location.
        if (x_ig != null && z_ig != null) {
          const { mx, my } = gameXZToMap(x_ig, z_ig);
          body.x = mx;
          body.y = my;
        }
        const res = await fetch("/api/admin/edit", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `API ${res.status}`);
        const { marker } = await res.json();
        const entry = registry.get(id);
        if (entry) {
          entry.data = marker;
          entry.marker.setLatLng(toLatLng(marker.x, marker.y));
          if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(popupHtml(marker, entry.pending, id));
        }
        toast(body.x != null ? "Saved — pin moved to match the new coordinates." : "In-game coordinates saved.");
      } catch (err) {
        toast(`Couldn't save: ${err.message}`);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    });
  });

  async function handleReview(id, action) {
    try {
      const res = await fetch(`/api/admin/${action}`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `API ${res.status}`);
      toast(action === "approve" ? "Marker approved and published!" : "Marker rejected.");
      map.closePopup();
      registry.delete(id);
      await Promise.all([loadVerifiedMarkers(), loadPendingMarkers(), loadAdoptedMarkers()]);
    } catch (e) {
      toast(`Couldn't ${action}: ${e.message}`);
    }
  }

  // ── owner mode modal ──────────────────────────────────────────────────
  const ownerModal = document.getElementById("owner-modal");
  const ownerStatus = document.getElementById("owner-status");
  function refreshOwnerStatus() {
    ownerStatus.textContent = isOwner()
      ? "Connected — you can publish instantly and approve/reject submissions."
      : "Not connected — your markers go into the pending queue for the owner to approve.";
    ownerStatus.style.color = isOwner() ? "var(--verified)" : "var(--parchment-dim)";
    addBtnLabel();
  }
  document.getElementById("owner-btn").onclick = () => {
    document.getElementById("owner-token-input").value = "";
    refreshOwnerStatus();
    ownerModal.classList.add("show");
  };
  document.getElementById("owner-connect-btn").onclick = async () => {
    const val = document.getElementById("owner-token-input").value.trim();
    if (!val) return;
    localStorage.setItem(ADMIN_KEY, val);
    const res = await fetch("/api/admin/verify", { method: "POST", headers: adminHeaders() }).catch(() => null);
    const ok = res && res.ok && (await res.json()).ok;
    if (!ok) {
      localStorage.removeItem(ADMIN_KEY);
      toast("That admin key wasn't accepted.");
      refreshOwnerStatus();
      return;
    }
    refreshOwnerStatus();
    toast("Connected. Reloading markers so review controls show up…");
    await Promise.all([loadVerifiedMarkers(), loadPendingMarkers()]);
    ownerModal.classList.remove("show");
  };
  document.getElementById("owner-disconnect-btn").onclick = async () => {
    localStorage.removeItem(ADMIN_KEY);
    refreshOwnerStatus();
    toast("Disconnected.");
    await Promise.all([loadVerifiedMarkers(), loadPendingMarkers()]);
  };

  // ── image resize (keeps uploads small and fast) ───────────────────────
  function resizeImage(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // ── legend modal ─────────────────────────────────────────────────────
  const legendModal = document.getElementById("legend-modal");
  document.getElementById("legend-btn").onclick = () => legendModal.classList.add("show");
  document.getElementById("legend-close").onclick = () => legendModal.classList.remove("show");

  // ── complete/undo toggle inside any open popup ───────────────────────
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    const btn = container && container.querySelector(".complete-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const id = btn.dataset.wpId;
      setDone(id, !isDone(id));
      refreshMarkerVisual(id);
      updateProgressCount();
    });
  });

  // ── progress modal ───────────────────────────────────────────────────
  const progressModal = document.getElementById("progress-modal");
  document.getElementById("progress-btn").onclick = async () => {
    if (!pendingLoaded) await loadPendingMarkers(); // include pending in counts/tags too
    updateProgressCount();
    renderTagChips();
    progressModal.classList.add("show");
  };
  document.getElementById("progress-close").onclick = () => progressModal.classList.remove("show");

  document.getElementById("uncomplete-chests-btn").onclick = () => uncompleteWhere((d) => matchesTag(d, "chest"));

  document.getElementById("tag-reset-btn").onclick = () => {
    const val = document.getElementById("tag-reset-input").value;
    uncompleteWhere((d) => matchesTag(d, val));
  };
  document.getElementById("tag-reset-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("tag-reset-btn").click();
  });

  document.getElementById("uncomplete-all-btn").onclick = () => uncompleteWhere(() => true);

  // ── propose-a-marker flow ────────────────────────────────────────────
  const addBtn = document.getElementById("add-marker-btn");
  const banner = document.getElementById("place-banner");
  const markerModal = document.getElementById("marker-modal");
  const coordReadout = document.getElementById("coord-readout");
  let placing = false;
  let pendingCoord = null;
  let previewMarker = null;

  function syncPendingCoordFromGameFields() {
    const xEl = document.getElementById("f-xig");
    const zEl = document.getElementById("f-zig");
    const xVal = xEl.value.trim();
    const zVal = zEl.value.trim();
    if (xVal === "" || zVal === "") return; // need both to place a point
    const x_ig = Number(xVal);
    const z_ig = Number(zVal);
    if (!Number.isFinite(x_ig) || !Number.isFinite(z_ig)) return;
    const { mx, my } = gameXZToMap(x_ig, z_ig);
    pendingCoord = { x: mx, y: my };
    coordReadout.textContent = `x: ${mx}, y: ${my} (moved to match typed in-game X/Z)`;
    if (previewMarker) map.removeLayer(previewMarker);
    previewMarker = L.marker(toLatLng(mx, my), { icon: pinIcon("pending") }).addTo(map);
  }
  document.getElementById("f-xig").addEventListener("change", syncPendingCoordFromGameFields);
  document.getElementById("f-zig").addEventListener("change", syncPendingCoordFromGameFields);

  function setPlacing(on) {
    placing = on;
    banner.classList.toggle("show", on);
    addBtn.classList.toggle("placing", on);
    if (on) addBtn.textContent = "Cancel placing";
    else addBtn.textContent = isOwner() ? "+ Publish marker" : "+ Propose marker";
    map.getContainer().style.cursor = on ? "crosshair" : "";
  }

  function addBtnLabel() {
    if (!placing) addBtn.textContent = isOwner() ? "+ Publish marker" : "+ Propose marker";
  }

  addBtn.addEventListener("click", () => setPlacing(!placing));
  document.getElementById("cancel-place").addEventListener("click", () => setPlacing(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setPlacing(false); });

  map.on("click", (e) => {
    if (!placing) return;
    pendingCoord = { x: Math.round(e.latlng.lng), y: Math.round(-e.latlng.lat) };
    coordReadout.textContent = `x: ${pendingCoord.x}, y: ${pendingCoord.y}`;
    const { x_ig, z_ig } = mapToGameXZ(pendingCoord.x, pendingCoord.y);
    document.getElementById("f-xig").value = x_ig;
    document.getElementById("f-yig").value = "";
    document.getElementById("f-zig").value = z_ig;
    if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
    setPlacing(false);
    document.getElementById("marker-modal-submit").textContent = isOwner() ? "Publish" : "Submit";
    document.querySelector("#marker-modal .eyebrow").textContent = isOwner()
      ? "New marker · publishing directly"
      : "New marker · goes to pending review";
    markerModal.classList.add("show");
  });

  document.getElementById("marker-modal-cancel").onclick = () => {
    markerModal.classList.remove("show");
    if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
  };

  const photoInput = document.getElementById("f-photo");
  const photoHint = document.getElementById("photo-preview-hint");
  photoInput.addEventListener("change", () => {
    const f = photoInput.files[0];
    photoHint.textContent = f ? `Selected: ${f.name} (${Math.round(f.size / 1024)} KB — will be resized before upload)` : "";
  });

  function resetMarkerForm(hint) {
    document.getElementById("f-title").value = "";
    document.getElementById("f-image").value = "";
    document.getElementById("f-tags").value = "";
    document.getElementById("f-comment").value = "";
    document.getElementById("f-xig").value = "";
    document.getElementById("f-yig").value = "";
    document.getElementById("f-zig").value = "";
    photoInput.value = "";
    photoHint.textContent = "";
    hint.textContent = "";
  }

  document.getElementById("marker-modal-submit").onclick = async () => {
    const title = document.getElementById("f-title").value.trim();
    const category = document.getElementById("f-category").value;
    const imageUrl = document.getElementById("f-image").value.trim();
    const tags = document.getElementById("f-tags").value.trim();
    const comment = document.getElementById("f-comment").value.trim();
    const xIg = document.getElementById("f-xig").value.trim();
    const yIg = document.getElementById("f-yig").value.trim();
    const zIg = document.getElementById("f-zig").value.trim();
    const hint = document.getElementById("form-hint");
    const submitBtn = document.getElementById("marker-modal-submit");
    const photoFile = photoInput.files[0] || null;

    if (!title) {
      hint.textContent = "Give it a title first.";
      hint.style.color = "var(--danger)";
      return;
    }
    if (!pendingCoord) return;

    submitBtn.disabled = true;
    submitBtn.textContent = isOwner() ? "Publishing…" : "Submitting…";

    try {
      const form = new FormData();
      form.append("title", title);
      form.append("category", category);
      form.append("tags", tags);
      form.append("comment", comment);
      form.append("x", pendingCoord.x);
      form.append("y", pendingCoord.y);
      if (xIg !== "") form.append("x_ig", xIg);
      if (yIg !== "") form.append("y_ig", yIg);
      if (zIg !== "") form.append("z_ig", zIg);
      if (imageUrl) form.append("imageUrl", imageUrl);
      if (photoFile) {
        toast("Resizing photo…", 2000);
        const resized = await resizeImage(photoFile);
        form.append("image", resized, "photo.jpg");
      }

      const res = await fetch("/api/submit", {
        method: "POST",
        headers: adminHeaders(),
        body: form,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `API ${res.status}`);

      markerModal.classList.remove("show");
      if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
      toast(
        result.status === "verified"
          ? "Published! Reloading the map…"
          : "Submitted! It'll show up under \"Verified + Pending\" until an admin approves it.",
        5000
      );
      await Promise.all([loadVerifiedMarkers(), loadPendingMarkers()]);
      updateProgressCount();
      renderTagChips();
      resetMarkerForm(hint);
    } catch (e) {
      console.error(e);
      hint.textContent = `Couldn't submit: ${e.message}`;
      hint.style.color = "var(--danger)";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isOwner() ? "Publish" : "Submit";
    }
  };

  // ── filtering: status + regions + tags ───────────────────────────────
  // A marker passes if: its done-state matches an enabled status switch,
  // AND (it carries no region tag, OR at least one of its region tags is
  // enabled), AND at least one of its non-region tags/category is enabled.
  function passesFilters(data, id) {
    const done = isDone(id);
    if (done && !settings.showDone) return false;
    if (!done && !settings.showNotDone) return false;

    const allTags = [(data.category || "").toLowerCase(), ...((data.tags || []).map((t) => (t || "").toLowerCase()))].filter(Boolean);
    const regionTags = allTags.filter((t) => REGION_TAGS.includes(t));
    if (regionTags.length && !regionTags.some(isRegionEnabled)) return false;

    const nonRegionTags = allTags.filter((t) => !REGION_TAGS.includes(t));
    if (nonRegionTags.length && !nonRegionTags.some(isTagEnabled)) return false;

    return true;
  }

  function applyFilters() {
    registry.forEach((entry, id) => {
      const show = passesFilters(entry.data, id);
      const group = entry.pending ? pendingLayer : verifiedLayer;
      const inGroup = group.hasLayer(entry.marker);
      if (show && !inGroup) group.addLayer(entry.marker);
      if (!show && inGroup) group.removeLayer(entry.marker);
    });
  }

  // ── sidebar: open/close via the left-edge tab (> to open, < to collapse) ─
  // No darkening scrim and no click-outside-to-close: the map stays fully
  // usable while the sidebar is open, and it only closes via the tab or the
  // close (×) button.
  const sidebar = document.getElementById("sidebar");
  const sidebarTab = document.getElementById("sidebar-tab");
  let sidebarOpen = false;
  function setSidebarOpen(on) {
    sidebarOpen = on;
    sidebar.classList.toggle("open", on);
    sidebarTab.classList.toggle("open", on);
    sidebarTab.textContent = on ? "‹" : "›";
    if (on) renderFilterLists();
  }
  sidebarTab.addEventListener("click", () => setSidebarOpen(!sidebarOpen));
  document.getElementById("sidebar-close").addEventListener("click", () => setSidebarOpen(false));

  // ── sidebar: status switches ─────────────────────────────────────────
  const showDoneEl = document.getElementById("filter-show-done");
  const showNotDoneEl = document.getElementById("filter-show-notdone");
  showDoneEl.checked = settings.showDone;
  showNotDoneEl.checked = settings.showNotDone;
  showDoneEl.addEventListener("change", () => {
    settings.showDone = showDoneEl.checked;
    saveSettings();
    applyFilters();
  });
  showNotDoneEl.addEventListener("change", () => {
    settings.showNotDone = showNotDoneEl.checked;
    saveSettings();
    applyFilters();
  });

  // ── sidebar: region + tag checklists (rebuilt whenever markers load) ──
  function makeCheckRow(kind, key, label, checked, onChange) {
    const row = document.createElement("label");
    row.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    row.appendChild(input);
    row.appendChild(document.createTextNode(label));
    return row;
  }

  function renderFilterLists() {
    const regionListEl = document.getElementById("region-filter-list");
    const tagListEl = document.getElementById("tag-filter-list");
    regionListEl.innerHTML = "";
    tagListEl.innerHTML = "";

    const seenTags = new Set();
    registry.forEach(({ data }) => {
      if (data.category) seenTags.add(data.category.toLowerCase());
      (data.tags || []).forEach((t) => t && seenTags.add(t.toLowerCase()));
    });

    REGION_TAGS.forEach((r) => {
      regionListEl.appendChild(
        makeCheckRow("region", r, r, isRegionEnabled(r), (checked) => {
          settings.regions[r] = checked;
          saveSettings();
          applyFilters();
        })
      );
    });

    [...seenTags]
      .filter((t) => !REGION_TAGS.includes(t))
      .sort()
      .forEach((t) => {
        tagListEl.appendChild(
          makeCheckRow("tag", t, t, isTagEnabled(t), (checked) => {
            settings.tags[t] = checked;
            saveSettings();
            applyFilters();
          })
        );
      });
  }

  document.querySelectorAll(".mini-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isRegion = btn.dataset.list === "region";
      const on = btn.dataset.action === "all";
      if (isRegion) {
        REGION_TAGS.forEach((r) => (settings.regions[r] = on));
      } else {
        const seenTags = new Set();
        registry.forEach(({ data }) => {
          if (data.category) seenTags.add(data.category.toLowerCase());
          (data.tags || []).forEach((t) => t && seenTags.add(t.toLowerCase()));
        });
        [...seenTags].filter((t) => !REGION_TAGS.includes(t)).forEach((t) => (settings.tags[t] = on));
      }
      saveSettings();
      renderFilterLists();
      applyFilters();
    });
  });

  // ── panning + bulk actions: both live on the right mouse button ───────
  // Left click/tap is reserved entirely for selecting a marker — the map's
  // built-in left-button dragging is switched off at init (see map options
  // above), and panning is reimplemented by hand here on a held right mouse
  // button (desktop) or a single-finger drag (touch, which has no right
  // button). When "Drag to complete" is on, the right button is repurposed:
  // instead of panning, dragging across markers toggles them complete/not
  // complete. Hit-testing is done by pixel distance from each marker's
  // screen position rather than each marker's own DOM mouseover — the DOM
  // approach silently misses whichever marker is underneath when two sit
  // close enough to overlap, since only the topmost element gets pointer
  // events. Each marker only flips once per drag stroke, so a lingering or
  // jittery cursor doesn't flicker it back and forth.
  let bulkMode = false;
  let rightMouseDown = false;
  let bulkTouchedThisDrag = null;
  let panActive = false;
  let panLast = null;

  function cursorForIdleMap() {
    return placing ? "crosshair" : "";
  }
  function startPan(x, y) {
    panActive = true;
    panLast = { x, y };
    mapContainer.style.cursor = "grabbing";
  }
  function movePan(x, y) {
    if (!panActive) return;
    map.panBy([panLast.x - x, panLast.y - y], { animate: false });
    panLast = { x, y };
  }
  function endPan() {
    panActive = false;
    mapContainer.style.cursor = cursorForIdleMap();
  }

  const BULK_HIT_RADIUS = 16; // screen px
  function bulkToggleAt(clientX, clientY) {
    if (!bulkTouchedThisDrag) return;
    const rect = mapContainer.getBoundingClientRect();
    const pt = L.point(clientX - rect.left, clientY - rect.top);
    let changed = false;
    registry.forEach((entry, id) => {
      if (bulkTouchedThisDrag.has(id)) return;
      if (!map.hasLayer(entry.marker)) return; // respects current filters/view
      const p = map.latLngToContainerPoint(entry.marker.getLatLng());
      const dx = p.x - pt.x, dy = p.y - pt.y;
      if (dx * dx + dy * dy > BULK_HIT_RADIUS * BULK_HIT_RADIUS) return;
      bulkTouchedThisDrag.add(id);
      setDone(id, !isDone(id));
      refreshMarkerVisual(id);
      changed = true;
    });
    if (changed) { updateProgressCount(); applyFilters(); }
  }

  const mapContainer = map.getContainer();
  mapContainer.addEventListener("contextmenu", (e) => e.preventDefault());

  // -- desktop: right mouse button --
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 2) return;
    if (!mapContainer.contains(e.target)) return;
    rightMouseDown = true;
    if (bulkMode) {
      bulkTouchedThisDrag = new Set();
      bulkToggleAt(e.clientX, e.clientY);
    } else {
      startPan(e.clientX, e.clientY);
    }
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!rightMouseDown) return;
    if (bulkMode) bulkToggleAt(e.clientX, e.clientY);
    else movePan(e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 2) return;
    rightMouseDown = false;
    bulkTouchedThisDrag = null;
    endPan();
  }, true);

  // -- touch: single-finger drag pans (no right button on touch, so bulk
  // mode isn't reachable via touch — same as before). Two-plus fingers are
  // left alone so Leaflet's own pinch-zoom handler still gets them. --
  mapContainer.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { endPan(); return; }
    startPan(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  mapContainer.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    movePan(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  mapContainer.addEventListener("touchend", endPan);
  mapContainer.addEventListener("touchcancel", endPan);

  const bulkBtn = document.getElementById("bulk-complete-btn");
  function setBulkMode(on) {
    bulkMode = on;
    bulkBtn.textContent = `Drag to complete: ${on ? "ON" : "off"}`;
    bulkBtn.classList.toggle("placing", on);
    if (on) {
      toast("Left click still selects markers — hold the right mouse button and drag across markers to toggle them complete.", 5000);
    }
  }
  bulkBtn.addEventListener("click", () => setBulkMode(!bulkMode));

  // ── instant complete: clicking a marker completes it instead of opening
  // its card. Also used to swallow the popup that a bulk-mode click/drag
  // would otherwise briefly flash open. ────────────────────────────────
  const instantCompleteEl = document.getElementById("instant-complete-toggle");
  instantCompleteEl.checked = settings.instantComplete;
  instantCompleteEl.addEventListener("change", () => {
    settings.instantComplete = instantCompleteEl.checked;
    saveSettings();
  });
  map.on("popupopen", (e) => {
    const marker = e.popup._source;
    const id = markerToId.get(marker);
    if (!id) return;
    if (bulkMode) {
      map.closePopup();
      return;
    }
    if (settings.instantComplete) {
      map.closePopup();
      setDone(id, !isDone(id));
      refreshMarkerVisual(id);
      updateProgressCount();
      applyFilters();
    }
  });

  // ── clickable marker photos: open a lightbox ─────────────────────────
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.add("show");
  }
  lightbox.addEventListener("click", () => lightbox.classList.remove("show"));
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    const img = container && container.querySelector(".marker-card img");
    if (img) img.addEventListener("click", () => openLightbox(img.src));
  });

  // ── report-a-problem flag: opens a pre-filled GitHub issue, no auth ──
  map.on("popupopen", (e) => {
    const container = e.popup.getElement();
    const btn = container && container.querySelector(".report-flag");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const id = btn.dataset.wpId;
      const entry = registry.get(id);
      const m = entry ? entry.data : null;
      const titleText = `Marker issue: ${(m && m.title) || id}`;
      const lines = [
        `Marker ID: ${id}`,
        m ? `Title: ${m.title}` : "",
        m ? `Category: ${m.category}` : "",
        m && m.x_ig != null ? `In-game coords: ${m.x_ig}, ${m.y_ig ?? "?"}, ${m.z_ig}` : "",
        "",
        "What's wrong with this marker?",
        "",
      ].filter((l) => l !== "");
      const url =
        "https://github.com/0PN0/HSLiveMap/issues/new" +
        `?title=${encodeURIComponent(titleText)}` +
        `&body=${encodeURIComponent(lines.join("\n"))}`;
      window.open(url, "_blank", "noopener");
    });
  });

  // ── appearance: color theme ───────────────────────────────────────────
  const themeSelectEl = document.getElementById("theme-select");
  function applyTheme() {
    document.body.dataset.theme = settings.theme;
    themeSelectEl.value = settings.theme;
  }
  themeSelectEl.addEventListener("change", () => {
    settings.theme = themeSelectEl.value;
    saveSettings();
    applyTheme();
  });

  // ── appearance: custom per-type marker images ────────────────────────
  const styleModal = document.getElementById("style-modal");
  document.getElementById("style-btn").addEventListener("click", () => {
    renderStyleUploadList();
    styleModal.classList.add("show");
  });
  document.getElementById("style-close-btn").addEventListener("click", () => styleModal.classList.remove("show"));
  document.getElementById("style-reset-btn").addEventListener("click", () => {
    pinImages = {};
    savePinImages();
    renderStyleUploadList();
    refreshAllVisuals();
    toast("Marker images reset to default.");
  });

  function fileToResizedDataUrl(file, maxDim = 96) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function renderStyleUploadList() {
    const wrap = document.getElementById("style-upload-list");
    wrap.innerHTML = "";
    STYLE_GROUPS.forEach((g) => {
      const current = pinImages[g.key];
      const row = document.createElement("div");
      row.className = "style-row";
      row.innerHTML = `
        <div class="style-row-label">${escapeHtml(g.label)}</div>
        <div class="style-row-controls">
          ${current ? `<img class="style-preview" src="${current}" alt="">` : `<span class="style-preview-empty"></span>`}
          <input type="file" accept="image/*" class="style-file-input" data-group="${escapeHtml(g.key)}">
          ${current ? `<button class="btn style-remove-btn" data-group="${escapeHtml(g.key)}">Remove</button>` : ""}
        </div>`;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll(".style-file-input").forEach((input) => {
      input.addEventListener("change", async () => {
        const f = input.files[0];
        if (!f) return;
        const dataUrl = await fileToResizedDataUrl(f);
        pinImages[input.dataset.group] = dataUrl;
        savePinImages();
        renderStyleUploadList();
        refreshAllVisuals();
      });
    });
    wrap.querySelectorAll(".style-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        delete pinImages[btn.dataset.group];
        savePinImages();
        renderStyleUploadList();
        refreshAllVisuals();
      });
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────
  (async function init() {
    applyTheme();
    refreshOwnerStatus();
    await loadTiles();
    await loadVerifiedMarkers();
  })();
})();
