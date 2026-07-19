(() => {
  const workspace = document.getElementById("workspace");
  const wrap = document.getElementById("workspace-wrap");
  const tileList = document.getElementById("tile-list");
  const fileInput = document.getElementById("file-input");

  let tiles = []; // { id, file, x, y, width, height, el }
  let counter = 0;
  let scale = 1;
  let snap = false;

  function applyZoom() {
    workspace.style.transform = `scale(${scale})`;
    document.getElementById("zoom-reset").textContent = `${Math.round(scale * 100)}%`;
  }
  document.getElementById("zoom-in").onclick = () => { scale = Math.min(scale + 0.1, 3); applyZoom(); };
  document.getElementById("zoom-out").onclick = () => { scale = Math.max(scale - 0.1, 0.2); applyZoom(); };
  document.getElementById("zoom-reset").onclick = () => { scale = 1; applyZoom(); };

  document.getElementById("snap-toggle").onclick = (e) => {
    snap = !snap;
    e.target.textContent = `Snap: ${snap ? "on (8px)" : "off"}`;
  };
  const snapVal = (v) => (snap ? Math.round(v / 8) * 8 : Math.round(v));

  function renderSidebarRow(t) {
    let row = document.getElementById(`row-${t.id}`);
    if (!row) {
      row = document.createElement("div");
      row.className = "tile-row";
      row.id = `row-${t.id}`;
      tileList.appendChild(row);
    }
    row.innerHTML = `<span>${t.file.name} <br><span style="color:var(--parchment-dim)">${Math.round(t.x)},${Math.round(t.y)} · ${Math.round(t.width)}×${Math.round(t.height)}</span></span>
      <button title="Remove">✕</button>`;
    row.querySelector("button").onclick = () => removeTile(t.id);
    row.onmouseenter = () => selectTile(t.id, false);
  }

  function removeTile(id) {
    const t = tiles.find((x) => x.id === id);
    if (!t) return;
    t.el.remove();
    document.getElementById(`row-${id}`)?.remove();
    tiles = tiles.filter((x) => x.id !== id);
  }

  function selectTile(id, scrollTo) {
    tiles.forEach((t) => t.el.classList.toggle("selected", t.id === id));
    if (scrollTo) {
      const t = tiles.find((x) => x.id === id);
      if (t) wrap.scrollTo({ left: t.x * scale - 100, top: t.y * scale - 100, behavior: "smooth" });
    }
  }

  function addTile(file, index) {
    const id = ++counter;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const el = document.createElement("div");
      el.className = "tile";
      const startW = Math.min(img.naturalWidth, 700);
      const startH = startW * (img.naturalHeight / img.naturalWidth);
      const t = {
        id, file,
        x: (index % 4) * (startW + 20),
        y: Math.floor(index / 4) * (startH + 20),
        width: startW, height: startH,
        el,
      };
      el.innerHTML = `<span class="label">${file.name}</span><img src="${url}"><div class="handle"></div>`;
      workspace.appendChild(el);
      layout(t);
      makeDraggable(t);
      makeResizable(t);
      tiles.push(t);
      renderSidebarRow(t);
    };
    img.src = url;
  }

  function layout(t) {
    t.el.style.left = `${t.x}px`;
    t.el.style.top = `${t.y}px`;
    t.el.style.width = `${t.width}px`;
    t.el.style.height = `${t.height}px`;
    renderSidebarRow(t);
  }

  function makeDraggable(t) {
    let sx, sy, ox, oy, dragging = false;
    t.el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("handle")) return;
      dragging = true;
      selectTile(t.id, false);
      sx = e.clientX; sy = e.clientY; ox = t.x; oy = t.y;
      t.el.setPointerCapture(e.pointerId);
    });
    t.el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      t.x = snapVal(ox + (e.clientX - sx) / scale);
      t.y = snapVal(oy + (e.clientY - sy) / scale);
      layout(t);
    });
    t.el.addEventListener("pointerup", () => { dragging = false; });
  }

  function makeResizable(t) {
    const handle = t.el.querySelector(".handle");
    let sx, sy, ow, oh, resizing = false;
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      resizing = true;
      sx = e.clientX; sy = e.clientY; ow = t.width; oh = t.height;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      e.stopPropagation();
      t.width = snapVal(Math.max(20, ow + (e.clientX - sx) / scale));
      t.height = snapVal(Math.max(20, oh + (e.clientY - sy) / scale));
      layout(t);
    });
    handle.addEventListener("pointerup", () => { resizing = false; });
  }

  fileInput.addEventListener("change", (e) => {
    const startIndex = tiles.length;
    Array.from(e.target.files).forEach((f, i) => addTile(f, startIndex + i));
    fileInput.value = "";
  });

  document.getElementById("export-btn").onclick = () => {
    if (!tiles.length) return;
    const out = {
      tiles: tiles.map((t) => ({
        file: `images/tiles/${t.file.name}`,
        x: Math.round(t.x),
        y: Math.round(t.y),
        width: Math.round(t.width),
        height: Math.round(t.height),
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tiles.json";
    a.click();
    document.getElementById("export-modal").classList.add("show");
  };
  document.getElementById("export-close").onclick = () => document.getElementById("export-modal").classList.remove("show");

  applyZoom();
})();
