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
  function popupHtml(m, pending) {
    const img = m.image
      ? `<img src="${m.image}" alt="" onerror="this.style.display='none'">`
      : "";
    const prTag = pending
      ? `<span class="pr-tag">PR #${pending.number} by @${pending.user}</span><br>
         <a class="pr-link" href="${pending.url}" target="_blank" rel="noopener">Review on GitHub →</a>`
      : "";
    return `<div class="marker-card">
      ${img}
      <div class="body">
        <div class="cat">${(m.category || "marker")}</div>
        <h3>${escapeHtml(m.title || "Untitled")}</h3>
        <p>${escapeHtml(m.comment || "")}</p>
        ${prTag}
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
            L.marker(toLatLng(m.x, m.y), { icon: pinIcon("verified") })
              .bindPopup(popupHtml(m, null))
              .addTo(verifiedLayer);
          } catch (e) {
            console.warn("Skipping malformed marker file", f.path, e);
          }
        })
      );
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
              L.marker(toLatLng(m.x, m.y), { icon: pinIcon("pending") })
                .bindPopup(popupHtml(m, { number: pr.number, user: pr.user.login, url: pr.html_url }))
                .addTo(pendingLayer);
            } catch (e) {
              console.warn("Skipping malformed pending marker", f.filename, e);
            }
          }
        } catch (e) {
          console.warn("Could not read files for PR", pr.number, e);
        }
      }
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

  // ── legend modal ─────────────────────────────────────────────────────
  const legendModal = document.getElementById("legend-modal");
  document.getElementById("legend-btn").onclick = () => legendModal.classList.add("show");
  document.getElementById("legend-close").onclick = () => legendModal.classList.remove("show");

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
    addBtn.textContent = on ? "Cancel placing" : "+ Propose marker";
    map.getContainer().style.cursor = on ? "crosshair" : "";
  }

  addBtn.addEventListener("click", () => setPlacing(!placing));
  document.getElementById("cancel-place").addEventListener("click", () => setPlacing(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setPlacing(false); });

  map.on("click", (e) => {
    if (!placing) return;
    pendingCoord = { x: Math.round(e.latlng.lng), y: Math.round(-e.latlng.lat) };
    coordReadout.textContent = `x: ${pendingCoord.x}, y: ${pendingCoord.y}`;
    setPlacing(false);
    markerModal.classList.add("show");
  });

  document.getElementById("marker-modal-cancel").onclick = () => markerModal.classList.remove("show");

  document.getElementById("marker-modal-submit").onclick = () => {
    const title = document.getElementById("f-title").value.trim();
    const category = document.getElementById("f-category").value;
    const image = document.getElementById("f-image").value.trim();
    const comment = document.getElementById("f-comment").value.trim();
    const hint = document.getElementById("form-hint");

    if (!title) {
      hint.textContent = "Give it a title first.";
      hint.style.color = "var(--danger)";
      return;
    }
    if (!pendingCoord) return;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)
      || "marker";
    const unique = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const path = `data/markers/${unique}.json`;

    const payload = {
      title,
      category,
      x: pendingCoord.x,
      y: pendingCoord.y,
      image: image || "",
      comment,
    };
    const content = JSON.stringify(payload, null, 2) + "\n";

    const url =
      `https://github.com/${CFG.owner}/${CFG.repo}/new/${CFG.branch}` +
      `?filename=${encodeURIComponent(path)}&value=${encodeURIComponent(content)}`;

    window.open(url, "_blank", "noopener");
    markerModal.classList.remove("show");
    toast("Opened GitHub — review the file, then click \"Propose new file\" to open a pull request.", 6000);

    // reset form
    document.getElementById("f-title").value = "";
    document.getElementById("f-image").value = "";
    document.getElementById("f-comment").value = "";
    hint.textContent = "";
  };

  // ── boot ─────────────────────────────────────────────────────────────
  (async function init() {
    await loadTiles();
    await loadVerifiedMarkers();
  })();
})();
