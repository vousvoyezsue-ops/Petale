/* ═══════════════════════════════════════════════════════
   Petale App — 화면 전환 · 학습 흐름 · 상호작용
   ═══════════════════════════════════════════════════════ */

(async () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  await Store.load(); // IndexedDB에서 비동기 로드
  Store.setQuotaHandler(() => toast(t("toast.storageFull")));
  I18N.setLang(Store.settings.lang);
  document.documentElement.dataset.theme = Store.settings.theme;
  SRS.setSteps(Store.settings.steps); // 저장된 학습 단계(s/m/h/day) 스케줄러에 반영

  /* ── 상태 ── */
  let currentDeckId = null;
  let editingCardId = null;
  let editingOccCardId = null;
  let editingDeck = false;
  let selectMode = false;        // 홈 화면 덱 다중 선택 모드
  let selectedDecks = new Set(); // 선택된 덱 id
  let cardSelectMode = false;    // 덱 상세 카드 다중 선택 모드
  let selectedCards = new Set(); // 선택된 카드 id
  let cardType = "basic";       // 카드 모달의 현재 타입
  let session = null;           // { queue: [cardId], done, total, flipped }
  let authMode = "signin";
  let socialReady = Social.init(); // 세션 복원 (비동기, 화면 진입 시 대기)

  /* ══════════ 학습 알림 (망각곡선/간격 반복 기반) ══════════
     SRS의 due 시각이 곧 "다시 볼 때" — 복습이 밀리면 알림으로 알려준다.
     정적 PWA라 앱이 열려 있거나 설치돼 백그라운드로 돌 때 동작한다. */
  const Reminders = (() => {
    const TAG = "petale-review-check";
    const MIN_GAP = 3 * 60 * 60 * 1000; // 같은 알림 최소 간격(과도한 반복 방지)
    let dailyTimer = null, dueTimer = null, pollTimer = null;

    const supported = () => "Notification" in window;
    const granted = () => supported() && Notification.permission === "granted";

    // 복습 대기(망각곡선상 다시 볼 때가 된) 카드 수 — 새 카드/일시정지 제외
    function dueCount() {
      const now = Date.now();
      return Store.state.cards.filter(c => !c.suspended && c.due <= now && !SRS.isNew(c)).length;
    }
    // 아직 안 왔지만 가장 가까운 다음 복습 시각
    function nextDueAt() {
      const now = Date.now();
      let min = Infinity;
      for (const c of Store.state.cards) {
        if (c.suspended || SRS.isNew(c)) continue;
        if (c.due > now && c.due < min) min = c.due;
      }
      return min === Infinity ? null : min;
    }

    function show(n) {
      if (!granted()) return;
      let last = 0;
      try { last = Number(localStorage.getItem("petale.lastNotify") || 0); } catch { /* 무시 */ }
      if (Date.now() - last < MIN_GAP) return;
      const title = t("notify.title");
      const opts = {
        body: n > 0 ? t("notify.body", { n }) : t("notify.bodyGeneric"),
        icon: "icons/icon-192.png", badge: "icons/icon-192.png",
        tag: "petale-review", renotify: true,
      };
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready
            .then(reg => reg.showNotification(title, opts))
            .catch(() => { try { new Notification(title, opts); } catch { /* 무시 */ } });
        } else { new Notification(title, opts); }
        try { localStorage.setItem("petale.lastNotify", String(Date.now())); } catch { /* 무시 */ }
      } catch { /* 무시 */ }
    }

    function scheduleDaily() {
      clearTimeout(dailyTimer);
      const [h, m] = (Store.settings.reminderTime || "09:00").split(":").map(Number);
      const now = new Date();
      const next = new Date(now);
      next.setHours(h || 9, m || 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      dailyTimer = setTimeout(() => { show(dueCount()); scheduleDaily(); }, next - now);
    }
    function scheduleNextDue() {
      clearTimeout(dueTimer);
      const at = nextDueAt();
      if (at == null) return;
      const delay = Math.min(at - Date.now(), 2 ** 31 - 1);
      if (delay <= 0) return;
      dueTimer = setTimeout(() => { show(dueCount()); scheduleNextDue(); }, delay);
    }
    function startPolling() {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { const n = dueCount(); if (n > 0) show(n); }, 30 * 60 * 1000);
    }
    async function registerPeriodicSync() {
      try {
        const reg = await navigator.serviceWorker?.ready;
        if (reg && "periodicSync" in reg) {
          const st = await navigator.permissions?.query({ name: "periodic-background-sync" }).catch(() => null);
          if (!st || st.state === "granted") {
            await reg.periodicSync.register(TAG, { minInterval: 6 * 60 * 60 * 1000 }).catch(() => {});
          }
        }
      } catch { /* 미지원 — 무시 */ }
    }

    function stop() {
      clearTimeout(dailyTimer); clearTimeout(dueTimer); clearInterval(pollTimer);
      navigator.serviceWorker?.ready
        ?.then(reg => { if ("periodicSync" in reg) reg.periodicSync.unregister(TAG).catch(() => {}); })
        .catch(() => {});
    }
    function start() {
      clearTimeout(dailyTimer); clearTimeout(dueTimer); clearInterval(pollTimer);
      if (!Store.settings.reminders || !granted()) return;
      scheduleDaily();
      scheduleNextDue();
      startPolling();
      registerPeriodicSync();
      const n = dueCount();
      if (n > 0) show(n); // 진입 시 이미 밀린 복습이 있으면 알림
    }
    async function enable() {
      if (!supported()) return "unsupported";
      let perm = Notification.permission;
      if (perm !== "granted") { try { perm = await Notification.requestPermission(); } catch { return "denied"; } }
      if (perm !== "granted") return "denied";
      Store.setSetting("reminders", true);
      start();
      return "granted";
    }
    function disable() { Store.setSetting("reminders", false); stop(); }

    // 앱이 다시 보일 때 밀린 복습 재확인
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && Store.settings?.reminders && granted()) start();
      });
    }

    return { start, stop, enable, disable, granted, supported, dueCount, nextDueAt };
  })();

  /* ══════════ 유틸 ══════════ */
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 카드 앞/뒷면 서식(굵게·밑줄·색상·하이라이트) 허용 목록 새니타이저.
  // 내가 만든 에디터가 아니라, 공유 덱으로 받아온(신뢰할 수 없는) HTML에도 항상 이 함수를 거쳐서 렌더링한다.
  const RICH_ALLOWED_TAGS = new Set(["B", "STRONG", "U", "EM", "I", "MARK", "SPAN", "BR"]);
  // 앱에 실제로 로드된 글꼴만 허용 — 없는 글꼴은 이상한 시스템 폴백으로 렌더되므로 제외한다
  const RICH_FONT_OK = /^(pretendard variable|gowun batang|cormorant garamond|serif|sans-serif|monospace)$/i;
  function sanitizeStyleDecl(style) {
    const out = [];
    for (const part of String(style || "").split(";")) {
      const m = /^\s*(color|background-color|font-family|font-size)\s*:\s*([^;]+?)\s*$/.exec(part);
      if (!m) continue;
      const prop = m[1], val = m[2];
      if ((prop === "color" || prop === "background-color") && /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/.test(val)) {
        out.push(`${prop}: ${val}`);
      } else if (prop === "font-size" && /^(x-small|small|medium|large|x-large|xx-large|xxx-large|\d{1,3}(?:\.\d+)?(?:px|em|rem|pt))$/.test(val)) {
        out.push(`${prop}: ${val}`);
      } else if (prop === "font-family") {
        const fams = val.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        if (fams.length && fams.every(f => RICH_FONT_OK.test(f))) out.push(`${prop}: ${val}`);
      }
    }
    return out.join("; ");
  }
  function sanitizeRichHTML(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = doc.body.firstChild;
    (function clean(node) {
      [...node.childNodes].forEach(child => {
        if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
                if (child.nodeType !== Node.ELEMENT_NODE) return; // 텍스트 노드는 그대로 둔다
        const tag = child.tagName;
        if (tag === "DIV" || tag === "P") {
          // 브라우저가 Enter 입력마다 만드는 줄바꿈용 블록 — 내부 서식은 유지한 채 <br>로 바꾼다
          clean(child);
          // 빈 줄용 <div><br></div> 는 filler <br> 하나만 들었다 — 앞에 넣는 <br>와 겹쳐 줄바꿈이 배로 늘어나므로 하나만 남긴다
          const onlyBr = child.childNodes.length === 1 && child.firstChild.nodeName === "BR";
          const hadPrev = !!child.previousSibling;
          if (hadPrev) child.parentNode.insertBefore(document.createElement("br"), child);
          if (onlyBr && hadPrev) { child.remove(); return; }
          while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
          child.remove();
          return;
        }
        if (!RICH_ALLOWED_TAGS.has(tag)) {
          child.replaceWith(document.createTextNode(child.textContent));
          return;
        }
        [...child.attributes].forEach(attr => {
          // 색·글꼴 style은 허용 태그(굵게·밑줄 등 포함) 어디서나 유지 — 값은 sanitizeStyleDecl로 엄격 검증
          if (attr.name === "style") {
            const safe = sanitizeStyleDecl(attr.value);
            if (safe) child.setAttribute("style", safe); else child.removeAttribute("style");
          } else {
            child.removeAttribute(attr.name);
          }
        });
        clean(child);
      });
    })(root);
    return root.innerHTML;
  }

  // contenteditable 서식 필드 읽기/쓰기 헬퍼
  function getRich(el) { return sanitizeRichHTML(el.innerHTML).trim() === "<br>" ? "" : sanitizeRichHTML(el.innerHTML); }
  function setRich(el, html) { el.innerHTML = sanitizeRichHTML(html || ""); }
  function richIsEmpty(el) { return !el.textContent.trim(); }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  function clozeIndices(text) {
    return [...new Set([...text.matchAll(/\{\{c(\d+)::/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  }

  function renderCloze(text, targetIdx, revealed) {
    // 전체를 먼저 새니타이즈해 태그 짝을 보존한다 ({{ }}는 텍스트라 그대로 남음).
    // 이렇게 하면 <b>{{c1::답}}</b> 처럼 빈칸 토큰을 감싼 서식도 살아남는다.
    const safe = sanitizeRichHTML(text);
    let html = "";
    let last = 0;
    for (const m of safe.matchAll(CLOZE_RE)) {
      html += safe.slice(last, m.index);
      const idx = Number(m[1]);
      const answer = m[2];       // 이미 새니타이즈된 HTML
      const hint = m[3];
      if (idx === targetIdx) {
        html += revealed
          ? `<span class="cloze-answer">${answer}</span>`
          : `<span class="cloze-blank">${hint || "⋯"}</span>`;
      } else {
        html += answer;
      }
      last = m.index + m[0].length;
    }
    html += safe.slice(last);
    return html;
  }

  function clozeStrip(text) {
    return text.replace(CLOZE_RE, (_, i, ans) => ans);
  }

  // 카드 목록/미리보기용 표시 텍스트
  function cardPreview(card) {
    if (card.type === "occlusion") {
      return { front: card.front || `🖼 ${t("type.occlusion")} #${card.hideIndex + 1}`, back: "" };
    }
    if (card.type === "cloze") {
      return { front: clozeStrip(card.front), back: `${t("type.cloze")} c${card.clozeIndex}` };
    }
    return { front: card.front, back: card.back };
  }

  /* ══════════ 화면 전환 ══════════ */
  const views = ["home", "deck", "study", "stats", "friends", "quiz", "write", "match", "flash", "explore"];

  function show(view) {
    Practice.stopMatchTimer(); // 매치 중 다른 화면으로 이탈 시 타이머 정리
    document.body.dataset.view = view;
    views.forEach(v => $(`#view-${v}`).classList.toggle("hidden", v !== view));
    $$(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    if (view === "home") renderHome();
    if (view === "deck") renderDeck();
    if (view === "stats") renderStats();
    if (view === "friends") renderFriends();
    if (view === "explore") renderExplore();
    window.scrollTo({ top: 0 });
  }

  $("#brandHome").addEventListener("click", () => show("home"));
  $$(".nav-link").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  $$("[data-back]").forEach(b => b.addEventListener("click", () => show(b.dataset.back)));

  /* ══════════ 폴더 ══════════ */
  const FOLDER_ICONS = ["i-flower", "i-flame", "i-layers", "i-sparkle", "i-target",
                        "i-box", "i-pencil", "i-star", "i-grid", "i-timer"];
  const FOLDER_COLORS = ["#c97f97", "#8d9663", "#b9975a", "#8f81c2",
                         "#6d92b0", "#b3798f", "#6d7548", "#97988a"];

  const STARRED = "__starred__"; // 별표 필터 센티넬
  let currentFolder = null; // null = 전체, STARRED = 별표덱만, 그 외 = 폴더 id
  let editingFolderId = null;
  let pickedIcon = FOLDER_ICONS[0];
  let pickedColor = FOLDER_COLORS[0];

  function renderFolderBar() {
    const bar = $("#folderBar");
    const folders = Store.state.folders;
    if (currentFolder && currentFolder !== STARRED && !Store.getFolder(currentFolder)) currentFolder = null;
    const anyStarred = Store.state.decks.some(d => d.starred);
    if (currentFolder === STARRED && !anyStarred) currentFolder = null;

    bar.innerHTML = `
      <button class="fchip ${!currentFolder ? "active" : ""}" data-folder="">${t("folder.all")}</button>
      ${anyStarred ? `<button class="fchip star ${currentFolder === STARRED ? "active" : ""}" data-folder="${STARRED}">
        <svg width="13" height="13"><use href="#i-star"/></svg><span>${t("folder.starred")}</span></button>` : ""}
      ${folders.map(f => `
        <button class="fchip folder ${currentFolder === f.id ? "active" : ""}" data-folder="${f.id}"
          style="--fc:${f.color}">
          <svg width="13" height="13"><use href="#${f.icon}"/></svg>
          <span>${escapeHTML(f.name)}</span>
          ${currentFolder === f.id ? `<i class="fchip-edit" title="${t("folder.titleEdit")}">✎</i>` : ""}
        </button>`).join("")}
      <button class="fchip add" id="fchipAdd">${t("folder.new")}</button>`;

    bar.querySelectorAll(".fchip[data-folder]").forEach(chip => {
      chip.addEventListener("click", (e) => {
        const id = chip.dataset.folder || null;
        if (e.target.closest(".fchip-edit")) { openFolderModal(id); return; }
        currentFolder = id;
        renderHome();
      });
    });
    $("#fchipAdd")?.addEventListener("click", () => openFolderModal(null));
  }

  function openFolderModal(folderId) {
    editingFolderId = folderId;
    const folder = folderId ? Store.getFolder(folderId) : null;
    $("#folderModalTitle").textContent = folder ? t("folder.titleEdit") : t("folder.titleNew");
    $("#folderNameInput").value = folder ? folder.name : "";
    pickedIcon = folder?.icon || FOLDER_ICONS[0];
    pickedColor = folder?.color || FOLDER_COLORS[0];
    $("#folderDelete").classList.toggle("hidden", !folder);
    renderFolderPickers();
    $("#folderModal").showModal();
  }

  function renderFolderPickers() {
    $("#folderIconGrid").innerHTML = FOLDER_ICONS.map(ic => `
      <button type="button" class="pick ${ic === pickedIcon ? "active" : ""}" data-icon="${ic}" style="--fc:${pickedColor}">
        <svg width="17" height="17"><use href="#${ic}"/></svg>
      </button>`).join("");
    $("#folderColorGrid").innerHTML = FOLDER_COLORS.map(c => `
      <button type="button" class="pick color ${c === pickedColor ? "active" : ""}" data-color="${c}"
        style="--fc:${c}"></button>`).join("");
    $("#folderIconGrid").querySelectorAll(".pick").forEach(b =>
      b.addEventListener("click", () => { pickedIcon = b.dataset.icon; renderFolderPickers(); }));
    $("#folderColorGrid").querySelectorAll(".pick").forEach(b =>
      b.addEventListener("click", () => { pickedColor = b.dataset.color; renderFolderPickers(); }));
  }

  $("#folderForm").addEventListener("submit", () => {
    const name = $("#folderNameInput").value.trim();
    if (!name) return;
    if (editingFolderId) {
      Store.updateFolder(editingFolderId, { name, icon: pickedIcon, color: pickedColor });
    } else {
      const f = Store.addFolder(name, pickedIcon, pickedColor);
      currentFolder = f.id;
    }
    toast(t("toast.folderSaved"));
    renderHome();
  });

  $("#folderDelete").addEventListener("click", () => {
    const folder = Store.getFolder(editingFolderId);
    if (!folder) return;
    $("#folderModal").close();
    confirmDialog(t("folder.deleteTitle", { name: folder.name }), t("folder.deleteText"), () => {
      Store.deleteFolder(editingFolderId);
      if (currentFolder === editingFolderId) currentFolder = null;
      toast(t("toast.folderDeleted"));
      renderHome();
    });
  });

  /* ══════════ 홈 ══════════ */
  function renderHome() {
    renderFolderBar();
    const grid = $("#deckGrid");
    const decks = Store.state.decks
      .filter(d => currentFolder === STARRED
        ? d.starred
        : (!currentFolder || d.folderId === currentFolder))
      .slice()
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)); // 별표 덱 먼저 (그 외 순서 유지)

    let totalDue = 0, totalNew = 0;
    const cardsHTML = decks.map((deck, i) => {
      const c = Store.deckCounts(deck.id);
      totalDue += c.due; totalNew += c.neu;
      const learned = c.total ? Math.round(((c.total - c.neu) / c.total) * 100) : 0;
      const folder = deck.folderId ? Store.getFolder(deck.folderId) : null;
      const picked = selectedDecks.has(deck.id);
      return `
        <article class="deck-card ${selectMode ? "select-mode" : ""} ${picked ? "picked" : ""}" data-deck="${deck.id}" tabindex="0" role="button" style="--i:${i}">
          ${selectMode ? `
          <span class="deck-check ${picked ? "on" : ""}" data-pick="${deck.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </span>` : `
          <button class="deck-star ${deck.starred ? "on" : ""}" data-star="${deck.id}"
            title="${t("deck.star")}" aria-label="${t("deck.star")}">
            <svg width="17" height="17"><use href="#i-star"/></svg>
          </button>`}
          <div class="deck-main">
            <div class="deck-row-head">
              <h3>${escapeHTML(deck.name)}</h3>
              ${folder ? `<span class="folder-tag" style="--fc:${folder.color}">
                <svg width="11" height="11"><use href="#${folder.icon}"/></svg>${escapeHTML(folder.name)}</span>` : ""}
              ${deck.sharedId ? `<span class="shared-tag">${deck.visibility === "friends" ? t("share.publishedFriends") : t("share.published")}</span>` : ""}
            </div>
            ${deck.desc ? `<p class="deck-card-desc">${escapeHTML(deck.desc)}</p>` : ""}
            <div class="deck-progress">
              <div class="deck-progress-bar"><i style="width:${learned}%"></i></div>
              <span>${t("deck.learned", { pct: learned })}</span>
            </div>
          </div>
          <div class="deck-card-meta">
            ${c.due ? `<span class="pill due">${t("pill.due", { n: c.due })}</span>` : ""}
            ${c.neu ? `<span class="pill new">${t("pill.new", { n: c.neu })}</span>` : ""}
            ${!c.due && !c.neu && c.total ? `<span class="pill calm">${t("pill.rest")}</span>` : ""}
            <span class="pill total">${t("pill.total", { n: c.total })}</span>
          </div>
          <svg class="deck-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
        </article>`;
    }).join("");

    grid.innerHTML = decks.length ? cardsHTML : `
      <div class="deck-empty"><span class="big">❀</span>${t("hero.empty")}</div>`;

    grid.querySelectorAll(".deck-star").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.star;
        const d = Store.getDeck(id);
        if (!d) return;
        const on = !d.starred;
        Store.patchDeck(id, { starred: on });
        btn.classList.toggle("on", on); // 별 표시만 즉시 갱신 — 그리드 재렌더/스크롤 없음
        if (currentFolder === STARRED && !on) {
          renderHome();      // 별표 필터에서 해제 → 목록에서 빠져야 하니 이때만 재렌더
        } else {
          renderFolderBar(); // 그 외: 별표 칩만 갱신(그리드·스크롤 그대로)
        }
      });
    });

    grid.querySelectorAll(".deck-card").forEach(el => {
      const id = el.dataset.deck;
      const open = () => {
        if (selectMode) { toggleDeckPick(id); return; }
        currentDeckId = id;
        cardSelectMode = false; selectedCards.clear(); // 새 덱을 열 때 카드 선택 모드 초기화
        show("deck");
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); open(); }
      });
    });

    const waiting = totalDue + totalNew;
    $("#heroSummary").innerHTML = waiting ? t("hero.waiting", { n: waiting }) : t("hero.done");
    $("#btnStudyAll").classList.toggle("hidden", !waiting || selectMode);
    $("#btnNewDeck").classList.toggle("hidden", selectMode);
    renderTodayPlan();

    // 선택 모드 토글 버튼: 덱이 하나도 없으면 숨긴다
    $("#btnSelectMode").classList.toggle("hidden", !decks.length && !selectMode);
    $("#btnSelectMode").textContent = selectMode ? t("home.selectCancel") : t("home.select");
    renderBulkBar();
  }

  function toggleDeckPick(id) {
    if (selectedDecks.has(id)) selectedDecks.delete(id); else selectedDecks.add(id);
    renderHome();
  }

  // 오늘의 복습 계획: 복습·새 카드가 기다리는 덱을 홈 상단에 모아 보여준다.
  // 선택 모드일 땐 방해되지 않게 숨긴다.
  function renderTodayPlan() {
    const panel = $("#todayPlan");
    if (!panel) return;
    if (selectMode) { panel.classList.add("hidden"); return; }

    const plan = Store.state.decks
      .map(d => ({ deck: d, c: Store.deckCounts(d.id) }))
      .filter(x => x.c.due + x.c.neu > 0)
      .sort((a, b) => (b.c.due + b.c.neu) - (a.c.due + a.c.neu));

    const totalDue = plan.reduce((s, x) => s + x.c.due, 0);
    const totalNew = plan.reduce((s, x) => s + x.c.neu, 0);

    panel.classList.remove("hidden");
    const sub = $("#todayPlanSub");
    const list = $("#todayPlanList");

    if (!plan.length) {
      sub.textContent = "";
      list.innerHTML = `<p class="today-plan-empty">${t("today.allDone")}</p>`;
      return;
    }

    sub.textContent = t("today.summary", { due: totalDue, neu: totalNew });
    list.innerHTML = plan.map(({ deck, c }) => `
      <button type="button" class="today-row" data-deck="${deck.id}">
        <span class="today-row-name">${escapeHTML(deck.name)}</span>
        <span class="today-row-counts">
          ${c.due ? `<span class="pill due">${t("pill.due", { n: c.due })}</span>` : ""}
          ${c.neu ? `<span class="pill new">${t("pill.new", { n: c.neu })}</span>` : ""}
        </span>
        <svg class="today-row-go" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none"/></svg>
      </button>`).join("");

    list.querySelectorAll(".today-row").forEach(row => {
      row.addEventListener("click", () => startSession(row.dataset.deck));
    });
  }

  function renderBulkBar() {
    const bar = $("#bulkBar");
    const show = selectMode && selectedDecks.size > 0;
    bar.classList.toggle("show", show);
    $("#bulkCount").textContent = t("home.selectedCount", { n: selectedDecks.size });
  }

  $("#btnSelectMode").addEventListener("click", () => {
    selectMode = !selectMode;
    selectedDecks.clear();
    renderHome();
  });

  $("#bulkPickAll").addEventListener("click", () => {
    const decks = Store.state.decks
      .filter(d => currentFolder === STARRED ? d.starred : (!currentFolder || d.folderId === currentFolder));
    if (selectedDecks.size === decks.length) selectedDecks.clear();
    else decks.forEach(d => selectedDecks.add(d.id));
    renderHome();
  });

  $("#bulkDelete").addEventListener("click", () => {
    const n = selectedDecks.size;
    if (!n) return;
    const ids = [...selectedDecks];
    const cardTotal = ids.reduce((sum, id) => sum + Store.cardsOf(id).length, 0);
    confirmDialog(
      t("confirm.deleteDecks", { n }),
      cardTotal ? t("confirm.deleteDecksText", { n: cardTotal }) : t("confirm.deleteDeckText0"),
      async () => {
        // 선택한 덱 중 탐색(Explore)에 공개된 것들은 함께 내린다 (실패해도 삭제는 진행)
        const sharedIds = ids.map(id => Store.getDeck(id)?.sharedId).filter(Boolean);
        await Promise.allSettled(sharedIds.map(sid => Social.unpublishDeck(sid)));
        Store.deleteDecks(ids);
        selectMode = false;
        selectedDecks.clear();
        renderHome();
        toast(t("toast.decksDeleted", { n }));
      }
    );
  });

  /* ══════════ 덱 상세 ══════════ */
  function renderDeck() {
    const deck = Store.getDeck(currentDeckId);
    if (!deck) { show("home"); return; }

    $("#deckTitle").textContent = deck.name;
    $("#deckDesc").textContent = deck.desc || "";

    const c = Store.deckCounts(deck.id);
    $("#deckStatRow").innerHTML = `
      <div class="mini-stat tone-pink"><b>${c.due}</b><span>${t("deck.due")}</span></div>
      <div class="mini-stat tone-green"><b>${c.neu}</b><span>${t("deck.new")}</span></div>
      <div class="mini-stat tone-ink"><b>${c.total}</b><span>${t("deck.total")}</span></div>`;

    renderShareButton();
    renderCardList();
  }

  let listFilter = "all"; // all | starred | suspended

  function renderCardList() {
    const q = $("#cardSearch").value.trim().toLowerCase();
    const cards = Store.cardsOf(currentDeckId)
      .filter(c => {
        if (listFilter === "starred" && !c.starred) return false;
        if (listFilter === "suspended" && !c.suspended) return false;
        if (!q) return true;
        const p = cardPreview(c);
        return p.front.toLowerCase().includes(q) || p.back.toLowerCase().includes(q);
      })
      .sort((a, b) => b.created - a.created);

    $("#cardCount").textContent = cards.length;
    // 화면에 보이는 카드만 선택 대상으로 유지 (검색·필터 변경 시 정리)
    const visibleIds = new Set(cards.map(c => c.id));
    selectedCards.forEach(id => { if (!visibleIds.has(id)) selectedCards.delete(id); });
    $("#btnCardSelect").textContent = cardSelectMode ? t("home.selectCancel") : t("home.select");

    const list = $("#cardList");
    if (!cards.length) {
      list.innerHTML = `<li class="list-empty">${q || listFilter !== "all" ? t("deck.searchEmpty") : t("deck.listEmpty")}</li>`;
      renderCardBulkBar();
      return;
    }

    list.innerHTML = cards.map(c => {
      const d = SRS.dueLabel(c);
      const p = cardPreview(c);
      const typeChip = c.type !== "basic"
        ? `<span class="type-chip ${c.type}">${t("type." + c.type)}</span>` : "";
      const picked = selectedCards.has(c.id);
      return `
        <li class="card-row ${c.suspended ? "is-suspended" : ""} ${cardSelectMode ? "select-mode" : ""} ${picked ? "picked" : ""}" data-id="${c.id}">
          ${cardSelectMode
            ? `<span class="card-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>`
            : `<button class="icon-btn star ${c.starred ? "on" : ""}" title="${t("cardRow.star")}">
            <svg width="15" height="15"><use href="#i-star"/></svg>
          </button>`}
          <div class="texts">
            <div class="front">${c.type === "basic" ? sanitizeRichHTML(p.front) : escapeHTML(p.front)}</div>
            <div class="back">${c.type === "basic" ? sanitizeRichHTML(p.back) : escapeHTML(p.back)}</div>
          </div>
          ${typeChip}
          ${cardSelectMode ? "" : `
          <span class="due-tag ${d.overdue ? "overdue" : ""} ${d.fresh ? "fresh" : ""}">${d.text}</span>
          <button class="icon-btn susp" title="${c.suspended ? t("cardRow.resume") : t("cardRow.suspend")}">
            <svg width="14" height="14"><use href="#${c.suspended ? "i-resume" : "i-pause"}"/></svg>
          </button>
          ${c.type !== "occlusion" ? `<button class="icon-btn edit" title="${t("cardRow.edit")}">✎</button>` : ""}
          <button class="icon-btn del" title="${t("cardRow.delete")}">✕</button>`}
        </li>`;
    }).join("");

    list.querySelectorAll(".card-row").forEach(row => {
      const id = row.dataset.id;
      const card = Store.state.cards.find(c => c.id === id);
      if (cardSelectMode) {
        row.addEventListener("click", () => {
          if (selectedCards.has(id)) selectedCards.delete(id); else selectedCards.add(id);
          renderCardList();
        });
        return;
      }
      row.querySelector(".star").addEventListener("click", () => {
        Store.updateCard(id, { starred: !card.starred });
        renderCardList();
      });
      row.querySelector(".susp").addEventListener("click", () => {
        Store.updateCard(id, { suspended: !card.suspended });
        renderDeck(); // 학습 대기 수치도 갱신
      });
      row.querySelector(".edit")?.addEventListener("click", () => openCardModal(id));
      row.querySelector(".del").addEventListener("click", () => {
        confirmDialog(t("confirm.deleteCard"), t("confirm.deleteCardText"), () => {
          Store.deleteCard(id);
          renderDeck();
          toast(t("toast.cardDeleted"));
        });
      });
    });

    renderCardBulkBar();
  }

  function renderCardBulkBar() {
    const bar = $("#cardBulkBar");
    if (!bar) return;
    bar.classList.toggle("show", cardSelectMode && selectedCards.size > 0);
    $("#cardBulkCount").textContent = t("home.selectedCount", { n: selectedCards.size });
  }

  $("#cardSearch").addEventListener("input", renderCardList);
  $$("#filterChips .fchip").forEach(b => b.addEventListener("click", () => {
    listFilter = b.dataset.filter;
    $$("#filterChips .fchip").forEach(x => x.classList.toggle("active", x === b));
    renderCardList();
  }));

  // 카드 다중 선택 · 삭제
  $("#btnCardSelect").addEventListener("click", () => {
    cardSelectMode = !cardSelectMode;
    selectedCards.clear();
    renderCardList();
  });
  $("#cardBulkPickAll").addEventListener("click", () => {
    const rows = [...$("#cardList").querySelectorAll(".card-row")].map(r => r.dataset.id);
    if (rows.every(id => selectedCards.has(id))) selectedCards.clear();
    else rows.forEach(id => selectedCards.add(id));
    renderCardList();
  });
  $("#cardBulkDelete").addEventListener("click", () => {
    const n = selectedCards.size;
    if (!n) return;
    const ids = [...selectedCards];
    confirmDialog(t("confirm.deleteCards", { n }), t("confirm.deleteCardText"), () => {
      Store.deleteCards(ids);
      cardSelectMode = false;
      selectedCards.clear();
      renderDeck();
      toast(t("toast.cardsDeleted", { n }));
    });
  });

  /* ══════════ 덱 모달 ══════════ */
  const deckModal = $("#deckModal");

  function fillFolderSelect(selectedId) {
    $("#deckFolderSel").innerHTML =
      `<option value="">${t("folder.none")}</option>` +
      Store.state.folders.map(f =>
        `<option value="${f.id}" ${f.id === selectedId ? "selected" : ""}>${escapeHTML(f.name)}</option>`).join("");
  }

  $("#btnNewDeck").addEventListener("click", () => {
    editingDeck = false;
    $("#deckModalTitle").textContent = t("deckModal.new");
    $("#deckModalSubmit").textContent = t("deckModal.create");
    $("#deckNameInput").value = "";
    $("#deckDescInput").value = "";
    $("#deckNewLimit").value = 20;
    fillFolderSelect(currentFolder); // 폴더를 보고 있으면 그 폴더가 기본값
    deckModal.showModal();
  });

  $("#btnEditDeck").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    editingDeck = true;
    $("#deckModalTitle").textContent = t("deckModal.edit");
    $("#deckModalSubmit").textContent = t("cardModal.submitSave");
    $("#deckNameInput").value = deck.name;
    $("#deckDescInput").value = deck.desc || "";
    $("#deckNewLimit").value = deck.newPerDay ?? 20;
    fillFolderSelect(deck.folderId || "");
    deckModal.showModal();
  });

  $("#deckForm").addEventListener("submit", () => {
    const name = $("#deckNameInput").value.trim();
    const desc = $("#deckDescInput").value.trim();
    const limit = Math.max(0, Math.min(500, Number($("#deckNewLimit").value) || 0));
    const folderId = $("#deckFolderSel").value || null;
    if (!name) return;
    if (editingDeck) {
      Store.updateDeck(currentDeckId, name, desc, limit);
      Store.patchDeck(currentDeckId, { folderId });
      renderDeck();
      toast(t("toast.deckUpdated"));
    } else {
      const deck = Store.addDeck(name, desc, limit);
      Store.patchDeck(deck.id, { folderId });
      currentDeckId = deck.id;
      show("deck");
      toast(t("toast.deckCreated"));
    }
  });

  /* ── 덱 공개/비공개 ── */
  function renderShareButton() {
    const deck = Store.getDeck(currentDeckId);
    const btn = $("#btnShare");
    btn.textContent = !deck?.sharedId ? t("share.publish")
      : deck.visibility === "friends" ? t("share.publishedFriends") : t("share.published");
    btn.classList.toggle("is-shared", !!deck?.sharedId);
  }

  const shareModal = $("#shareModal");
  let shareVisibility = "public";

  $$("#shareVisSeg .seg-btn").forEach(b => b.addEventListener("click", () => {
    shareVisibility = b.dataset.vis;
    $$("#shareVisSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    $("#shareVisHint").textContent = shareVisibility === "friends" ? t("share.visHintFriends") : t("share.visHintPublic");
  }));

  $("#btnShare").addEventListener("click", async () => {
    const deck = Store.getDeck(currentDeckId);
    if (!Social.profile) { toast(t("share.needLogin")); return; }

    if (deck.sharedId) {
      confirmDialog(t("share.offTitle"), t("share.offText"), async () => {
        try {
          await Social.unpublishDeck(deck.sharedId);
          Store.patchDeck(deck.id, { sharedId: null, visibility: null });
          renderShareButton();
          toast(t("share.off"));
        } catch { toast(t("fr.offline")); }
      }, t("share.yes"));
      return;
    }

    shareVisibility = "public";
    $$("#shareVisSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.vis === "public"));
    $("#shareVisHint").textContent = t("share.visHintPublic");
    $("#shareSub").textContent = deck.name;
    shareModal.showModal();
  });

  $("#shareConfirmBtn").addEventListener("click", async () => {
    const deck = Store.getDeck(currentDeckId);
    const btn = $("#shareConfirmBtn");
    btn.disabled = true;
    toast(t("share.uploading"));
    try {
      const { sharedId, count } = await Social.publishDeck(deck, Store.cardsOf(deck.id), shareVisibility);
      Store.patchDeck(deck.id, { sharedId, visibility: shareVisibility });
      renderShareButton();
      shareModal.close();
      toast(t("share.done", { n: count }));
    } catch (err) {
      toast(err?.message === "no_text_cards" ? t("share.noText") : t("fr.offline"));
    } finally {
      btn.disabled = false;
    }
  });

  $("#btnCsv").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    const blob = new Blob(["﻿" + Store.exportDeckCSV(currentDeckId)], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${deck.name.replace(/[\\/:*?"<>|]/g, "_")}.csv`);
    toast(t("toast.exported"));
  });

  $("#btnDeleteDeck").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    const n = Store.cardsOf(currentDeckId).length;
    confirmDialog(
      t("confirm.deleteDeck", { name: deck.name }),
      n ? t("confirm.deleteDeckText", { n }) : t("confirm.deleteDeckText0"),
      async () => {
        // 탐색(Explore)에 공개된 덱이었다면 함께 내려간다 (실패해도 삭제 자체는 진행)
        if (deck.sharedId) { try { await Social.unpublishDeck(deck.sharedId); } catch {} }
        Store.deleteDeck(currentDeckId);
        show("home");
        toast(t("toast.deckDeleted"));
      }
    );
  });

  /* ══════════ 카드 모달 (기본/빈칸) ══════════ */
  const cardModal = $("#cardModal");

  function setCardType(type) {
    cardType = type;
    $$("#typeTabs .type-tab").forEach(b => b.classList.toggle("active", b.dataset.type === type));
    $("#basicFields").classList.toggle("hidden", type !== "basic");
    $("#clozeFields").classList.toggle("hidden", type !== "cloze");
    $("#richToolbar").classList.toggle("hidden", type === "occlusion");
    // 빈칸 삽입 버튼은 cloze 모드에서만 노출
    $$(".rt-cloze-only").forEach(el => el.classList.toggle("hidden", type !== "cloze"));
  }

  const scaleFields = ["cardScale", "fontScale", "imageScale"];
  function setScaleControls(card) {
    scaleFields.forEach(id => {
      const el = $("#" + id);
      if (!el) return; // 슬라이더가 없는 화면에서도 앱이 죽지 않도록
      el.value = card?.[id] || 100;
      const out = $("#" + id + "Out");
      if (out) out.textContent = el.value + "%";
    });
  }
  function scaleValues() { return Object.fromEntries(scaleFields.map(id => [id, Number($("#" + id)?.value) || 100])); }
  scaleFields.forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("input", e => {
      const out = $("#" + id + "Out");
      if (out) out.textContent = e.target.value + "%";
    });
  });

  $$("#typeTabs .type-tab").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.type === "occlusion") {
      editingOccCardId = null;
      cardModal.close();
      Occlusion.resetEditor();
      $("#occModal").showModal();
      return;
    }
    setCardType(b.dataset.type);
  }));

  function openCardModal(cardId = null) {
    editingCardId = cardId;
    const card = cardId ? Store.state.cards.find(c => c.id === cardId) : null;
    const isOcc = card?.type === "occlusion";
    $("#cardModalTitle").textContent = card ? t("cardModal.edit") : t("cardModal.add");
    $("#cardModalSubmit").textContent = card ? t("cardModal.submitSave") : t("cardModal.submitAdd");
    $("#typeTabs").classList.toggle("hidden", !!card);
    $("#reversedRow").classList.toggle("hidden", !!card);
    $("#cardReversed").checked = false;
    $("#cardNotesInput").value = card?.notes || "";
    noteImageData = card?.noteImageId ? (Store.getMedia(card.noteImageId) || null) : null;
    renderNoteImagePreview();
    $("#occTextFields").classList.toggle("hidden", !isOcc);
    $("#richToolbar").classList.toggle("hidden", isOcc);
    setScaleControls(card);

    if (isOcc) {
      // 이미지 가리기: 마스크는 편집기에서, 여기선 헤더·메모만 수정
      $("#basicFields").classList.add("hidden");
      $("#clozeFields").classList.add("hidden");
      $("#occHeaderInput").value = card.front || "";
    } else if (card?.type === "cloze") {
      setCardType("cloze");
      setRich($("#clozeInput"), card.front);
    } else {
      setCardType(card ? "basic" : cardType === "occlusion" ? "basic" : cardType);
      setRich($("#cardFrontInput"), card ? card.front : "");
      setRich($("#cardBackInput"), card ? card.back : "");
      if (!card) setRich($("#clozeInput"), "");
    }
    cardModal.showModal();
  }

  // 카드 저장 후: 덱 목록 갱신 + 학습 중이면 현재 카드 다시 그림
  function afterCardSaved() {
    renderDeck();
    if (!$("#view-study").classList.contains("hidden") && session && session.current) {
      const card = currentCard();
      if (card && card.id === editingCardId) {
        renderFace($("#acQuestion"), card, session.revealed);
        if (session.revealed && card.type === "basic") renderFace($("#acAnswer"), card, true);
        showNotes(card, session.revealed);
      }
    }
  }

  $("#btnAddCard").addEventListener("click", () => openCardModal());

  /* ── 메모(notes) 이미지 첨부 ── */
  let noteImageData = null; // 현재 모달의 메모 이미지 dataURL (없으면 null)
  const NOTE_IMG_MAX = 1400, NOTE_IMG_QUALITY = 0.85;
  function fileToNoteDataURL(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, NOTE_IMG_MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        // 투명 png 는 jpeg 로 바꾸면 배경이 검게 나올 수 있어 png 는 png 로 유지
        const isPng = /^image\/png/i.test(file.type);
        resolve(canvas.toDataURL(isPng ? "image/png" : "image/jpeg", NOTE_IMG_QUALITY));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }
  function renderNoteImagePreview() {
    const wrap = $("#noteImgPreview");
    if (noteImageData) {
      $("#noteImgThumb").src = noteImageData;
      wrap.classList.remove("hidden");
      $("#noteImgBtn").textContent = t("cardModal.changeImage");
    } else {
      $("#noteImgThumb").removeAttribute("src");
      wrap.classList.add("hidden");
      $("#noteImgBtn").textContent = t("cardModal.addImage");
    }
  }
  // 저장 시 메모 이미지를 media 로 커밋 — 안 바뀌었으면 기존 id 유지
  function commitNoteImage(existingId) {
    if (!noteImageData) return null;
    if (existingId && Store.getMedia(existingId) === noteImageData) return existingId;
    return Store.addMedia(noteImageData);
  }
  $("#noteImgBtn").addEventListener("click", () => $("#noteImgFile").click());
  $("#noteImgFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { noteImageData = await fileToNoteDataURL(f); renderNoteImagePreview(); }
    catch { toast(t("toast.imageFail")); }
  });
  $("#noteImgRemove").addEventListener("click", () => { noteImageData = null; renderNoteImagePreview(); });
  // 메모 칸에 이미지 붙여넣기(Ctrl+V) — 클립보드에 이미지가 있으면 메모 이미지로 첨부
  $("#cardNotesInput").addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) { try { noteImageData = await fileToNoteDataURL(file); renderNoteImagePreview(); } catch { toast(t("toast.imageFail")); } }
        return;
      }
    }
  });

  $("#cardForm").addEventListener("submit", (e) => {
    const notes = $("#cardNotesInput").value.trim();
    const editCard = editingCardId ? Store.state.cards.find(c => c.id === editingCardId) : null;
    const noteImageId = commitNoteImage(editCard?.noteImageId);

    // 이미지 가리기 편집: 헤더 + 메모만
    if (editCard?.type === "occlusion") {
      Store.updateCard(editingCardId, { front: $("#occHeaderInput").value.trim(), notes, noteImageId, ...scaleValues() });
      toast(t("toast.cardUpdated"));
      afterCardSaved();
      return;
    }

    if (cardType === "cloze") {
      const text = getRich($("#clozeInput"));
      const indices = clozeIndices(text);
      if (!text || !indices.length) { e.preventDefault(); return; }
      if (editingCardId) {
        Store.updateCard(editingCardId, { front: text, notes, noteImageId, ...scaleValues() });
        toast(t("toast.cardUpdated"));
      } else {
        const rows = indices.map(idx => ({ type: "cloze", front: text, back: "", clozeIndex: idx, notes, noteImageId, ...scaleValues() }));
        const ok = Store.bulkAddCards(currentDeckId, rows);
        toast(ok ? t("toast.cardsAdded", { n: rows.length }) : t("toast.storageFull"));
      }
      afterCardSaved();
      return;
    }

    const front = getRich($("#cardFrontInput"));
    const back = getRich($("#cardBackInput"));
    if (richIsEmpty($("#cardFrontInput")) || richIsEmpty($("#cardBackInput"))) { e.preventDefault(); return; }
    if (editingCardId) {
      Store.updateCard(editingCardId, { front, back, notes, noteImageId, ...scaleValues() });
      toast(t("toast.cardUpdated"));
    } else {
      const rows = [{ type: "basic", front, back, notes, noteImageId, ...scaleValues() }];
      if ($("#cardReversed").checked) rows.push({ type: "basic", front: back, back: front, notes, noteImageId, ...scaleValues() });
      const ok = Store.bulkAddCards(currentDeckId, rows);
      toast(ok ? (rows.length > 1 ? t("toast.cardsAdded", { n: rows.length }) : t("toast.cardAdded")) : t("toast.storageFull"));
    }
    afterCardSaved();
  });

  /* ══════════ 서식 툴바(굵게/밑줄/글자색/하이라이트) ══════════ */
  let activeRichField = $("#cardFrontInput");
  [$("#cardFrontInput"), $("#cardBackInput"), $("#clozeInput")].forEach(el => {
            el.addEventListener("focusin", () => {
      activeRichField = el;
      try { document.execCommand("defaultParagraphSeparator", false, "br"); } catch {}
    });
    el.addEventListener("focus", () => { activeRichField = el; });
    // 붙여넣기는 일반 텍스트로만 허용 — 외부 문서의 스타일이 그대로 딸려오는 걸 방지
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });
  });
  document.addEventListener("selectionchange", () => {
    if (!document.activeElement || !document.activeElement.closest?.("#basicFields, #clozeFields")) return;
    try {
      $("#richToolbar .rt-btn[data-cmd=bold]")?.classList.toggle("active", document.queryCommandState("bold"));
      $("#richToolbar .rt-btn[data-cmd=underline]")?.classList.toggle("active", document.queryCommandState("underline"));
    } catch { /* 일부 브라우저는 지원 안 함 — 무시 */ }
  });
  // 선택 영역을 지정한 인라인 요소로 직접 감싼다.
  // execCommand의 색/형광펜은 브라우저마다 줄 전체에 적용되거나 글자 크기를
  // 건드리는 문제가 있어, 색·형광펜은 이 방식으로 "선택한 부분만" 정확히 칠한다.
  const INLINE_TAG = { bold: "strong", underline: "u", italic: "em" };
  function wrapSelection(field, tag, style) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!field.contains(range.commonAncestorContainer)) return false;
    const wrap = document.createElement(tag);
    if (style) Object.assign(wrap.style, style);
    try {
      wrap.appendChild(range.extractContents());
      range.insertNode(wrap);
      wrap.normalize();
      const nr = document.createRange();
      nr.selectNodeContents(wrap);
      sel.removeAllRanges();
      sel.addRange(nr);
      return true;
    } catch { return false; }
  }

  $$("#richToolbar .rt-btn, #richToolbar .rt-swatch").forEach(btn => {
    // mousedown에서 기본 동작을 막아야 클릭해도 필드의 선택 영역(selection)이 풀리지 않는다
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd;
      if (!cmd) return; // 빈칸 삽입 버튼 등 data-cmd 없는 버튼은 별도 핸들러에서 처리
      const field = activeRichField;
      field.focus();
      // 글자색·형광펜: 선택 영역만 정확히 span으로 감싼다 (줄 전체 적용·글자 축소 방지)
      if (cmd === "foreColor") { wrapSelection(field, "span", { color: btn.dataset.val }); return; }
      if (cmd === "hiliteColor" || cmd === "backColor") { wrapSelection(field, "span", { backgroundColor: btn.dataset.val }); return; }
      // 굵게·밑줄·서식지우기: execCommand 사용 (굵게·밑줄은 <b>/<u> 유지)
      const before = field.innerHTML;
      try { document.execCommand("styleWithCSS", false, false); } catch { /* 무시 */ }
      try { document.execCommand(cmd, false, btn.dataset.val || undefined); }
      catch { /* 무시 */ }
      // 굵게·밑줄이 전혀 반영되지 않는 환경 대비 — 선택 영역을 직접 감싼다
      if (INLINE_TAG[cmd] && field.innerHTML === before) wrapSelection(field, INLINE_TAG[cmd]);
    });
  });

  // 빈칸 삽입 버튼: {{cN::…}} 을 커서 위치에 넣는다.
  // 선택 영역이 있으면 그 텍스트를 감싸고, 없으면 빈 빈칸을 넣고 커서를 안쪽에 둔다.
  // N은 현재 필드의 가장 큰 번호 + 1 로 자동 증가.
  $("#richInsertCloze").addEventListener("mousedown", (e) => e.preventDefault());
  $("#richInsertCloze").addEventListener("click", () => {
    const field = $("#clozeInput");
    field.focus();
    const existing = clozeIndices(field.textContent || "");
    const n = existing.length ? Math.max(...existing) + 1 : 1;
    const sel = window.getSelection();
    const selected = sel && sel.rangeCount ? sel.toString() : "";
    const close = "}}";
    document.execCommand("insertText", false, `{{c${n}::${selected}${close}`);
    // 빈 빈칸이면 커서를 }} 바로 앞으로 옮겨 바로 정답을 입력할 수 있게 한다
    if (!selected && sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (range.startOffset >= close.length) {
        try {
          range.setStart(range.startContainer, range.startOffset - close.length);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch { /* 무시 */ }
      }
    }
  });
  $("#richFont").addEventListener("change", e => {
    if (!e.target.value) return;
    activeRichField.focus(); document.execCommand("styleWithCSS", false, true); document.execCommand("fontName", false, e.target.value); e.target.value = "";
  });
  $("#richSize").addEventListener("change", e => {
    const v = e.target.value; e.target.value = "";
    if (!v) return;
    // 상대 크기(em)로 지정 — 편집기(작은 기준)든 카드(큰 기준)든 항상 주변 글자 대비 같은 비율로 커진다.
    // 절대 키워드(medium=16px 등)는 카드 기본 글자(≈20px)보다 작아서 "키웠는데 작아지는" 문제가 있었다.
    activeRichField.focus();
    wrapSelection(activeRichField, "span", { fontSize: v });
  });

  /* ══════════ 이미지 가리기 편집기 ══════════ */
  Occlusion.bindEditor();
  $("#editOccMasks").addEventListener("click", () => {
    const card = Store.state.cards.find(c => c.id === editingCardId);
    if (!card) return;
    editingOccCardId = card.id;
    cardModal.close();
    Occlusion.loadEditor(card);
    $("#occModal").showModal();
  });
  $("#occPick").addEventListener("click", () => $("#occFile").click());
  $("#occCreate").addEventListener("click", () => {
    if (editingOccCardId) {
      const card = Store.state.cards.find(c => c.id === editingOccCardId);
      const fields = card && Occlusion.buildEditFields(card);
      if (!fields) return;
      Store.updateCard(editingOccCardId, { ...fields, ...scaleValues() });
      editingOccCardId = null;
      Store.gcMedia(); $("#occModal").close(); renderDeck(); toast(t("toast.cardUpdated"));
      return;
    }
    const rows = Occlusion.buildCards();
    if (!rows) return;
    const ok = Store.bulkAddCards(currentDeckId, rows);
    Store.gcMedia();
    $("#occModal").close();
    renderDeck();
    toast(ok ? t("toast.cardsAdded", { n: rows.length }) : t("toast.storageFull"));
  });

  /* ══════════ 가져오기 (apkg / CSV / 텍스트) ══════════
     흐름: 파일 선택 → 파일명 표시 → '가져오기' 버튼 클릭 시 실제 처리 */
  let pendingFile = null; // { kind: 'apkg'|'csv', file }

  function resetImportModal() {
    pendingFile = null;
    $("#bulkText").value = "";
    $("#importError").textContent = "";
    $("#importPicked").classList.add("hidden");
    $("#importPicked").textContent = "";
    setImportBusy(false);
  }

  function setImportBusy(busy) {
    $("#bulkImportRun").disabled = busy;
    $("#bulkImportRun").textContent = busy ? t("imp.importing") : t("imp.run");
  }

  function pickFile(kind, file) {
    if (!file) return;
    pendingFile = { kind, file };
    $("#bulkText").value = ""; // 파일과 텍스트는 상호배타
    $("#importError").textContent = "";
    $("#importPicked").textContent = t("imp.picked", { name: file.name });
    $("#importPicked").classList.remove("hidden");
  }

  $("#btnImportCards").addEventListener("click", () => {
    resetImportModal();
    $("#importModal").showModal();
  });

  $("#impApkg").addEventListener("click", () => $("#apkgFile").click());
  $("#apkgFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    pickFile("apkg", file);
  });

  // 텍스트를 입력하면 선택된 파일은 해제 (상호배타)
  $("#bulkText").addEventListener("input", () => {
    if ($("#bulkText").value.trim() && pendingFile) {
      pendingFile = null;
      $("#importPicked").classList.add("hidden");
    }
  });

  async function runApkgImport(file) {
    setImportBusy(true);
    try {
      const { added, decks } = await Apkg.importFile(file, currentDeckId,
        msg => { $("#importPicked").textContent = msg; });
      $("#importModal").close();
      if (decks > 1) {
        show("home"); // 폴더로 나뉘어 들어왔으니 홈에서 보여준다
        toast(added ? t("imp.doneDecks", { n: added, d: decks }) : t("imp.empty"));
      } else {
        renderDeck();
        toast(added ? t("imp.done", { n: added }) : t("imp.empty"));
      }
    } catch (err) {
      console.error("[Petale apkg] import failed:", err);
      let msg;
      if (err.message === "storage_full") msg = t("toast.storageFull");
      else if (err.message === "apkg_nodb") msg = t("imp.noDb");
      else if (err.message === "sqljs_unloaded" || err.message === "engine_timeout") msg = t("imp.engineFail");
      else msg = t("imp.fail") + (err.message ? ` (${err.message})` : "");
      $("#importError").textContent = msg;
      $("#importPicked").classList.add("hidden");
      setImportBusy(false);
    }
  }

  /* ── CSV 파일 가져오기 ──
     따옴표 필드(쉼표·줄바꿈 포함)와 "" 이스케이프를 처리한다.
     구분자는 첫 데이터 행 기준으로 쉼표/탭/세미콜론 자동 감지 */
  function parseCSV(text, delim) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function detectDelim(text) {
    const firstLine = text.split(/\r?\n/).find(l => l.trim()) || "";
    if (firstLine.includes("\t")) return "\t";
    if (firstLine.includes(";") && !firstLine.includes(",")) return ";";
    return ",";
  }

  $("#impCsv").addEventListener("click", () => $("#csvFile").click());
  $("#csvFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    pickFile("csv", file);
  });

  async function runCsvImport(file) {
    $("#importError").textContent = "";
    try {
      let text = await file.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM 제거
      const parsed = parseCSV(text, detectDelim(text));
      const rows = [];
      for (const cols of parsed) {
        const front = (cols[0] || "").trim();
        const back = cols.slice(1).map(c => c.trim()).filter(Boolean).join(" — ");
        if (front && back) rows.push({ type: "basic", front, back });
      }
      // 헤더 행(front,back / 앞면,뒷면 등) 제거
      if (rows.length && /^(front|question|term|word|앞면|질문|단어)$/i.test(rows[0].front)) rows.shift();
      if (!rows.length) { $("#importError").textContent = t("imp.empty"); return; }
      const ok = Store.bulkAddCards(currentDeckId, rows);
      $("#importModal").close();
      renderDeck();
      toast(ok ? t("imp.done", { n: rows.length }) : t("toast.storageFull"));
    } catch {
      $("#importError").textContent = t("imp.fail");
    }
  }

  function runTextImport() {
    // 카드는 "//" 로 구분 — 한 카드 안에서는 자유롭게 줄바꿈할 수 있다
    const blocks = $("#bulkText").value.split("//").map(b => b.trim()).filter(Boolean);
    const rows = [];
    for (const block of blocks) {
      // 빈칸(cloze) 문법이 있으면 cloze 카드로 처리 — c1, c2…마다 카드가 하나씩 생성된다
      if (/\{\{c\d+::/.test(block)) {
        const front = block.replace(/\n/g, "<br>"); // 카드 안 줄바꿈 유지
        const indices = clozeIndices(block);
        for (const idx of indices) rows.push({ type: "cloze", front, back: "", clozeIndex: idx });
        continue;
      }
      let front, back;
      if (block.includes("\t")) {
        [front, ...back] = block.split("\t");
        back = back.join(" ").trim();
      } else {
        const i = block.indexOf(",");
        if (i < 0) continue;
        front = block.slice(0, i);
        back = block.slice(i + 1).trim();
      }
      front = front.trim().replace(/\n/g, "<br>");
      back = (back || "").replace(/\n/g, "<br>");
      if (front && back) rows.push({ type: "basic", front, back });
    }
    if (!rows.length) { $("#importError").textContent = t("imp.empty"); return; }
    const ok = Store.bulkAddCards(currentDeckId, rows);
    $("#importModal").close();
    renderDeck();
    toast(ok ? t("imp.done", { n: rows.length }) : t("toast.storageFull"));
  }

  // '가져오기' 버튼: 선택된 파일(apkg/csv) 또는 입력한 텍스트를 처리
  $("#bulkImportRun").addEventListener("click", () => {
    $("#importError").textContent = "";
    if (pendingFile?.kind === "apkg") { runApkgImport(pendingFile.file); return; }
    if (pendingFile?.kind === "csv") { runCsvImport(pendingFile.file); return; }
    if ($("#bulkText").value.trim()) { runTextImport(); return; }
    $("#importError").textContent = t("imp.pickFirst");
  });

  /* ══════════ 확인 모달 ══════════ */
  const confirmModal = $("#confirmModal");
  let confirmCallback = null;

  function confirmDialog(title, text, onYes, yesLabel) {
    $("#confirmTitle").textContent = title;
    $("#confirmText").textContent = text;
    $("#confirmYes").textContent = yesLabel || t("confirm.yes");
    confirmCallback = onYes;
    confirmModal.showModal();
  }
  $("#confirmYes").addEventListener("click", () => {
    confirmModal.close();
    confirmCallback?.();
    confirmCallback = null;
  });

  $$(".modal").forEach(m => {
    m.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => m.close()));
    m.addEventListener("click", (e) => { if (e.target === m) m.close(); });
  });

  /* ══════════ 학습 세션 ══════════ */
  const answerCard = $("#answerCard");
  const ratingRow = $("#ratingRow");

  // deckId가 null이면 모든 덱을 통합 학습. 덱별 하루 새 카드 한도를 지킨다.
  function buildQueue(deckId) {
    const now = Date.now();
    const decks = deckId ? [Store.getDeck(deckId)].filter(Boolean) : Store.state.decks;
    const due = [];
    const neu = [];
    for (const deck of decks) {
      const cards = Store.cardsOf(deck.id).filter(c => !c.suspended);
      due.push(...cards.filter(c => !SRS.isNew(c) && SRS.isDue(c, now)));
      const allowed = Math.max(0, (deck.newPerDay ?? 20) - Store.newIntroducedToday(deck.id));
      neu.push(...cards.filter(SRS.isNew).slice(0, allowed));
    }
    const shuffle = arr => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    return [...shuffle(due), ...shuffle(neu)].map(c => c.id);
  }

  function startSession(deckId) {
    const queue = buildQueue(deckId);
    if (!queue.length) { toast(t("study.nothingDue")); return; }
    // main: 복습·새 카드(복습 먼저, 새 카드 나중) / learning: 세션 중 '다시·어려움' 누른 학습 카드 {id, dueAt}
    session = { main: queue, learning: [], current: null, done: 0, total: queue.length, revealed: false, global: !deckId, history: [] };
    $("#studyDone").classList.add("hidden");
    $(".study-stage").classList.remove("hidden");
    $("#btnUndo").classList.add("hidden");
    show("study");
    nextCard();
  }

  $("#btnStudy").addEventListener("click", () => startSession(currentDeckId));
  $("#btnStudyAll").addEventListener("click", () => startSession(null));

  /* ── 연습 모드 (퀴즈/쓰기/매치) ── */
  function startPractice(mode, view) {
    Practice.setDeck(currentDeckId);
    const started = mode(currentDeckId, () => show("deck"));
    if (!started) { toast(t("practice.needCards")); return; }
    show(view);
  }
  $("#btnQuiz").addEventListener("click", () => startPractice(Practice.startQuiz, "quiz"));
  $("#btnWrite").addEventListener("click", () => startPractice(Practice.startWrite, "write"));
  $("#btnMatch").addEventListener("click", () => startPractice(Practice.startMatch, "match"));

  /* ── 플래시카드 모드 (뒤집기 카드로 훑어보기) ── */
  let flash = null; // { items: [card], i, flipped }

  function renderFlash(instant = false) {
    const card = flash.items[flash.i];
    flash.flipped = false;
    $("#flashCard").classList.remove("flipped");
    $("#flashPos").textContent = `${flash.i + 1} / ${flash.items.length}`;
    // 뒤집힘 복귀 애니메이션 중 내용이 비치지 않도록 지연 교체
    setTimeout(() => {
      renderFace($("#flashFront"), card, false);
      renderFace($("#flashBack"), card, true);
    }, instant ? 0 : 180);
  }

  $("#btnFlash").addEventListener("click", () => {
    const items = Store.cardsOf(currentDeckId).filter(c => !c.suspended);
    if (!items.length) { toast(t("practice.needCards")); return; }
    flash = { items, i: 0, flipped: false };
    show("flash");
    renderFlash(true);
  });

  function flashFlip() {
    if (!flash) return;
    flash.flipped = !flash.flipped;
    $("#flashCard").classList.toggle("flipped", flash.flipped);
  }
  function flashMove(dir) {
    if (!flash) return;
    flash.i = (flash.i + dir + flash.items.length) % flash.items.length;
    renderFlash();
  }
  $("#flashCard").addEventListener("click", flashFlip);
  $("#flashFlip").addEventListener("click", flashFlip);
  $("#flashPrev").addEventListener("click", () => flashMove(-1));
  $("#flashNext").addEventListener("click", () => flashMove(1));
  $("#btnQuitFlash").addEventListener("click", () => { flash = null; show("deck"); });

  document.addEventListener("keydown", (e) => {
    if ($("#view-flash").classList.contains("hidden")) return;
    if (e.target.matches("input, textarea")) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); flashFlip(); }
    if (e.code === "ArrowLeft") flashMove(-1);
    if (e.code === "ArrowRight") flashMove(1);
    if (e.code === "Escape") { flash = null; show("deck"); }
  });

  function currentCard() {
    return Store.state.cards.find(c => c.id === session.current);
  }

  // 다음에 보여줄 카드 선택 (Anki식 시간 인식 큐)
  //  1) 학습(다시/재학습) 카드가 다시 볼 시간이 됐으면 우선 — 가장 이른 것부터
  //  2) 아직 시간이 안 됐으면 그 공백 동안 복습·새 카드로 채운다
  //  3) 남은 게 학습 카드뿐이면 가장 이른 것부터 (조금 일찍이라도)
  function pickNext(now) {
    session.learning.sort((a, b) => a.dueAt - b.dueAt);
    if (session.learning.length && session.learning[0].dueAt <= now) return session.learning.shift().id;
    if (session.main.length) return session.main.shift();
    if (session.learning.length) return session.learning.shift().id;
    return null;
  }

  function showCard(id) {
    session.current = id;
    const card = currentCard();
    session.revealed = false;
    ratingRow.classList.add("hidden");
    $("#revealRow").classList.remove("hidden");
    $("#acAnswerWrap").classList.add("hidden");
    $("#keyHint").textContent = t("study.revealHint");
    $("#speakBtn").hidden = !(Store.settings.tts && "speechSynthesis" in window && card.type !== "occlusion");
    answerCard.classList.toggle("media-card", isMediaCard(card));
    renderFace($("#acQuestion"), card, false);
    showNotes(card, false);
  }

  // 답 공개 시 카드의 추가 설명(메모)을 보여준다
  function showNotes(card, revealed) {
    const el = $("#acNotes");
    const noteImg = card.noteImageId ? Store.getMedia(card.noteImageId) : null;
    const hasText = card.notes && card.notes.trim();
    if (revealed && (hasText || noteImg)) {
      let html = hasText ? `<div class="note-text">${escapeHTML(card.notes).replace(/\n/g, "<br>")}</div>` : "";
      if (noteImg) html += `<img class="note-img" src="${noteImg}" alt="">`;
      el.innerHTML = html;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
      el.innerHTML = "";
    }
  }

  function renderFace(host, card, revealed) {
    const shell = host.closest(".answer-card, .flashcard");
    if (shell) {
      shell.style.setProperty("--card-scale", (card.cardScale || 100) / 100);
      shell.style.setProperty("--font-scale", (card.fontScale || 100) / 100);
      shell.style.setProperty("--image-scale", (card.imageScale || 100) / 100);
    }
    if (card.type === "occlusion") {
      Occlusion.renderInto(host, card, revealed);
      return;
    }
    if (card.type === "cloze") {
      host.innerHTML = renderCloze(card.front, card.clozeIndex, revealed);
      return;
    }
    const text = revealed ? card.back : card.front;
    const imgId = revealed ? card.backImageId : card.frontImageId;
    // 서식(굵게/밑줄/색상/하이라이트) 표시 — 어떤 출처(로컬/공유 다운로드)든 항상 새니타이즈해서 렌더링
    host.innerHTML = sanitizeRichHTML(text);
    if (imgId && Store.getMedia(imgId)) {
      const img = document.createElement("img");
      img.className = "face-img";
      img.src = Store.getMedia(imgId);
      img.alt = "";
      host.appendChild(img);
    }
  }

  function nextCard() {
    const id = pickNext(Date.now());
    if (!id) { session.current = null; updateProgress(); finishSession(); return; }
    showCard(id); // 이미지/가리기 카드는 media-card 로 넓게 표시(showCard 내부 처리)
    updateProgress();
  }

  function isMediaCard(card) {
    return card.type === "occlusion" || !!card.frontImageId || !!card.backImageId;
  }

  function updateProgress() {
    const pct = session.total ? (session.done / session.total) * 100 : 0;
    $("#studyBar").style.width = `${pct}%`;
    $("#studyCount").textContent = `${session.done} / ${session.total}`;

    // 남은 카드 = main(복습·새) + learning(학습 중) + 현재 카드
    const mainCards = session.main.map(id => Store.state.cards.find(c => c.id === id)).filter(Boolean);
    const neu = mainCards.filter(SRS.isNew).length;
    const due = (mainCards.length - neu) + session.learning.length + (session.current ? 1 : 0);
    $("#sessionChips").innerHTML = `
      ${due ? `<span class="pill due">${t("pill.due", { n: due })}</span>` : ""}
      ${neu ? `<span class="pill new">${t("pill.new", { n: neu })}</span>` : ""}`;
  }

  // Anki 방식: 전환 없이 같은 화면에서 답을 공개한다
  function reveal() {
    if (!session || !session.current || session.revealed) return;
    session.revealed = true;

    const card = currentCard();
    if (card.type === "basic") {
      renderFace($("#acAnswer"), card, true);
      $("#acAnswerWrap").classList.remove("hidden");
    } else {
      // cloze/occlusion은 질문 영역을 제자리에서 공개 상태로 다시 그린다
      renderFace($("#acQuestion"), card, true);
    }
    showNotes(card, true);
    $("#revealRow").classList.add("hidden");
    $("#ivAgain").textContent = SRS.previewInterval(card, 0);
    $("#ivHard").textContent = SRS.previewInterval(card, 1);
    $("#ivGood").textContent = SRS.previewInterval(card, 2);
    $("#ivEasy").textContent = SRS.previewInterval(card, 3);
    ratingRow.classList.remove("hidden");
    $("#keyHint").textContent = t("study.keysHint");
  }

  function rate(rating) {
    if (!session || !session.revealed || !session.current) return;
    const id = session.current;
    const snapshot = Store.applyReview(id, rating);
    Social.pushStatsQuiet();
    session.current = null;

    // 리뷰 후에도 interval===0 이면 아직 학습 단계(다시·새 카드 어려움·재학습) → 그 due 시각에 다시 출제
    const fresh = Store.state.cards.find(c => c.id === id);
    if (fresh && fresh.interval === 0) {
      session.learning.push({ id, dueAt: fresh.due });
    } else {
      session.done++; // 졸업(하루 이상 간격) → 이번 세션 완료
    }
    if (snapshot) {
      session.history.push(snapshot);
      if (session.history.length > 50) session.history.shift();
    }
    $("#btnUndo").classList.toggle("hidden", !session.history.length);
    nextCard();
  }

  function undo() {
    if (!session || !session.history.length) return;
    const entry = session.history.pop();
    Store.undoReview(entry);
    Social.pushStatsQuiet();

    // 방금 평가한 카드가 학습 큐에 들어가 있었으면 빼고, 아니면 완료 카운트를 되돌린다
    const li = session.learning.findIndex(l => l.id === entry.cardId);
    if (li >= 0) session.learning.splice(li, 1);
    else if (session.done > 0) session.done--;
    // 지금 보여주던 카드는 잃지 않도록 main 앞으로 되돌린다
    if (session.current) session.main.unshift(session.current);

    $("#studyDone").classList.add("hidden");
    $(".study-stage").classList.remove("hidden");
    $("#btnUndo").classList.toggle("hidden", !session.history.length);
    toast(t("toast.undone"));
    showCard(entry.cardId); // 되돌린 카드를 다시 보여준다
    updateProgress();
  }
  $("#btnUndo").addEventListener("click", undo);

  // 학습 중 현재 카드 편집
  $("#btnEditStudyCard").addEventListener("click", () => {
    if (!session || !session.current) return;
    openCardModal(currentCard().id);
  });

  answerCard.addEventListener("click", () => reveal());
  $("#btnReveal").addEventListener("click", () => reveal());
  $$(".rate-btn").forEach(b => b.addEventListener("click", () => rate(Number(b.dataset.rate))));

  /* ── TTS ── */
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[가-힣]/.test(text) ? "ko-KR" : "en-US";
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
  $("#speakBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const card = session && currentCard();
    if (!card) return;
    if (card.type === "cloze") speak(clozeStrip(card.front));
    else speak(session.revealed ? card.back : card.front);
  });

  document.addEventListener("keydown", (e) => {
    if ($("#view-study").classList.contains("hidden")) return;
    if (e.target.matches("input, textarea")) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      // Anki처럼: 공개 전이면 답 공개, 공개 후면 '보통'으로 평가
      if (!session?.revealed) reveal();
      else rate(2);
    }
    if (["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key) - 1);
    if (e.key === "z" || e.key === "Z") undo();
    if (e.code === "Escape") quitStudy();
  });

  function finishSession() {
    $(".study-stage").classList.add("hidden");
    ratingRow.classList.add("hidden");
    $("#keyHint").textContent = "";
    $("#sessionChips").innerHTML = "";
    $("#doneSummary").textContent = t("study.doneSub", { n: session.total });
    $("#studyDone").classList.remove("hidden");
    burstPetals();
  }

  function burstPetals() {
    const host = $("#petalBurst");
    const glyphs = ["❀", "✿", "❁", "✾"];
    const colors = ["#e0aec0", "#c97f97", "#cfdd9c", "#a9b183"];
    host.innerHTML = Array.from({ length: 16 }, (_, i) => {
      const dx = (Math.random() - 0.5) * 460;
      const dy = 140 + Math.random() * 240;
      const rot = (Math.random() - 0.5) * 480;
      const delay = Math.random() * 0.5;
      return `<span style="--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--rot:${rot.toFixed(0)}deg;
        animation-delay:${delay.toFixed(2)}s;color:${colors[i % 4]};font-size:${12 + Math.random() * 10}px">${glyphs[i % 4]}</span>`;
    }).join("");
    setTimeout(() => { host.innerHTML = ""; }, 3200);
  }

  function quitStudy() {
    const wasGlobal = session?.global;
    session = null;
    speechSynthesis?.cancel?.();
    show(wasGlobal ? "home" : "deck");
  }
  $("#btnQuitStudy").addEventListener("click", quitStudy);
  $("#btnDoneBack").addEventListener("click", quitStudy);

  /* ══════════ 통계 ══════════ */
  function renderStats() {
    const s = Store.state;
    const todayCount = s.reviews[Store.todayKey()] || 0;
    const allReviews = Object.values(s.reviews).reduce((a, b) => a + b, 0);
    const retention = Store.retention();
    const icon = (id) => `<svg width="20" height="20"><use href="#${id}"/></svg>`;

    $("#statTiles").innerHTML = `
      <div class="stat-tile t1" style="--i:0"><span class="glyph">${icon("i-flower")}</span><div><b>${todayCount}</b><span>${t("stats.today")}</span></div></div>
      <div class="stat-tile t2" style="--i:1"><span class="glyph">${icon("i-flame")}</span><div><b>${Store.streak()}</b><span>${t("stats.streak")}</span></div></div>
      <div class="stat-tile t3" style="--i:2"><span class="glyph">${icon("i-layers")}</span><div><b>${s.cards.length}</b><span>${t("stats.cards", { d: s.decks.length })}</span></div></div>
      <div class="stat-tile t4" style="--i:3"><span class="glyph">${icon("i-sparkle")}</span><div><b>${allReviews}</b><span>${t("stats.reviews")}</span></div></div>
      <div class="stat-tile t5" style="--i:4"><span class="glyph">${icon("i-target")}</span><div><b>${retention == null ? "—" : retention + "%"}</b><span>${t("stats.retention")}</span></div></div>`;

    renderForecast();
    renderHeatmap();
  }

  function renderForecast() {
    const data = Store.forecast(7);
    const max = Math.max(1, ...data);
    const fmt = new Intl.DateTimeFormat(I18N.lang === "ko" ? "ko-KR" : "en-US", { weekday: "short" });
    $("#forecast").innerHTML = data.map((n, i) => {
      const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
      const label = i === 0 ? t("fc.today") : fmt.format(d);
      const h = Math.max(3, Math.round((n / max) * 88));
      return `
        <div class="fc-col ${i === 0 ? "today" : ""}">
          <span class="fc-count">${n}</span>
          <i class="fc-bar" style="height:${h}px"></i>
          <span class="fc-day">${label}</span>
        </div>`;
    }).join("");
  }

  function renderHeatmap() {
    const hm = $("#heatmap");
    const cells = [];
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - 7 * 12 + 1);

    const todayStr = Store.todayKey();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = Store.todayKey(d.getTime());
      const count = Store.state.reviews[key] || 0;
      const future = d > now;
      let lvl = 0;
      if (count >= 1) lvl = 1;
      if (count >= 5) lvl = 2;
      if (count >= 15) lvl = 3;
      if (count >= 30) lvl = 4;
      cells.push(`<i class="hm l${lvl} ${key === todayStr ? "today" : ""}"
        style="${future ? "visibility:hidden" : ""}"
        title="${key} · ${count}"></i>`);
    }
    hm.innerHTML = cells.join("");
  }

  /* ══════════ 내보내기 / 가져오기 (백업) ══════════ */
  function doExport() {
    const blob = new Blob([Store.exportJSON()], { type: "application/json" });
    downloadBlob(blob, `petale-backup-${Store.todayKey()}.json`);
    toast(t("toast.exported"));
  }
  $("#btnExport").addEventListener("click", doExport);
  $("#btnExport2").addEventListener("click", doExport);
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#btnImport2").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      Store.importJSON(await file.text());
      applySettingsToUI();
      show("home");
      toast(t("toast.imported"));
    } catch {
      toast(t("toast.badFile"));
    }
    e.target.value = "";
  });

  /* ══════════ 설정 ══════════ */
  const settingsModal = $("#settingsModal");

  function applySettingsToUI() {
    I18N.setLang(Store.settings.lang);
    document.documentElement.dataset.theme = Store.settings.theme;
    I18N.apply();
    $$("#langSeg .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.lang === Store.settings.lang));
    $$("#themeGrid .theme-swatch").forEach(b => b.classList.toggle("active", b.dataset.theme === Store.settings.theme));
    $("#ttsToggle").checked = !!Store.settings.tts;
    const remOn = !!Store.settings.reminders && Reminders.granted();
    $("#reminderToggle").checked = remOn;
    $("#reminderTime").value = Store.settings.reminderTime || "09:00";
    $("#reminderTimeRow").classList.toggle("hidden", !remOn);
    const steps = Store.settings.steps || SRS.defaultSteps();
    $$("#stepRows .step-row").forEach(row => {
      const key = row.dataset.step;
      const s = steps[key] || SRS.defaultSteps()[key];
      row.querySelector(".step-value").value = s.value;
      row.querySelector(".step-unit").value = s.unit;
    });
  }

  $("#btnSettings").addEventListener("click", () => { applySettingsToUI(); settingsModal.showModal(); });

  $$("#langSeg .seg-btn").forEach(b => b.addEventListener("click", () => {
    Store.setSetting("lang", b.dataset.lang);
    applySettingsToUI();
    // 열려 있는 화면의 동적 텍스트 갱신
    const active = views.find(v => !$(`#view-${v}`).classList.contains("hidden"));
    if (active && active !== "study") show(active);
  }));

  $$("#themeGrid .theme-swatch").forEach(b => b.addEventListener("click", () => {
    Store.setSetting("theme", b.dataset.theme);
    applySettingsToUI();
  }));

  $("#ttsToggle").addEventListener("change", (e) => Store.setSetting("tts", e.target.checked));

  // 학습 알림 (망각곡선 기반)
  $("#reminderToggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const res = await Reminders.enable();
      if (res === "granted") { toast(t("toast.remindersOn")); }
      else {
        e.target.checked = false;
        toast(t(res === "unsupported" ? "toast.remindersUnsupported" : "toast.remindersDenied"));
      }
    } else {
      Reminders.disable();
      toast(t("toast.remindersOff"));
    }
    $("#reminderTimeRow").classList.toggle("hidden", !$("#reminderToggle").checked);
  });
  $("#reminderTime").addEventListener("change", (e) => {
    Store.setSetting("reminderTime", e.target.value || "09:00");
    Reminders.start(); // 새 시각으로 재예약
  });

  // 학습 단계(s/m/h/day) — 값·단위 중 하나라도 바뀌면 즉시 저장 + SRS 반영
  $$("#stepRows .step-row").forEach(row => {
    const key = row.dataset.step;
    const commit = () => {
      const value = Math.max(0.01, parseFloat(row.querySelector(".step-value").value) || 1);
      const unit = row.querySelector(".step-unit").value;
      Store.setSteps({ [key]: { value, unit } });
      toast(t("toast.stepsSaved"));
    };
    row.querySelector(".step-value").addEventListener("change", commit);
    row.querySelector(".step-unit").addEventListener("change", commit);
  });

  /* ══════════ 친구 ══════════ */
  async function renderFriends() {
    await socialReady;
    friendIdsCache = null; // 친구 화면 진입 시 탐색 캐시 초기화(친구 변동 반영)
    const authed = !!Social.profile;
    $("#authCard").classList.toggle("hidden", authed);
    $("#friendsPanel").classList.toggle("hidden", !authed);
    if (authed) renderFriendsPanel();
    else setAuthMode(authMode);
  }

  function setAuthMode(mode) {
    authMode = mode;
    $("#authUsernameField").classList.toggle("hidden", mode !== "signup");
    $("#authUsername").required = mode === "signup";
    $("#authSubmit").textContent = t(mode === "signup" ? "fr.signup" : "fr.signin");
    $("#authSwitch").textContent = t(mode === "signup" ? "fr.toSignin" : "fr.toSignup");
    $("#authError").textContent = "";
  }
  $("#authSwitch").addEventListener("click", () => setAuthMode(authMode === "signup" ? "signin" : "signup"));

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#authEmail").value.trim();
    const pw = $("#authPassword").value;
    $("#authError").textContent = "";
    $("#authSubmit").disabled = true;
    try {
      if (authMode === "signup") {
        const { needsConfirm } = await Social.signUp(email, pw, $("#authUsername").value);
        if (needsConfirm) {
          $("#authError").textContent = t("fr.confirmMail");
        } else {
          renderFriends();
        }
      } else {
        await Social.signIn(email, pw);
        renderFriends();
      }
    } catch (err) {
      $("#authError").textContent = mapSocialError(err);
    } finally {
      $("#authSubmit").disabled = false;
    }
  });

  function mapSocialError(err) {
    const m = err?.message || "";
    if (m === "username_taken") return t("fr.usernameTaken");
    if (m === "bad_username") return t("fr.username");
    if (m === "not_found") return t("fr.notFound");
    if (m === "already") return t("fr.already");
    if (m === "self") return t("fr.self");
    if (/fetch|network/i.test(m)) return t("fr.offline");
    return t("fr.authFail", { msg: m });
  }

  $("#btnSignOut").addEventListener("click", async () => {
    try { await Social.pushCollection(); } catch { /* 마지막 저장 시도 */ }
    Store.setOnSave(null); // 로그아웃 후 클라우드 푸시 중단
    await Social.signOut();
    setGateMode("signin");
    showGate();
  });

  async function renderFriendsPanel() {
    $("#meHello").innerHTML = t("fr.hello", { name: escapeHTML(Social.profile.username) });
    const today = Store.state.reviews[Store.todayKey()] || 0;
    $("#meChips").innerHTML = `
      <span class="pill new">${t("fr.myToday", { n: today })}</span>
      <span class="pill due">${t("fr.myStreak", { n: Store.streak() })}</span>`;

    let ov = null;
    try { ov = await Social.fetchOverview(); } catch { /* 아래 offline 처리 */ }
    if (!ov) {
      $("#friendList").innerHTML = `<li class="friend-empty">${t("fr.offline")}</li>`;
      $("#incomingWrap").classList.add("hidden");
      return;
    }

    const incoming = $("#incomingList");
    $("#incomingWrap").classList.toggle("hidden", !ov.incoming.length);
    incoming.innerHTML = ov.incoming.map(r => `
      <li class="friend-row" data-id="${r.id}">
        <span class="friend-avatar">${escapeHTML(r.username[0] || "?")}</span>
        <span class="fr-name">${escapeHTML(r.username)}</span>
        <button class="btn primary sm acc">${t("fr.accept")}</button>
        <button class="btn ghost sm dec">${t("fr.decline")}</button>
      </li>`).join("");
    incoming.querySelectorAll(".friend-row").forEach(row => {
      row.querySelector(".acc").addEventListener("click", async () => {
        await Social.respondRequest(Number(row.dataset.id), true);
        renderFriendsPanel();
      });
      row.querySelector(".dec").addEventListener("click", async () => {
        await Social.respondRequest(Number(row.dataset.id), false);
        renderFriendsPanel();
      });
    });

    const list = $("#friendList");
    if (!ov.friends.length) {
      list.innerHTML = `<li class="friend-empty">${t("fr.empty")}</li>`;
      return;
    }
    list.innerHTML = ov.friends.map(f => {
      const st = ov.stats[f.id] || { today: 0, streak: 0 };
      return `
        <li class="friend-item" data-id="${f.id}">
          <button type="button" class="friend-row friend-row-btn">
            <span class="friend-avatar">${escapeHTML((f.username || "?")[0])}</span>
            <span class="fr-name">${escapeHTML(f.username || "?")}</span>
            <span class="fr-meta">
              <span class="pill new">${t("fr.today", { n: st.today })}</span>
              <span class="pill due">${t("fr.streakN", { n: st.streak })}</span>
            </span>
            <svg class="friend-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="friend-decks hidden"></div>
        </li>`;
    }).join("");

    list.querySelectorAll(".friend-item").forEach(item => {
      const btn = item.querySelector(".friend-row-btn");
      const box = item.querySelector(".friend-decks");
      btn.addEventListener("click", () => {
        const open = !box.classList.contains("hidden");
        if (open) { box.classList.add("hidden"); item.classList.remove("open"); return; }
        item.classList.add("open");
        box.classList.remove("hidden");
        if (!box.dataset.loaded) loadFriendDecks(item.dataset.id, box);
      });
    });
  }

  // 친구가 공개한 덱을 불러와 "가져오기" 할 수 있게 보여준다
  async function loadFriendDecks(friendId, box) {
    box.innerHTML = `<p class="friend-decks-msg">…</p>`;
    let decks;
    try {
      decks = await Promise.race([
        Social.searchDecks("", [friendId]),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
    } catch {
      box.innerHTML = `<p class="friend-decks-msg">${t("fr.offline")}</p>`;
      return;
    }
    box.dataset.loaded = "1";
    if (!decks.length) {
      box.innerHTML = `<p class="friend-decks-msg">${t("fr.noDecks")}</p>`;
      return;
    }
    box.innerHTML = decks.map(r => `
      <div class="friend-deck-row" data-id="${r.id}">
        <div class="texts">
          <div class="fr-name">${escapeHTML(r.name)}</div>
          ${r.description ? `<div class="explore-desc">${escapeHTML(r.description)}</div>` : ""}
        </div>
        <span class="pill total">${t("explore.cards", { n: r.cardCount })}</span>
        <button class="btn secondary sm get">${t("explore.get")}</button>
      </div>`).join("");
    box.querySelectorAll(".friend-deck-row .get").forEach(btn =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const { deck, count } = await Social.downloadDeck(btn.closest(".friend-deck-row").dataset.id);
          toast(t("explore.got", { name: deck.name, n: count }));
        } catch {
          toast(t("fr.offline"));
        } finally {
          btn.disabled = false;
        }
      }));
  }

  $("#friendAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#friendName").value.trim();
    if (!name) return;
    try {
      await Social.sendRequest(name);
      $("#friendName").value = "";
      toast(t("fr.requested"));
    } catch (err) {
      toast(mapSocialError(err));
    }
  });

  /* ══════════ 탐색 (공개 덱 검색) ══════════ */
  let exploreTimer = null;
  let exploreScope = "all"; // "all" | "friends"
  let friendIdsCache = null; // 친구만 필터용 — 세션 중 캐시

  async function renderExplore() {
    const q = $("#exploreInput").value.trim();
    const list = $("#exploreList");
    list.innerHTML = `<li class="friend-empty">…</li>`;

    let ownerIds; // undefined = 전체
    if (exploreScope === "friends") {
      if (!Social.profile) {
        list.innerHTML = `<li class="friend-empty">${t("explore.noFriends")}</li>`;
        $("#exploreHeading").classList.add("hidden");
        return;
      }
      try {
        if (!friendIdsCache) {
          const ov = await Social.fetchOverview();
          friendIdsCache = (ov?.friends || []).map(f => f.id);
        }
      } catch { friendIdsCache = []; }
      if (!friendIdsCache.length) {
        list.innerHTML = `<li class="friend-empty">${t("explore.noFriends")}</li>`;
        $("#exploreHeading").classList.add("hidden");
        return;
      }
      ownerIds = friendIdsCache;
    }

    let results;
    try {
      results = await Promise.race([
        Social.searchDecks(q, ownerIds),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
    } catch {
      list.innerHTML = `<li class="friend-empty">${t("fr.offline")}</li>`;
      $("#exploreHeading").classList.add("hidden");
      return;
    }
    $("#exploreHeading").classList.toggle("hidden", !!q || !results.length);

    if (!results.length) {
      list.innerHTML = `<li class="friend-empty">${exploreScope === "friends" ? t("explore.friendsEmpty") : t("explore.empty")}</li>`;
      return;
    }
    list.innerHTML = results.map(r => `
      <li class="friend-row explore-row" data-id="${r.id}">
        <span class="friend-avatar">${escapeHTML((r.author || "?")[0])}</span>
        <div class="texts">
          <div class="fr-name">${escapeHTML(r.name)}</div>
          <div class="explore-desc">${escapeHTML(r.description || "")}</div>
        </div>
        <span class="fr-meta">
          <span class="pill total">${t("explore.cards", { n: r.cardCount })}</span>
          <span class="pill new">${t("explore.downloads", { n: r.downloads })}</span>
        </span>
        <button class="btn secondary sm get">${t("explore.get")}</button>
      </li>`).join("");

    list.querySelectorAll(".explore-row .get").forEach(btn =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const { deck, count } = await Social.downloadDeck(btn.closest(".explore-row").dataset.id);
          toast(t("explore.got", { name: deck.name, n: count }));
        } catch {
          toast(t("fr.offline"));
        } finally {
          btn.disabled = false;
        }
      }));
  }

  $("#exploreInput").addEventListener("input", () => {
    clearTimeout(exploreTimer);
    exploreTimer = setTimeout(renderExplore, 350);
  });

  $$("#exploreScope .seg-btn").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.scope === exploreScope) return;
    exploreScope = b.dataset.scope;
    $$("#exploreScope .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    renderExplore();
  }));

  /* ══════════ 로그인 게이트 ══════════ */
  let gateMode = "signin";

  function setGateMode(mode) {
    gateMode = mode;
    $("#gateUsernameField").classList.toggle("hidden", mode !== "signup");
    $("#gateUsername").required = mode === "signup";
    $("#gateSubmit").textContent = t(mode === "signup" ? "fr.signup" : "fr.signin");
    $("#gateSwitch").textContent = t(mode === "signup" ? "fr.toSignin" : "fr.toSignup");
    $("#gateTag").textContent = t(mode === "signup" ? "gate.tagSignup" : "gate.tagSignin");
    $("#gateError").textContent = "";
  }

  function markGateLang() {
    $$(".gate-lang button").forEach(b => b.classList.toggle("active", b.dataset.lang === Store.settings.lang));
  }

  // 로그인 화면 표시 (미인증)
  function showGate() {
    document.body.classList.add("pre-auth");
    $("#gateLoading").classList.add("hidden");
    $("#gateBody").classList.remove("hidden");
    markGateLang();
    setGateMode(gateMode);
  }

  // 로그인됨 → 동기화 후 앱 진입
  async function enterApp() {
    $("#gateBody").classList.add("hidden");
    const loadEl = $("#gateLoading");
    loadEl.classList.remove("hidden");
    loadEl.querySelector("[data-i18n]").textContent = t("gate.syncing");

    Store.setOnSave(() => Social.schedulePush());
    try {
      const r = await Social.syncOnLogin();
      if (r && r.pulled) applySettingsToUI(); // 서버본 채택 시 언어·테마 반영
    } catch { /* 오프라인이어도 로컬 데이터로 진입 */ }

    document.body.classList.remove("pre-auth");
    I18N.apply();
    show("home");
    Reminders.start(); // 로그인·동기화 후 학습 알림 예약 (설정 켜져 있을 때만)

    // 이미지 기기 간 동기화(백그라운드): 다른 기기에서 만든 이미지를 내려받고,
    // 도착하면 현재 화면을 '제자리에서' 다시 그린다(스크롤 위치 유지 — 위로 안 튀게).
    let mediaRefreshTimer = null;
    Social.syncMedia(() => {
      clearTimeout(mediaRefreshTimer);
      mediaRefreshTimer = setTimeout(refreshCurrentView, 400);
    });
  }

  // 현재 화면 콘텐츠만 다시 그림 (스크롤 이동 없음)
  function refreshCurrentView() {
    const v = views.find(x => !$(`#view-${x}`).classList.contains("hidden"));
    if (v === "home") renderHome();
    else if (v === "deck") renderDeck();
    else if (v === "study" && session && session.current) {
      const c = currentCard();
      renderFace($("#acQuestion"), c, session.revealed);
      if (session.revealed && c.type === "basic") renderFace($("#acAnswer"), c, true);
    }
  }

  $("#gateSwitch").addEventListener("click", () => setGateMode(gateMode === "signup" ? "signin" : "signup"));

  $$(".gate-lang button").forEach(b => b.addEventListener("click", () => {
    Store.setSetting("lang", b.dataset.lang);
    I18N.setLang(b.dataset.lang);
    I18N.apply();
    markGateLang();
    setGateMode(gateMode);
  }));

  $("#gateGoogle").addEventListener("click", async () => {
    $("#gateError").textContent = "";
    try {
      await Social.signInWithGoogle(); // 성공 시 구글로 리다이렉트
    } catch (err) {
      $("#gateError").textContent = mapSocialError(err);
    }
  });

  $("#gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#gateEmail").value.trim();
    const pw = $("#gatePassword").value;
    $("#gateError").textContent = "";
    $("#gateSubmit").disabled = true;
    try {
      if (gateMode === "signup") {
        const { needsConfirm } = await Social.signUp(email, pw, $("#gateUsername").value);
        if (needsConfirm) {
          $("#gateError").textContent = t("fr.confirmMail");
          $("#gateSubmit").disabled = false;
          return;
        }
      } else {
        await Social.signIn(email, pw);
      }
      await enterApp();
    } catch (err) {
      $("#gateError").textContent = mapSocialError(err);
      $("#gateSubmit").disabled = false;
    }
  });

  /* ══════════ 시작 ══════════ */
  Practice.bind();
  I18N.apply();

  (async () => {
    const profile = await socialReady; // 세션 복원 (구글 리다이렉트 복귀 포함)
    if (profile) { await enterApp(); return; }
    showGate();
    // 리다이렉트 로그인이 실패했으면 조용히 튕기지 말고 이유를 보여준다
    const authErr = Social.consumeAuthError?.();
    if (authErr) $("#gateError").textContent = t("fr.authFail", { msg: authErr });
  })();

  // PWA: 오프라인 지원 + 홈 화면 설치 (https 또는 localhost에서만 동작)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
