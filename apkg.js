/* ═══════════════════════════════════════════════════════
   Petale .apkg 가져오기
   .apkg = zip { collection.anki2(1|1b): SQLite, media, "0","1",…: 파일 }
   - 구형(레거시): media는 JSON 매핑, DB·파일 무압축
   - 신형(Anki 23+): collection.anki21b·media·파일이 zstd 압축,
     media는 protobuf(MediaEntries) — fzstd로 해제
   - JSZip으로 해제, sql.js(WASM)로 notes 테이블 읽기
   - 필드1 → 앞면, 나머지 → 뒷면. {{c1::}} 패턴은 cloze로 인식
   - 필드 안 <img>는 media 저장소로 옮겨 카드에 연결
   ═══════════════════════════════════════════════════════ */

const Apkg = (() => {
  const FIELD_SEP = "\x1f";
  const MEDIA_BUDGET = 8 * 1024 * 1024; // dataURL 합계 상한 (localStorage 보호)

  // zstd 매직넘버(28 B5 2F FD)면 해제, 아니면 그대로
  function maybeUnzstd(u8) {
    if (u8.length >= 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) {
      return fzstd.decompress(u8);
    }
    return u8;
  }

  // 신형 media 파일: MediaEntries { repeated MediaEntry entries = 1 }
  // MediaEntry { string name = 1; … } — zip 키는 목록 순번
  function parseMediaEntries(u8) {
    const map = {};
    let pos = 0, idx = 0;
    const varint = () => {
      let v = 0, shift = 0, b;
      do { b = u8[pos++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return v;
    };
    const dec = new TextDecoder();
    while (pos < u8.length) {
      const tag = varint();
      const len = tag === 0x0a ? varint() : null; // field 1, wire type 2
      if (len == null) break; // 예상 밖 구조 — 파싱 중단
      const entry = u8.subarray(pos, pos + len);
      pos += len;
      // entry 안의 field 1(name)만 읽는다
      let p = 0;
      while (p < entry.length) {
        const t2 = entry[p++];
        let l2 = 0, shift = 0, b;
        do { b = entry[p++]; l2 += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
        if (t2 === 0x0a) { map[idx] = dec.decode(entry.subarray(p, p + l2)); break; }
        if ((t2 & 7) === 2) p += l2; // 다른 length-delimited 필드 건너뛰기
        // varint 필드(t2&7===0)는 l2 자체가 값 — 이미 소비됨
      }
      idx++;
    }
    return map;
  }

  let sqlPromise = null;
  function getSql() {
    // 실패한 프로미스를 캐시하지 않는다 — WASM 로드가 한 번 삐끗해도
    // 다음 가져오기에서 재시도되도록(안 그러면 새로고침 전까지 계속 실패)
    if (!sqlPromise) {
      if (typeof initSqlJs !== "function") return Promise.reject(new Error("sqljs_unloaded"));
      sqlPromise = initSqlJs({ locateFile: (f) => `vendor/${f}` }).catch((e) => {
        sqlPromise = null;
        throw e;
      });
    }
    return sqlPromise;
  }

  function htmlToText(html) {
    const cleaned = html
      .replace(/\[sound:[^\]]*\]/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>\s*<div>/gi, "\n");
    const el = document.createElement("div");
    el.innerHTML = cleaned;
    return el.textContent.replace(/\n{3,}/g, "\n\n").trim();
  }

  function firstImageName(html) {
    const m = /<img[^>]+src=["']?([^"'>\s]+)/i.exec(html);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function extToMime(name) {
    const e = name.split(".").pop().toLowerCase();
    return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
             gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[e] || null;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function imageDims(dataURL) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve(null);
      im.src = dataURL;
    });
  }

  // Anki 공식 Image Occlusion 노트 파싱:
  // {{c1::image-occlusion:rect:left=.28:top=.05:width=.08:height=.17}}
  // 좌표는 0~1 비율(신형) 또는 픽셀(구형) — 픽셀이면 이미지 크기로 정규화
  const IO_RE = /\{\{c(\d+)::image-occlusion:([a-z]+):([^}]*)\}\}/g;

  async function parseIONote(fields, importImage) {
    const joined = fields.join("\n");
    const shapes = [];
    for (const m of joined.matchAll(IO_RE)) {
      const type = m[2];
      if (type !== "rect" && type !== "ellipse") continue; // polygon/text는 미지원
      const params = {};
      for (const kv of m[3].split(":")) {
        const [k, v] = kv.split("=");
        if (k && v !== undefined) params[k] = parseFloat(v);
      }
      if ([params.left, params.top, params.width, params.height].some(v => !isFinite(v))) continue;
      shapes.push({ g: Number(m[1]), left: params.left, top: params.top, width: params.width, height: params.height });
    }
    if (!shapes.length) return null;

    const imgName = firstImageName(joined);
    if (!imgName) return null;
    const imageId = await importImage(imgName);
    if (!imageId) return null;

    // 정규화: 값이 전부 1.01 이하이면 비율, 아니면 픽셀로 보고 이미지 크기로 나눈다
    let scaleX = 100, scaleY = 100;
    const values = shapes.flatMap(s => [s.left, s.top, s.width, s.height]);
    if (values.some(v => v > 1.01)) {
      const dims = await imageDims(Store.getMedia(imageId));
      if (!dims || !dims.w || !dims.h) return null;
      scaleX = 100 / dims.w;
      scaleY = 100 / dims.h;
    }
    const clamp = (v) => Math.min(100, Math.max(0, v));
    const rects = shapes.map(s => ({
      x: clamp(s.left * scaleX), y: clamp(s.top * scaleY),
      w: clamp(s.width * scaleX), h: clamp(s.height * scaleY),
      g: s.g,
    }));

    // 헤더: 이미지·마스크 데이터가 아닌 첫 텍스트 필드
    const header = fields
      .map(f => htmlToText(f.replace(IO_RE, "")))
      .find(txt => txt && !/^\s*$/.test(txt)) || "";

    const groups = [...new Set(rects.map(r => r.g))].sort((a, b) => a - b);
    return groups.map(g => ({
      type: "occlusion",
      imageId,
      rects,
      hideGroup: g,
      occMode: "one",
      front: header,
      back: "",
    }));
  }

  /* ── Image Occlusion Enhanced(구 애드온) ──
     마스크가 좌표가 아니라 SVG 오버레이(…-Q.svg / …-A.svg)로 저장된다.
     SVG 도형을 % 좌표 rect로 변환해 네이티브 가리기 카드로 만든다.
     Q에만 있는 도형 = 이 카드의 정답 영역(g=1), Q·A 양쪽 = 나머지 마스크(g=0) */
  function svgShapes(text) {
    if (!text) return [];
    const svg = new DOMParser().parseFromString(text, "image/svg+xml").querySelector("svg");
    if (!svg) return [];
    let W = parseFloat(svg.getAttribute("width")), H = parseFloat(svg.getAttribute("height"));
    if (!W || !H) {
      const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      if (vb.length === 4) { W = vb[2]; H = vb[3]; }
    }
    if (!W || !H) return [];
    const clamp = (v) => Math.min(100, Math.max(0, v));
    const out = [];
    for (const el of svg.querySelectorAll("rect,ellipse,circle,polygon")) {
      if ((el.getAttribute("fill") || "").toLowerCase() === "none") continue;
      const n = (a) => parseFloat(el.getAttribute(a)) || 0;
      let x, y, w, h;
      const tag = el.tagName.toLowerCase();
      if (tag === "rect") { x = n("x"); y = n("y"); w = n("width"); h = n("height"); }
      else if (tag === "ellipse") { x = n("cx") - n("rx"); y = n("cy") - n("ry"); w = 2 * n("rx"); h = 2 * n("ry"); }
      else if (tag === "circle") { x = n("cx") - n("r"); y = n("cy") - n("r"); w = h = 2 * n("r"); }
      else { // polygon → 외접 사각형
        const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
        if (pts.length < 4 || pts.some(v => !isFinite(v))) continue;
        const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
        x = Math.min(...xs); y = Math.min(...ys);
        w = Math.max(...xs) - x; h = Math.max(...ys) - y;
      }
      if (w > 0 && h > 0) {
        out.push({ x: clamp(x / W * 100), y: clamp(y / H * 100), w: clamp(w / W * 100), h: clamp(h / H * 100) });
      }
    }
    return out;
  }

  async function parseIOEnhanced(fields, readMediaText, importImage) {
    const names = [];
    for (const f of fields) {
      for (const m of f.matchAll(/<img[^>]+src=["']?([^"'>\s]+)/gi)) names.push(decodeURIComponent(m[1]));
    }
    const qName = names.find(n => /[-_]Q\.svg$/i.test(n));
    const baseName = names.find(n => !/\.svg$/i.test(n));
    if (!qName || !baseName) return null;

    const qShapes = svgShapes(await readMediaText(qName));
    if (!qShapes.length) return null;
    const aName = names.find(n => /[-_]A\.svg$/i.test(n));
    const aShapes = aName ? svgShapes(await readMediaText(aName)) : [];

    const key = (r) => [r.x, r.y, r.w, r.h].map(v => Math.round(v * 10)).join(",");
    const aKeys = new Set(aShapes.map(key));
    let rects = qShapes.map(r => ({ ...r, g: aKeys.has(key(r)) ? 0 : 1 }));
    if (!rects.some(r => r.g === 1)) rects = rects.map(r => ({ ...r, g: 1 }));

    const imageId = await importImage(baseName);
    if (!imageId) return null;

    // 필드0은 숨김 ID — 텍스트는 그 뒤 필드에서 가져온다 (헤더 → 앞, 각주 등 → 뒤)
    const texts = fields.slice(1).filter(f => !/<img/i.test(f)).map(htmlToText).filter(Boolean);
    return [{
      type: "occlusion", imageId, rects, hideGroup: 1,
      occMode: rects.some(r => r.g === 0) ? "all" : "one",
      front: texts[0] || "", back: texts.slice(1).join("\n"),
    }];
  }

  // 프로미스가 정해진 시간 내에 안 끝나면 실패시킨다 (무한 대기 방지)
  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  }

  // Anki 덱 계층 읽기: did → 이름("A::B::C"). 구형은 col.decks JSON, 신형은 decks 테이블.
  function readDeckNames(db) {
    const map = {};
    try {
      const r = db.exec("select decks from col limit 1");
      if (r.length && r[0].values[0][0]) {
        const decks = JSON.parse(r[0].values[0][0]);
        for (const id in decks) if (decks[id] && decks[id].name) map[id] = decks[id].name;
      }
    } catch { /* 스키마 차이 무시 */ }
    try {
      const r = db.exec("select id, name from decks");
      if (r.length) for (const [id, name] of r[0].values) if (name) map[String(id)] = name;
    } catch { /* decks 테이블 없음(구형) */ }
    return map;
  }

  // 노트 → 덱 매핑 (cards.nid → cards.did). 노트의 첫 카드 덱을 대표로 삼는다.
  function readNoteDeck(db) {
    const map = {};
    try {
      const r = db.exec("select nid, did from cards");
      if (r.length) for (const [nid, did] of r[0].values) {
        const k = String(nid);
        if (!(k in map)) map[k] = String(did);
      }
    } catch { /* cards 테이블 못 읽으면 단일 덱으로 폴백 */ }
    return map;
  }

  async function importFile(file, deckId, onProgress = () => {}) {
    onProgress(t("imp.parsing"));

    // WASM 엔진이 로드가 막히면(예: 호스트 rate-limit) 무한 대기 대신 명확히 실패
    const [SQL, zip] = await Promise.all([
      withTimeout(getSql(), 25000, "engine_timeout"),
      JSZip.loadAsync(await file.arrayBuffer()),
    ]);

    // 신형이 있으면 우선 — 신형 zip에는 "업데이트 안내" 스텁 anki2가 함께 들어있다
    const dbEntry = zip.file("collection.anki21b")
      || zip.file("collection.anki21")
      || zip.file("collection.anki2");
    if (!dbEntry) throw new Error("apkg_nodb");

    const dbBytes = maybeUnzstd(new Uint8Array(await dbEntry.async("arraybuffer")));
    const db = new SQL.Database(dbBytes);

    let notes;
    try {
      notes = db.exec("select id, flds from notes");
    } finally {
      // exec 실패 시에도 WASM 힙은 해제
      if (!notes) db.close();
    }
    if (!notes.length) { db.close(); return { added: 0 }; }

    const deckNames = readDeckNames(db); // did → "A::B"
    const noteDeck = readNoteDeck(db);   // nid → did

    // media 매핑: zip 항목 이름(숫자 키) → 파일명
    // 구형은 JSON {"0":"photo.jpg"}, 신형은 zstd protobuf
    let mediaMap = {};
    const mediaEntry = zip.file("media");
    if (mediaEntry) {
      try {
        const raw = maybeUnzstd(new Uint8Array(await mediaEntry.async("arraybuffer")));
        const text = new TextDecoder().decode(raw);
        mediaMap = text.trimStart().startsWith("{") ? JSON.parse(text) : parseMediaEntries(raw);
      } catch { /* 무시 — 매핑 없으면 이미지만 빠진다 */ }
    }
    const nameToZipKey = {};
    for (const [k, v] of Object.entries(mediaMap)) nameToZipKey[v] = k;

    let mediaBytes = 0;
    const mediaCache = {}; // filename → mediaId | null
    async function importImage(name) {
      if (name in mediaCache) return mediaCache[name];
      const key = nameToZipKey[name];
      const mime = extToMime(name);
      const entry = key != null && zip.file(String(key));
      if (!entry || !mime || mediaBytes > MEDIA_BUDGET) return (mediaCache[name] = null);
      const buf = maybeUnzstd(new Uint8Array(await entry.async("arraybuffer"))); // 신형은 파일도 zstd
      mediaBytes += buf.byteLength;
      if (mediaBytes > MEDIA_BUDGET) return (mediaCache[name] = null);
      const dataURL = `data:${mime};base64,${bufToBase64(buf)}`;
      return (mediaCache[name] = Store.addMedia(dataURL));
    }

    // 마스크 SVG처럼 저장하지 않고 내용만 읽을 파일
    async function readMediaText(name) {
      const k = nameToZipKey[name];
      const entry = k != null && zip.file(String(k));
      if (!entry) return null;
      return new TextDecoder().decode(maybeUnzstd(new Uint8Array(await entry.async("arraybuffer"))));
    }

    const rows = [];
    const clozeRe = /\{\{c\d+::/;
    for (const [nid, flds] of notes[0].values) {
      const deckName = deckNames[noteDeck[String(nid)]] || null; // 이 노트가 속한 Anki 덱
      const produced = []; // 이 노트가 만든 카드들
      const fields = String(flds).split(FIELD_SEP);
      const rawFront = fields[0] || "";
      const rawBack = fields.slice(1).filter(f => f.trim()).join("\n");

      // Anki Image Occlusion 노트 — cloze보다 먼저 확인해야 한다
      if (fields.some(f => f.includes("image-occlusion:"))) {
        const ioRows = await parseIONote(fields, importImage);
        if (ioRows) produced.push(...ioRows);
      } else if (fields.some(f => /[-_][QA]\.svg/i.test(f))) {
        // Image Occlusion Enhanced(애드온) 노트 — SVG 마스크
        const ioRows = await parseIOEnhanced(fields, readMediaText, importImage);
        if (ioRows) produced.push(...ioRows);
      } else if (clozeRe.test(rawFront) || clozeRe.test(rawBack)) {
        // cloze 노트: c1, c2… 마다 카드 1장
        const text = htmlToText((rawFront + "\n" + rawBack).trim());
        const indices = [...new Set([...text.matchAll(/\{\{c(\d+)::/g)].map(m => Number(m[1])))];
        for (const idx of indices.sort((a, b) => a - b)) {
          produced.push({ type: "cloze", front: text, back: "", clozeIndex: idx });
        }
      } else {
        const front = htmlToText(rawFront);
        const back = htmlToText(rawBack);
        if (front || back) {
          const row = { type: "basic", front: front || "…", back: back || "…" };
          const fImg = firstImageName(rawFront);
          const bImg = firstImageName(rawBack);
          if (fImg) row.frontImageId = await importImage(fImg);
          if (bImg) row.backImageId = await importImage(bImg);
          if (!row.frontImageId) delete row.frontImageId;
          if (!row.backImageId) delete row.backImageId;
          produced.push(row);
        }
      }

      for (const r of produced) { r._deck = deckName; rows.push(r); }
    }
    db.close();

    if (!rows.length) return { added: 0 };
    return distributeIntoDecks(rows, deckId, file);
  }

  // rows를 Anki 덱(_deck) 기준으로 분류해 저장한다.
  // 서브덱이 하나뿐이면 선택한 덱에, 여럿이면 폴더+덱으로 재현한다.
  function distributeIntoDecks(rows, targetDeckId, file) {
    const groups = new Map(); // deckName|null → rows[]
    for (const r of rows) {
      const key = r._deck || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
      delete r._deck;
    }

    const distinct = [...groups.keys()].filter(Boolean);
    if (distinct.length <= 1) {
      const ok = Store.bulkAddCards(targetDeckId, rows);
      if (!ok) throw new Error("storage_full");
      return { added: rows.length, decks: 1 };
    }

    // 여러 서브덱: 공통 최상위 이름을 폴더로, 각 Anki 덱을 Petale 덱으로
    const paths = distinct.map(n => n.split("::"));
    const topLevel = paths[0][0];
    const sameTop = paths.every(p => p[0] === topLevel);
    const folderName = (sameTop ? topLevel : (file?.name || "").replace(/\.apkg$/i, "")) || "Imported";
    const folder = Store.addFolder(folderName, "i-layers", "#8d9663");

    let added = 0, deckCount = 0;
    for (const [name, grp] of groups) {
      let label;
      if (!name) label = "Default";
      else if (sameTop) label = name.split("::").slice(1).join(" · ") || topLevel;
      else label = name.split("::").join(" · ");
      const d = Store.addDeck(label, "");
      Store.patchDeck(d.id, { folderId: folder.id });
      const ok = Store.bulkAddCards(d.id, grp);
      if (!ok) throw new Error("storage_full");
      added += grp.length;
      deckCount++;
    }
    return { added, decks: deckCount, folder: folderName };
  }

  return { importFile };
})();
