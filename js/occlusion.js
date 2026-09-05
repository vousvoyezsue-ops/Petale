/* ═══════════════════════════════════════════════════════
   Petale Image Occlusion
   - 편집기: 드래그로 마스크 생성, 선택 후 이동·크기 조절·삭제
   - 렌더러: 학습 화면에서 마스크 표시/공개
   rect 좌표는 이미지 기준 백분율 {x, y, w, h}
   ═══════════════════════════════════════════════════════ */

const Occlusion = (() => {
  const MAX_DIM = 1400;      // 저장 전 리사이즈 상한(px)
  const JPEG_QUALITY = 0.85;
  const MIN_SIZE = 1.5;      // 마스크 최소 크기(%)

  let imageData = null;      // dataURL
  let rects = [];            // [{x,y,w,h}] in %
  let selected = -1;         // 선택된 마스크 인덱스
  let drag = null;           // { type: 'draw'|'move'|'resize', ... }

  const $ = (s) => document.querySelector(s);

  /* ── 이미지 로드: 리사이즈 후 dataURL ── */
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  /* ── 편집기 ── */
  function resetEditor() {
    imageData = null;
    rects = [];
    selected = -1;
    drag = null;
    $("#occStage").classList.add("empty");
    $("#occImg").src = "";
    $("#occImg").style.display = "none";
    renderMasks();
    updateMeta();
  }

  function loadEditor(card) {
    imageData = Store.getMedia(card.imageId);
    rects = (card.rects || []).map(r => ({ ...r }));
    selected = -1; drag = null;
    const img = $("#occImg");
    img.src = imageData || "";
    img.style.display = imageData ? "block" : "none";
    $("#occStage").classList.toggle("empty", !imageData);
    $("#occModeAll").checked = card.occMode === "all";
    $("#occModeOne").checked = card.occMode !== "all";
    $("#occLabel").value = card.front || "";
    renderMasks(); updateMeta();
  }

  async function pickImage(file) {
    if (!file) return;
    imageData = await fileToDataURL(file);
    rects = [];
    selected = -1;
    const img = $("#occImg");
    img.src = imageData;
    img.style.display = "block";
    $("#occStage").classList.remove("empty");
    renderMasks();
    updateMeta();
  }

  function stagePos(e) {
    const r = $("#occStage").getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)),
    };
  }

  function onPointerDown(e) {
    if (!imageData) return;
    e.preventDefault();
    $("#occStage").setPointerCapture?.(e.pointerId);
    const p = stagePos(e);

    const delBtn = e.target.closest(".occ-del");
    if (delBtn) {
      removeMaskAt(Number(delBtn.closest(".occ-mask").dataset.i));
      return;
    }
    const handle = e.target.closest(".occ-handle");
    if (handle) {
      const idx = Number(handle.closest(".occ-mask").dataset.i);
      selected = idx;
      drag = { type: "resize", idx };
      return;
    }
    const mask = e.target.closest(".occ-mask");
    if (mask && !mask.classList.contains("tmp")) {
      const idx = Number(mask.dataset.i);
      selected = idx;
      const r = rects[idx];
      drag = { type: "move", idx, dx: p.x - r.x, dy: p.y - r.y, moved: false };
      renderMasks();
      return;
    }
    // 빈 곳: 새 마스크 그리기 + 선택 해제
    selected = -1;
    drag = { type: "draw", x0: p.x, y0: p.y };
    renderMasks();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const p = stagePos(e);
    if (drag.type === "draw") {
      drag.cur = normRect(drag.x0, drag.y0, p.x, p.y);
    } else if (drag.type === "move") {
      const r = rects[drag.idx];
      r.x = Math.min(100 - r.w, Math.max(0, p.x - drag.dx));
      r.y = Math.min(100 - r.h, Math.max(0, p.y - drag.dy));
      drag.moved = true;
    } else if (drag.type === "resize") {
      const r = rects[drag.idx];
      r.w = Math.min(100 - r.x, Math.max(MIN_SIZE, p.x - r.x));
      r.h = Math.min(100 - r.y, Math.max(MIN_SIZE, p.y - r.y));
    }
    renderMasks();
  }

  function onPointerUp(e) {
    if (!drag) return;
    if (drag.type === "draw") {
      const p = stagePos(e);
      const r = normRect(drag.x0, drag.y0, p.x, p.y);
      if (r.w > MIN_SIZE && r.h > MIN_SIZE) {
        rects.push(r);
        selected = rects.length - 1;
      }
    }
    drag = null;
    renderMasks();
    updateMeta();
  }

  function normRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
    };
  }

  function renderMasks() {
    const host = $("#occMasks");
    const parts = rects.map((r, i) => `
      <div class="occ-mask ${i === selected ? "selected" : ""}" data-i="${i}"
        style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%">
        <b>${i + 1}</b>
        ${i === selected ? `<button type="button" class="occ-del" title="삭제">✕</button>
        <i class="occ-handle"></i>` : ""}
      </div>`);
    if (drag?.type === "draw" && drag.cur) {
      const r = drag.cur;
      parts.push(`<div class="occ-mask tmp"
        style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%"></div>`);
    }
    host.innerHTML = parts.join("");
  }

  function updateMeta() {
    $("#occCount").textContent = t("occ.masks", { n: rects.length });
    $("#occCreate").textContent = t("occ.create", { n: rects.length });
    $("#occCreate").disabled = !rects.length || !imageData;
  }

  function removeMaskAt(idx) {
    if (idx >= 0 && idx < rects.length) {
      rects.splice(idx, 1);
      selected = -1;
      renderMasks();
      updateMeta();
    }
  }

  // 카드 생성: 마스크마다 1장
  function buildCards() {
    if (!imageData || !rects.length) return null;
    const imageId = Store.addMedia(imageData);
    const mode = $("#occModeAll").checked ? "all" : "one";
    const label = $("#occLabel").value.trim();
    return rects.map((_, i) => ({
      type: "occlusion",
      imageId,
      rects: rects.map(r => ({ ...r })),
      hideIndex: i,
      occMode: mode,
      front: label,
      back: "",
    }));
  }

  function buildEditFields(card) {
    if (!imageData || !rects.length) return null;
    let imageId = card.imageId;
    if (Store.getMedia(imageId) !== imageData) imageId = Store.addMedia(imageData);
    return { imageId, rects: rects.map(r => ({ ...r })), hideIndex: Math.min(card.hideIndex || 0, rects.length - 1), occMode: $("#occModeAll").checked ? "all" : "one", front: $("#occLabel").value.trim() };
  }

  function bindEditor() {
    const stage = $("#occStage");
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    $("#occFile").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) { try { await pickImage(f); } catch { /* 무시 */ } }
    });
    $("#occClear").addEventListener("click", () => {
      rects = []; selected = -1;
      renderMasks(); updateMeta();
    });

    // 클립보드에서 이미지 붙여넣기(Ctrl+V) — 모달이 열려 있을 때만 동작
    document.addEventListener("paste", async (e) => {
      const modal = $("#occModal");
      if (!modal || !modal.open) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) { try { await pickImage(file); } catch { /* 무시 */ } }
          return;
        }
      }
    });

    // 드래그 앤 드롭으로도 이미지 추가
    stage.addEventListener("dragover", (e) => e.preventDefault());
    stage.addEventListener("drop", async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) { try { await pickImage(file); } catch { /* 무시 */ } }
    });
  }

  /* ── 학습 렌더러 ── */
  // revealed=false: 앞면(가림), true: 뒷면(공개 + 정답 강조)
  // 타깃 판정: hideGroup(가져온 Anki IO 노트)이 있으면 rect.g 기준, 없으면 인덱스 기준
  function renderInto(host, card, revealed) {
    const src = Store.getMedia(card.imageId);
    if (!src) { host.textContent = "⚠"; return; }
    const isTarget = (r, i) =>
      card.hideGroup != null ? r.g === card.hideGroup : i === card.hideIndex;
    const masks = card.rects.map((r, i) => {
      let cls = "";
      if (!revealed) {
        if (card.occMode === "all") cls = isTarget(r, i) ? "hidden-target" : "hidden-other";
        else cls = isTarget(r, i) ? "hidden-target" : "transparent";
      } else {
        cls = isTarget(r, i) ? "revealed-target" : "transparent";
      }
      return `<div class="occ-mask static ${cls}"
        style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%"></div>`;
    }).join("");
    // 마스크는 이미지 박스(.occ-canvas) 기준 %로 배치한다.
    // 캡션을 캔버스 밖으로 빼서 캡션 높이가 마스크 좌표에 영향을 주지 않게 한다.
    host.innerHTML = `
      <figure class="occ-view">
        <div class="occ-canvas">
          <img src="${src}" alt="">
          ${masks}
        </div>
        ${card.front ? `<figcaption>${card.front.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</figcaption>` : ""}
      </figure>`;

    // 마스크는 .occ-canvas 기준 %로 배치되므로, 캔버스가 '실제로 렌더된 이미지 크기'와
    // 정확히 같아야 한다. max-height로 이미지가 축소되면 fit-content 너비가 따라오지 않아
    // 마스크가 옆으로 밀리므로, 렌더된 크기를 직접 캔버스에 고정한다.
    const canvas = host.querySelector(".occ-canvas");
    const img = host.querySelector(".occ-canvas img");
    if (canvas && img) {
      const sync = () => {
        const w = img.clientWidth, h = img.clientHeight;
        if (w && h) { canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
      };
      if (img.complete) sync(); else img.addEventListener("load", sync, { once: true });
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(sync);
        ro.observe(img);
        host._occRO?.disconnect();
        host._occRO = ro;
      }
    }
  }

  return { bindEditor, resetEditor, loadEditor, buildCards, buildEditFields, renderInto };
})();
