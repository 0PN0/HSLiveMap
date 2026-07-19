/* global L, MAP_CONFIG */
(() => {
  const CFG = window.MAP_CONFIG;
  const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;

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

  // ── owner mode: optional GitHub token for direct publish + photo upload ─
  const TOKEN_KEY = "map-explorer:owner-token";
  const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
  const isOwner = () => !!getToken();
  const ghHeaders = () => ({
    Authorization: `token ${getToken()}`,
    Accept: "application/vnd.github+json",
  });

  // ── coordinate helpers ───────────────────────────────────────────────
  // Tiles/markers are authored in "map pixel" space with y increasing
  // downward (like an image). Leaflet's CRS.Simple has lat increasing
  // upward, so we negate y when converting.
  const toLatLng = (x, y) => L.latLng(-y, x);
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
      ? `<img src="${m.image}" alt="" onerror="this.style.display='none'">`
      : "";
    const prTag = pending
      ? `<span class="pr-tag">PR #${pending.number} by @${pending.user}</span><br>
         <a class="pr-link" href="${pending.url}" target="_blank" rel="noopener">Review on GitHub →</a>`
      : "";
    const done = isDone(id);
    const tagChips = (m.tags || []).length
      ? `<div class="tag-chips">${m.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    return `<div class="marker-card ${done ? "done" : ""}">
      ${img}
      <div class="body">
        <div class="cat">${escapeHtml(m.category || "marker")}</div>
        <h3>${escapeHtml(m.title || "Untitled")}</h3>
        <p>${escapeHtml(m.comment || "")}</p>
        ${tagChips}
        ${prTag}
        <button class="complete-toggle ${done ? "is-done" : ""}" data-wp-id="${escapeHtml(id)}">
          ${done ? "✓ Completed — click to undo" : "Mark completed"}
        </button>
      </div>
    </div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── verified markers: read straight from the repo ───────────────────
  async function loadVerifiedMarkers() {
    try {
      const res = await fetch(`${API}/contents/data/markers?ref=${CFG.branch}`);
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const files = await res.json();
      const jsonFiles = files.filter((f) => f.type === "file" && f.name.endsWith(".json"));
      await Promise.all(
        jsonFiles.map(async (f) => {
          try {
            const m = await (await fetch(f.download_url)).json();
            const id = f.path; // stable across sessions
            const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "verified") })
              .bindPopup(popupHtml(m, null, id))
              .addTo(verifiedLayer);
            registry.set(id, { marker, data: m, pending: null });
          } catch (e) {
            console.warn("Skipping malformed marker file", f.path, e);
          }
        })
      );
      updateProgressCount();
      renderTagChips();
    } catch (e) {
      console.warn("Could not load verified markers", e);
      toast("Couldn't reach GitHub for verified markers (rate limit or repo not public yet?)");
    }
  }

  // ── pending markers: files added in still-open pull requests ────────
  let pendingLoaded = false;
  async function loadPendingMarkers() {
    if (pendingLoaded) return;
    pendingLoaded = true;
    try {
      const prs = await (await fetch(`${API}/pulls?state=open&per_page=50`)).json();
      if (!Array.isArray(prs)) throw new Error("Unexpected PR list response");
      for (const pr of prs) {
        try {
          const files = await (await fetch(`${API}/pulls/${pr.number}/files`)).json();
          const added = files.filter(
            (f) => f.status === "added" && f.filename.startsWith("data/markers/") && f.filename.endsWith(".json")
          );
          for (const f of added) {
            try {
              const m = await (await fetch(f.raw_url)).json();
              const id = f.filename;
              const prInfo = { number: pr.number, user: pr.user.login, url: pr.html_url };
              const marker = L.marker(toLatLng(m.x, m.y), { icon: pinIcon(isDone(id) ? "done" : "pending") })
                .bindPopup(popupHtml(m, prInfo, id))
                .addTo(pendingLayer);
              registry.set(id, { marker, data: m, pending: prInfo });
            } catch (e) {
              console.warn("Skipping malformed pending marker", f.filename, e);
            }
          }
        } catch (e) {
          console.warn("Could not read files for PR", pr.number, e);
        }
      }
      updateProgressCount();
      renderTagChips();
    } catch (e) {
      console.warn("Could not load pending markers", e);
      toast("Couldn't reach GitHub for pending PRs (rate limit?)");
    }
  }

  // ── view toggle ──────────────────────────────────────────────────────
  document.getElementById("view-toggle").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.view === "all") {
      toast("Loading pending pull requests…", 2000);
      await loadPendingMarkers();
      pendingLayer.addTo(map);
    } else {
      map.removeLayer(pendingLayer);
    }
  });

  // ── owner mode modal ──────────────────────────────────────────────────
  const ownerModal = document.getElementById("owner-modal");
  const ownerStatus = document.getElementById("owner-status");
  function refreshOwnerStatus() {
    ownerStatus.textContent = isOwner()
      ? "Connected — you'll publish directly to main."
      : "Not connected — you'll go through the pull request flow like everyone else.";
    ownerStatus.style.color = isOwner() ? "var(--verified)" : "var(--parchment-dim)";
    addBtnLabel();
  }
  document.getElementById("owner-btn").onclick = () => {
    document.getElementById("owner-token-input").value = "";
    refreshOwnerStatus();
    ownerModal.classList.add("show");
  };
  document.getElementById("owner-connect-btn").onclick = () => {
    const val = document.getElementById("owner-token-input").value.trim();
    if (!val) return;
    localStorage.setItem(TOKEN_KEY, val);
    refreshOwnerStatus();
    toast("Connected. You can now attach photos and publish directly.");
    ownerModal.classList.remove("show");
  };
  document.getElementById("owner-disconnect-btn").onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    refreshOwnerStatus();
    toast("Disconnected.");
  };

  // ── image resize (keeps repo commits small) ──────────────────────────
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
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ── direct publish via GitHub Contents API (owner only) ──────────────
  async function putFile(path, base64Content, message) {
    const res = await fetch(`${API}/contents/${path}`, {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: base64Content, branch: CFG.branch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `GitHub API ${res.status}`);
    }
    return res.json();
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
    setPlacing(false);
    document.getElementById("marker-modal-submit").textContent = isOwner() ? "Publish" : "Generate GitHub link";
    document.querySelector("#marker-modal .eyebrow").textContent = isOwner() ? "New marker · publishing directly" : "New marker · via pull request";
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
    photoInput.value = "";
    photoHint.textContent = "";
    hint.textContent = "";
  }

  document.getElementById("marker-modal-submit").onclick = async () => {
    const title = document.getElementById("f-title").value.trim();
    const category = document.getElementById("f-category").value;
    const imageUrl = document.getElementById("f-image").value.trim();
    const tags = document.getElementById("f-tags").value
      .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const comment = document.getElementById("f-comment").value.trim();
    const hint = document.getElementById("form-hint");
    const submitBtn = document.getElementById("marker-modal-submit");
    const photoFile = photoInput.files[0] || null;

    if (!title) {
      hint.textContent = "Give it a title first.";
      hint.style.color = "var(--danger)";
      return;
    }
    if (!pendingCoord) return;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)
      || "marker";
    const unique = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const jsonPath = `data/markers/${unique}.json`;

    if (isOwner()) {
      // ── direct publish: upload photo (if any) + commit marker straight to main ──
      submitBtn.disabled = true;
      submitBtn.textContent = "Publishing…";
      try {
        let imagePath = imageUrl;
        if (photoFile) {
          toast("Resizing and uploading photo…", 4000);
          const resized = await resizeImage(photoFile);
          const base64 = await blobToBase64(resized);
          imagePath = `images/markers/${unique}.jpg`;
          await putFile(imagePath, base64, `Add photo for marker: ${title}`);
        }
        const payload = { title, category, tags, x: pendingCoord.x, y: pendingCoord.y, image: imagePath || "", comment };
        const jsonBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2) + "\n")));
        await putFile(jsonPath, jsonBase64, `Add marker: ${title}`);

        markerModal.classList.remove("show");
        toast("Published! Reloading verified markers…", 4000);
        verifiedLayer.clearLayers();
        await loadVerifiedMarkers();
        updateProgressCount();
        renderTagChips();
        resetMarkerForm(hint);
      } catch (e) {
        console.error(e);
        hint.textContent = `Couldn't publish: ${e.message}. Check your token's permissions.`;
        hint.style.color = "var(--danger)";
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Publish";
      }
      return;
    }

    // ── no token: fall back to the one-click PR flow (URL only, no upload) ──
    const payload = { title, category, tags, x: pendingCoord.x, y: pendingCoord.y, image: imageUrl || "", comment };
    const content = JSON.stringify(payload, null, 2) + "\n";
    const url =
      `https://github.com/${CFG.owner}/${CFG.repo}/new/${CFG.branch}` +
      `?filename=${encodeURIComponent(jsonPath)}&value=${encodeURIComponent(content)}`;

    if (photoFile && !imageUrl) {
      hint.textContent = "Photo uploads need an owner-mode connection — paste an image URL instead, or ask the map owner to add this one.";
      hint.style.color = "var(--danger)";
      return;
    }

    window.open(url, "_blank", "noopener");
    markerModal.classList.remove("show");
    toast("Opened GitHub — review the file, then click \"Propose new file\" to open a pull request.", 6000);
    resetMarkerForm(hint);
  };

  // ── boot ─────────────────────────────────────────────────────────────
  (async function init() {
    refreshOwnerStatus();
    await loadTiles();
    await loadVerifiedMarkers();
  })();
})();
