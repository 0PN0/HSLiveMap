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
    marker.setIcon(pinIcon(kind));
    if (marker.isPopupOpen()) marker.setPopupContent(popupHtml(data, pending, id));
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
  const tileBounds = (t) => L.latLngBounds(toLatLng(t.x, t.y + t.height), toLatLng(t.x + t.width, t.y));

  // ── map setup ────────────────────────────────────────────────────────
  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 4,
    zoomSnap: 0.25,
    attributionControl: false,
  });

  const verifiedLayer = L.layerGroup().addTo(map);
  const pendingLayer = L.layerGroup(); // added/removed by the view toggle

  function pinIcon(kind) {
    return L.divIcon({
      className: "",
      html: `<div class="pin ${kind}"></div>`,
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
    map.setMaxBounds(overall.pad(0.25));
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
      </div>
    </div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
        const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "verified") })
          .bindPopup(popupHtml(m, null, id))
          .addTo(verifiedLayer);
        registry.set(id, { marker, data: m, pending: null });
      });
      updateProgressCount();
      renderTagChips();
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
        const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "pending") })
          .bindPopup(popupHtml(m, {}, id))
          .addTo(pendingLayer);
        registry.set(id, { marker, data: m, pending: {} });
      });
      pendingLoaded = true;
      updateProgressCount();
      renderTagChips();
    } catch (e) {
      console.warn("Could not load pending markers", e);
      toast("Couldn't load pending submissions.");
    }
  }

  // ── view toggle ──────────────────────────────────────────────────────
  document.getElementById("view-toggle").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.view === "all") {
      toast("Loading pending submissions…", 2000);
      await loadPendingMarkers();
      pendingLayer.addTo(map);
    } else {
      map.removeLayer(pendingLayer);
    }
  });

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
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const res = await fetch("/api/admin/edit", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            x_ig: toNumOrNull(xEl.value),
            y_ig: toNumOrNull(yEl.value),
            z_ig: toNumOrNull(zEl.value),
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `API ${res.status}`);
        const { marker } = await res.json();
        const entry = registry.get(id);
        if (entry) entry.data = marker;
        toast("In-game coordinates saved.");
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
      await Promise.all([loadVerifiedMarkers(), loadPendingMarkers()]);
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
    setPlacing(false);
    document.getElementById("marker-modal-submit").textContent = isOwner() ? "Publish" : "Submit";
    document.querySelector("#marker-modal .eyebrow").textContent = isOwner()
      ? "New marker · publishing directly"
      : "New marker · goes to pending review";
    markerModal.classList.add("show");
  });

  document.getElementById("marker-modal-cancel").onclick = () => markerModal.classList.remove("show");

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

  // ── boot ─────────────────────────────────────────────────────────────
  (async function init() {
    refreshOwnerStatus();
    await loadTiles();
    await loadVerifiedMarkers();
  })();
})();
