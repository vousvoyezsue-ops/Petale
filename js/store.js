/* ═══════════════════════════════════════════════════════
   Petale Store — localStorage 영속화 계층
   card.type: 'basic' | 'cloze' | 'occlusion'
   ═══════════════════════════════════════════════════════ */

const Store = (() => {
  const KEY = "petale.v1";        // 덱·카드·설정 (작음)
  const MEDIA_KEY = "petale.media"; // 이미지 dataURL 모음 (큼, 변경 시에만 기록)

  let state = null;
  let onSaveCb = null;   // 저장 직후 훅 (클라우드 동기화용)
  let quotaCb = null;    // 저장 용량 초과 알림
  let writeTimer = null; // 디바운스 기록 타이머
  let mediaDirty = true; // media가 마지막 기록 이후 바뀌었는지

  /* ── IndexedDB 키-값 저장 (localStorage보다 용량이 훨씬 큼) ── */
  const DB_NAME = "petale", DB_STORE = "kv";
  let dbPromise = null;
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const r = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("abort"));
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const DEFAULT_SETTINGS = { lang: "ko", theme: "pearl", tts: true, steps: SRS.defaultSteps() };

  // 첫 실행 시 빈 상태로 시작한다 (예시 덱을 자동으로 만들지 않음).
  function seed() {
    const now = Date.now();
    return {
      decks: [],
      cards: [],
      media: {},   // { mediaId: dataURL }
      reviews: {}, // { "YYYY-MM-DD": count }
      newLog: {},  // { "deckId|YYYY-MM-DD": 오늘 시작한 새 카드 수 }
      folders: [],
      ratingCounts: { 0: 0, 1: 0, 2: 0, 3: 0 },
      settings: { ...DEFAULT_SETTINGS },
      updatedAt: now, // 마지막 변경 시각 — 클라우드 동기화 충돌 판정용
    };
  }

  // 임의 데이터를 정규화한 state 객체로 (서버 pull·JSON 가져오기 공용)
  function normalize(data) {
    const s = {
      decks: Array.isArray(data.decks) ? data.decks : [],
      cards: Array.isArray(data.cards) ? data.cards : [],
      media: data.media || {},
      reviews: data.reviews || {},
      newLog: data.newLog || {},
      folders: data.folders || [],
      ratingCounts: data.ratingCounts || { 0: 0, 1: 0, 2: 0, 3: 0 },
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      updatedAt: data.updatedAt || Date.now(),
    };
    s.cards.forEach(c => { c.type ??= "basic"; });
    s.decks.forEach(d => { d.newPerDay ??= 20; });
    return s;
  }

  // 비동기 로드: IndexedDB → (없으면) localStorage 마이그레이션 → (없으면) seed
  async function load() {
    try {
      let rest = await idbGet(KEY);
      let media = await idbGet(MEDIA_KEY);
      if (!rest) {
        // 구버전 localStorage 데이터 1회 이관
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const d = JSON.parse(raw);
          rest = d; media = d.media;
        }
      }
      if (rest) {
        state = normalize({ ...rest, media: media || rest.media || {} });
        mediaDirty = true;      // 첫 flush 때 media도 기록(이관 완료)
        await flush();
        try { localStorage.removeItem(KEY); } catch { /* 용량 회수 */ }
        return state;
      }
    } catch (e) { /* 손상/미지원 시 새로 시작 */ }
    state = seed();
    mediaDirty = true;
    await flush();
    return state;
  }

  // 실제 IndexedDB 기록: state(작음)는 항상, media(큼)는 변경 시에만.
  async function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    try {
      const { media, ...rest } = state;
      await idbSet(KEY, rest);
      if (mediaDirty) { await idbSet(MEDIA_KEY, media); mediaDirty = false; }
      return true;
    } catch (e) {
      if (quotaCb) quotaCb(e);
      return false;
    }
  }

  // touch=true(기본): 변경 시각 갱신 + 동기화 훅 호출.
  // touch=false: 서버에서 받은 데이터를 반영할 때 — 시각을 건드리지 않고 훅도 안 쏜다.
  // 기록은 디바운스로 비동기 처리(대용량 이미지 저장이 UI를 막지 않음). 낙관적으로 true 반환.
  function save(opts = {}) {
    const touch = opts.touch !== false;
    if (touch) state.updatedAt = Date.now();
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { flush(); }, 250);
    if (touch && onSaveCb) { try { onSaveCb(); } catch { /* 동기화 실패가 앱을 막지 않게 */ } }
    return true;
  }

  // 탭을 닫거나 숨길 때 대기 중인 기록을 즉시 반영
  if (typeof window !== "undefined") {
    const flushNow = () => { if (writeTimer) flush(); };
    window.addEventListener("visibilitychange", () => { if (document.hidden) flushNow(); });
    window.addEventListener("pagehide", flushNow);
  }

  // 저장 훅 등록/해제 (로그인 시 클라우드 푸시 예약, 로그아웃 시 해제)
  function setOnSave(fn) { onSaveCb = fn; }
  // 저장 용량 초과 알림 등록
  function setQuotaHandler(fn) { quotaCb = fn; }

  // 서버 컬렉션을 로컬로 반영 (pull). updatedAt은 서버 값 유지, 훅 미발동.
  // 이미지는 서버에 없으므로(기기 로컬 보관) 로컬 media를 유지한다.
  function replaceState(data) {
    const localMedia = (state && state.media) || {};
    const media = (data.media && Object.keys(data.media).length) ? data.media : localMedia;
    state = normalize({ ...data, media });
    mediaDirty = true;
    save({ touch: false });
  }

  // 새 계정 로그인 시 이전 사용자 데이터가 섞이지 않도록 초기 상태로 리셋
  function reset() {
    state = seed();
    mediaDirty = true;
    save({ touch: false });
    return state;
  }

  /* ── settings ── */
  function setSetting(key, value) {
    state.settings[key] = value;
    save();
  }
  // 학습 단계(새 카드 '다시'/'어려움', 복습 실패 간격) 저장 + SRS 엔진에 즉시 반영
  function setSteps(partial) {
    state.settings.steps = { ...(state.settings.steps || SRS.defaultSteps()), ...partial };
    SRS.setSteps(state.settings.steps);
    save();
  }

  /* ── decks ── */
  function addDeck(name, desc, newPerDay = 20) {
    const deck = { id: uid(), name, desc, newPerDay, created: Date.now() };
    state.decks.push(deck);
    save();
    return deck;
  }
  function updateDeck(id, name, desc, newPerDay) {
    const d = state.decks.find(x => x.id === id);
    if (d) {
      d.name = name; d.desc = desc;
      if (newPerDay != null) d.newPerDay = newPerDay;
      save();
    }
  }
  function deleteDeck(id) {
    state.decks = state.decks.filter(d => d.id !== id);
    state.cards = state.cards.filter(c => c.deckId !== id);
    gcMedia();
    save();
  }
  // 여러 덱을 한 번에 삭제(다중 선택용) — save()를 한 번만 호출한다.
  function deleteDecks(ids) {
    const kill = new Set(ids);
    state.decks = state.decks.filter(d => !kill.has(d.id));
    state.cards = state.cards.filter(c => !kill.has(c.deckId));
    gcMedia();
    save();
  }
  function getDeck(id) { return state.decks.find(d => d.id === id); }

  // 이름/설명/한도 외의 필드(폴더, 공유 상태 등)를 부분 갱신
  function patchDeck(id, patch) {
    const d = state.decks.find(x => x.id === id);
    if (d) { Object.assign(d, patch); save(); }
  }

  /* ── folders ── */
  function addFolder(name, icon, color) {
    const folder = { id: uid(), name, icon, color };
    state.folders.push(folder);
    save();
    return folder;
  }
  function updateFolder(id, patch) {
    const f = state.folders.find(x => x.id === id);
    if (f) { Object.assign(f, patch); save(); }
  }
  function deleteFolder(id) {
    state.folders = state.folders.filter(f => f.id !== id);
    state.decks.forEach(d => { if (d.folderId === id) d.folderId = null; });
    save();
  }
  function getFolder(id) { return state.folders.find(f => f.id === id); }

  /* ── media ── */
  function addMedia(dataURL) {
    const id = uid();
    state.media[id] = dataURL;
    mediaDirty = true;
    return id;
  }
  function getMedia(id) { return state.media[id]; }
  // 다른 기기에서 받은 이미지를 로컬에 넣는다 (동기화 하강). 시각/훅 건드리지 않음.
  function putMedia(id, dataURL) {
    if (!id || !dataURL || state.media[id]) return;
    state.media[id] = dataURL;
    mediaDirty = true;
    save({ touch: false });
  }
  // 카드가 참조하는 모든 미디어 id
  function referencedMedia() {
    return [...new Set(
      state.cards.flatMap(c => [c.imageId, c.frontImageId, c.backImageId]).filter(Boolean)
    )];
  }
  function gcMedia() {
    const used = new Set(
      state.cards.flatMap(c => [c.imageId, c.frontImageId, c.backImageId]).filter(Boolean)
    );
    for (const id of Object.keys(state.media)) {
      if (!used.has(id)) { delete state.media[id]; mediaDirty = true; }
    }
  }

  /* ── cards ── */
  function addCard(deckId, fields) {
    const card = {
      id: uid(),
      deckId,
      type: "basic",
      created: Date.now(),
      ...fields,
      ...SRS.newCardState(),
    };
    state.cards.push(card);
    const ok = save();
    return ok ? card : null;
  }
  function updateCard(id, fields) {
    const c = state.cards.find(x => x.id === id);
    if (c) { Object.assign(c, fields); save(); }
  }
  function deleteCard(id) {
    state.cards = state.cards.filter(c => c.id !== id);
    gcMedia();
    save();
  }
  // 여러 카드를 한 번에 삭제(다중 선택용) — save()를 한 번만 호출한다.
  function deleteCards(ids) {
    const kill = new Set(ids);
    state.cards = state.cards.filter(c => !kill.has(c.id));
    gcMedia();
    save();
  }
  function cardsOf(deckId) { return state.cards.filter(c => c.deckId === deckId); }

  // 대량 추가(가져오기): [{type, front, back, imageId, rects, hideIndex, clozeIndex}, …]
  function bulkAddCards(deckId, rows) {
    const now = Date.now();
    rows.forEach((row, i) => {
      state.cards.push({
        id: uid() + i.toString(36),
        deckId,
        type: "basic",
        created: now,
        ...row,
        ...SRS.newCardState(),
      });
    });
    return save();
  }

  // 평가 적용. 실행 취소용 스냅샷을 반환한다.
  function applyReview(cardId, rating) {
    const c = state.cards.find(x => x.id === cardId);
    if (!c) return null;
    const prev = { ef: c.ef, interval: c.interval, reps: c.reps, lapses: c.lapses, due: c.due };
    const wasNew = SRS.isNew(c);
    Object.assign(c, SRS.schedule(c, rating));
    const key = todayKey();
    state.reviews[key] = (state.reviews[key] || 0) + 1;
    state.ratingCounts[rating] = (state.ratingCounts[rating] || 0) + 1;
    if (wasNew) {
      const nk = `${c.deckId}|${key}`;
      state.newLog[nk] = (state.newLog[nk] || 0) + 1;
    }
    save();
    return { cardId, deckId: c.deckId, prev, rating, wasNew };
  }

  // applyReview의 반환값으로 마지막 평가를 되돌린다
  function undoReview(entry) {
    const c = state.cards.find(x => x.id === entry.cardId);
    if (!c) return;
    Object.assign(c, entry.prev);
    const key = todayKey();
    if (state.reviews[key] > 0) state.reviews[key]--;
    if (state.ratingCounts[entry.rating] > 0) state.ratingCounts[entry.rating]--;
    if (entry.wasNew) {
      const nk = `${entry.deckId}|${key}`;
      if (state.newLog[nk] > 0) state.newLog[nk]--;
    }
    save();
  }

  function newIntroducedToday(deckId) {
    return state.newLog[`${deckId}|${todayKey()}`] || 0;
  }

  /* ── stats ── */
  function deckCounts(deckId, now = Date.now()) {
    const cards = cardsOf(deckId);
    const active = cards.filter(c => !c.suspended);
    return {
      total: cards.length,
      neu: active.filter(SRS.isNew).length,
      due: active.filter(c => !SRS.isNew(c) && SRS.isDue(c, now)).length,
    };
  }

  // 향후 days일 동안 예정된 복습 수 (오늘 = 밀린 카드 포함)
  function forecast(days = 7, now = Date.now()) {
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const out = new Array(days).fill(0);
    for (const c of state.cards) {
      if (SRS.isNew(c)) continue;
      const diff = c.due - endOfToday.getTime();
      const idx = diff <= 0 ? 0 : Math.ceil(diff / SRS.DAY);
      if (idx < days) out[idx]++;
    }
    return out;
  }

  // 정착률: '다시'가 아닌 평가의 비율
  function retention() {
    const rc = state.ratingCounts;
    const total = (rc[0] || 0) + (rc[1] || 0) + (rc[2] || 0) + (rc[3] || 0);
    if (!total) return null;
    return Math.round(((total - (rc[0] || 0)) / total) * 100);
  }

  function exportDeckCSV(deckId) {
    const esc = (s) => `"${String(s).replaceAll('"', '""')}"`;
    const rows = cardsOf(deckId)
      .filter(c => c.type !== "occlusion")
      .map(c => `${esc(c.front)},${esc(c.type === "cloze" ? `cloze c${c.clozeIndex}` : c.back)}`);
    return "front,back\n" + rows.join("\n");
  }

  function streak(now = Date.now()) {
    let n = 0;
    let t = now;
    // 오늘 학습이 없어도 어제까지 이어졌으면 유지된 것으로 본다
    if (!state.reviews[todayKey(t)]) t -= SRS.DAY;
    while (state.reviews[todayKey(t)]) { n++; t -= SRS.DAY; }
    return n;
  }

  /* ── import / export ── */
  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }
  function importJSON(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.decks) || !Array.isArray(data.cards)) {
      throw new Error("bad_file");
    }
    state = normalize(data);
    save();
  }

  return {
    load, save, flush, todayKey, uid,
    setOnSave, setQuotaHandler, replaceState, reset,
    setSetting, setSteps,
    addDeck, updateDeck, deleteDeck, deleteDecks, getDeck, patchDeck,
    addFolder, updateFolder, deleteFolder, getFolder,
    addMedia, getMedia, putMedia, referencedMedia, gcMedia,
    addCard, updateCard, deleteCard, deleteCards, cardsOf, bulkAddCards,
    applyReview, undoReview, newIntroducedToday,
    deckCounts, streak, forecast, retention, exportDeckCSV,
    exportJSON, importJSON,
    get state() { return state; },
    get settings() { return state.settings; },
  };
})();
