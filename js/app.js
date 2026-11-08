/* ═══════════════════════════════════════════════════════
   Petale App — 화면 전환 · 학습 흐름 · 상호작용
   ═══════════════════════════════════════════════════════ */

(async () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  await Store.load(); // IndexedDB에서 비동기 로드
  Store.setQuotaHandler(() => toast(t("toast.storageFull")));
  I18N.setLang(Store.settings.lang);
  // 외형(라이트/다크/자동) → 실제 테마 해석. noir = 다크, 그 외 = 라이트 팔레트.
  const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: false, addEventListener() {} };
  function resolveTheme() {
    const ap = Store.settings.appearance || "auto";
    let light = Store.settings.theme || "pearl";
    if (light === "noir") light = "pearl";
    if (ap === "dark") return "noir";
    if (ap === "light") return light;
    return darkMQ.matches ? "noir" : light; // auto = 시스템 설정 따름
  }
  function applyTheme() {
    document.documentElement.dataset.theme = resolveTheme();
    // 브라우저 상태바(theme-color)도 배경에 맞춘다
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      if (bg) meta.setAttribute("content", bg);
    }
  }
  applyTheme();
  // 자동 모드일 때 시스템 다크 설정이 바뀌면 즉시 반영
  darkMQ.addEventListener("change", () => { if ((Store.settings.appearance || "auto") === "auto") applyTheme(); });
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
  const AGAIN_THRESHOLD = 5;     // '다시'를 이 횟수 이상 누른 카드 = 자주 틀림(leech) 후보
  const MASTERED_INTERVAL = 21;  // 복습 간격이 이 일수(일) 이상이면 사실상 마스터 → 자주 틀림에서 제외
  // '자주 틀림'(leech): 여러 번 틀렸지만 아직 마스터하지 못한, '지금도 어려운' 카드만
  const isLeech = c => (c.againCount || 0) >= AGAIN_THRESHOLD && !c.suspended && c.interval < MASTERED_INTERVAL;
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
  const RICH_ALLOWED_TAGS = new Set(["B", "STRONG", "U", "EM", "I", "MARK", "SPAN", "BR",
    "UL", "OL", "LI",
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION"]);
  // 카드 노트 서식용 허용 클래스: 소제목(가운데)·본문(좌측)·노트 줄(.nb/.nt)·초록 불릿
  const RICH_CLASS_OK = new Set(["card-head", "card-body", "nb", "nt", "gbull", "hh"]);
  const RICH_BLOCK_CLASS = new Set(["card-head", "card-body", "nb"]); // 블록으로 보존할 div 클래스
  // 앱에 실제로 로드된 글꼴만 허용 — 없는 글꼴은 이상한 시스템 폴백으로 렌더되므로 제외한다
  const RICH_FONT_OK = /^(pretendard variable|gowun batang|cormorant garamond|serif|sans-serif|monospace)$/i;
  const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
  function sanitizeStyleDecl(style) {
    const out = [];
    for (const part of String(style || "").split(";")) {
      // 형광펜 색은 --hl 커스텀 속성에 담아 보존(렌더는 CSS가 '글자 아래 밴드'로 처리)
      const hv = /^\s*--hl\s*:\s*([^;]+?)\s*$/.exec(part);
      if (hv) { if (COLOR_RE.test(hv[1])) out.push(`--hl: ${hv[1]}`); continue; }
      const m = /^\s*(color|background-color|font-family|font-size|text-align)\s*:\s*([^;]+?)\s*$/.exec(part);
      if (!m) continue;
      const prop = m[1], val = m[2];
      if ((prop === "color" || prop === "background-color") && /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/.test(val)) {
        out.push(`${prop}: ${val}`);
      } else if (prop === "text-align" && /^(left|center|right)$/.test(val)) {
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
          // 카드 노트 서식 블록(소제목/본문)은 정렬을 위해 블록으로 보존한다
          const keepCls = tag === "DIV" ? [...child.classList].filter(c => RICH_BLOCK_CLASS.has(c)) : [];
          if (keepCls.length) {
            clean(child);
            [...child.attributes].forEach(a => child.removeAttribute(a.name));
            child.className = keepCls.join(" ");
            return;
          }
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
          } else if ((attr.name === "colspan" || attr.name === "rowspan") && /^[1-9]\d?$/.test(attr.value)) {
            // 표 셀 병합은 유지(숫자만)
          } else if (attr.name === "class") {
            // 카드 노트 서식 클래스(card-head/card-body/gbull)만 허용
            const keep = attr.value.split(/\s+/).filter(Boolean).filter(c => RICH_CLASS_OK.has(c));
            if (keep.length) child.setAttribute("class", keep.join(" ")); else child.removeAttribute("class");
          } else {
            child.removeAttribute(attr.name);
          }
        });
        if (tag === "TABLE") child.setAttribute("class", "ctbl"); // 모든 표에 일관된 스타일 클래스
        // 형광펜: mark/span의 배경색(또는 기존 --hl)을 '글자 아래 밴드' 형태로 정규화
        if (tag === "MARK" || tag === "SPAN") {
          const st = child.getAttribute("style") || "";
          const bg = /(?:^|;)\s*background-color:\s*([^;]+)/i.exec(st);
          const hl = /(?:^|;)\s*--hl:\s*([^;]+)/i.exec(st);
          let color = ((hl && hl[1]) || (bg && bg[1]) || "").trim();
          if (/^#b2dbba$/i.test(color)) color = "#d6e3b8"; // 이전에 쓰던 초록을 원래 색상코드로 되돌림
          if (color) {
            const keep = st.split(";").map(s => s.trim())
              .filter(s => s && !/^background-color\s*:/i.test(s) && !/^--hl\s*:/i.test(s));
            keep.push(`--hl: ${color}`);
            child.setAttribute("style", keep.join("; "));
            child.setAttribute("class", "hl");
          }
        }
        clean(child);
      });
    })(root);
    migrateNoteBullets(root); // 옛 .nb/.gbull 불릿 구조 → 편집 가능한 <ul><li>
    newlinesToBr(root);       // 편집기가 넣는 줄바꿈(\n)을 실제 <br>로 — 모든 화면에서 줄바꿈 보이게
    return root.innerHTML;
  }

  // 텍스트 노드의 줄바꿈 문자(\n)를 <br> 요소로 바꾼다. 편집기(.rich-field)는 pre-wrap이라
  // \n이 줄바꿈으로 보이지만, 카드 뷰 등 pre-wrap이 아닌 곳에선 공백으로 뭉개진다.
  // 표 안은 구조적 공백(\n)이 섞여 있어 건드리지 않는다.
  function newlinesToBr(root) {
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) texts.push(n);
    for (const tn of texts) {
      if (!tn.nodeValue.includes("\n")) continue;
      if (tn.parentElement && tn.parentElement.closest("table")) continue; // 표 안은 그대로
      const parts = tn.nodeValue.split("\n");
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => {
        if (i > 0) frag.appendChild(document.createElement("br"));
        if (part) frag.appendChild(document.createTextNode(part));
      });
      tn.replaceWith(frag);
    }
  }

  // 예전 가져오기가 만든 .nb(줄)·.gbull(불릿) 블록 구조를 진짜 <ul><li> 목록으로 바꾼다.
  // contenteditable에서 커스텀 블록은 편집 시 깨지기 쉬워서, 브라우저가 기본 지원하는 목록으로 치환한다.
  function migrateNoteBullets(root) {
    const parents = new Set();
    root.querySelectorAll(".nb").forEach(nb => nb.parentNode && parents.add(nb.parentNode));
    parents.forEach(parent => {
      let ul = null;
      [...parent.childNodes].forEach(node => {
        const isNb = node.nodeType === 1 && node.classList && node.classList.contains("nb");
        if (!isNb) { if (!(node.nodeType === 1 && node.tagName === "UL")) ul = null; return; }
        const nt = node.querySelector(".nt") || node;
        if (node.querySelector(".gbull")) {
          // 불릿 줄 → <li>, 연속 불릿은 하나의 <ul>로 묶기
          const li = document.createElement("li");
          while (nt.firstChild) li.appendChild(nt.firstChild);
          if (!ul) { ul = document.createElement("ul"); parent.insertBefore(ul, node); }
          ul.appendChild(li);
          node.remove();
        } else {
          // 불릿 아닌 줄 → 텍스트 + 줄바꿈
          ul = null;
          const frag = document.createDocumentFragment();
          while (nt.firstChild) frag.appendChild(nt.firstChild);
          frag.appendChild(document.createElement("br"));
          parent.replaceChild(frag, node);
        }
      });
    });
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

  // 들여쓰기(앞 공백/탭)까지 잡기 위해 선행 공백을 캡처한다. 탭 1개 = 공백 2칸.
  const BULLET_RE = /^(\s*)[-–—•·*]\s+([\s\S]*)$/;
  const NUMBER_RE = /^(\s*)\d+[.)]\s+([\s\S]*)$/;
  const isListLine = s => BULLET_RE.test(s) || NUMBER_RE.test(s);
  const indentWidth = s => s.replace(/\t/g, "  ").length;

  // 연속된 목록 줄(group)을 들여쓰기 깊이에 따라 중첩된 <ul>/<ol>로 만든다.
  function buildNestedList(group) {
    let html = "";
    const stack = []; // [{indent, type}]
    for (const it of group) {
      // 더 얕은 들여쓰기면 깊은 목록부터 닫는다
      while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</${stack.pop().type}>`;
      const top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {            // 더 깊어짐 → 새 목록 시작
        stack.push({ indent: it.indent, type: it.type });
        html += `<${it.type}>`;
      } else if (top.type !== it.type) {               // 같은 깊이, 종류만 다름 → 교체
        html += `</${stack.pop().type}>`;
        stack.push({ indent: it.indent, type: it.type });
        html += `<${it.type}>`;
      }
      html += `<li>${inlineMd(it.text.trim())}</li>`;
    }
    while (stack.length) html += `</${stack.pop().type}>`;
    return html;
  }

  // 여러 줄 텍스트 → HTML: 연속된 불릿(-, •, * …)은 <ul>, 번호(1. 2) …)는 <ol>,
  // 들여쓴 줄은 중첩 목록으로. 그 외 줄은 <br>로 이어 붙인다. inlineMd(**굵게**·==형광==)도 적용.
  function linesToHtml(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (isListLine(lines[i])) {
        const group = [];
        while (i < lines.length && isListLine(lines[i])) {
          const bm = lines[i].match(BULLET_RE), nm = lines[i].match(NUMBER_RE), m = bm || nm;
          group.push({ indent: indentWidth(m[1]), type: bm ? "ul" : "ol", text: m[2] });
          i++;
        }
        out.push(buildNestedList(group));
      } else {
        const text = [];
        while (i < lines.length && !isListLine(lines[i])) { text.push(inlineMd(lines[i])); i++; }
        out.push(text.join("<br>"));
      }
    }
    return out.join("");
  }

  // 텍스트 노트를 카드 서식으로: 첫 줄(소제목)은 가운데, 그 아래 본문은 좌측 정렬된 가운데 칼럼으로.
  // 불릿/번호 줄은 진짜 <ul>/<ol> 목록으로 — contenteditable에서 바로 편집할 수 있다.
  function formatNote(block) {
    const lines = String(block).split("\n");
    const isList = s => BULLET_RE.test(s) || NUMBER_RE.test(s);
    let head = "", start = 0;
    // 첫 줄이 목록이 아니고 아래에 본문이 있으면 소제목으로 본다(초록 형광펜 하이라이트)
    if (lines.length >= 2 && lines[0].trim() && !isList(lines[0])) {
      head = `<div class="card-head"><span class="hh">${inlineMd(lines[0].trim())}</span></div>`;
      start = 1;
    }
    const rest = lines.slice(start);
    // 소제목이나 목록이 있을 때만 노트 서식 적용 — 단순 빈칸 카드(한 줄 등)는 기존 그대로
    if (head || rest.some(isList)) {
      return `${head}<div class="card-body">${linesToHtml(rest)}</div>`;
    }
    return rest.map(l => inlineMd(l)).join("<br>");
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

  // 개요(overview)용: 모든 빈칸을 초록 정답 박스로 드러낸 본문. 노트를 한눈에 읽는 용도.
  function renderClozeAll(text) {
    const safe = sanitizeRichHTML(text);
    return safe.replace(CLOZE_RE, (_, i, ans) => `<span class="cloze-answer">${ans}</span>`);
  }

  // 카드 목록/미리보기용 표시 텍스트
  function cardPreview(card) {
    if (card.type === "occlusion") {
      return { front: card.front || `🖼 ${t("type.occlusion")} #${card.hideIndex + 1}`, back: "" };
    }
    if (card.type === "cloze") {
      // 미리보기는 서식·표 태그를 걷어낸 읽기 텍스트로 (목록에서 깔끔하게)
      const plain = clozeStrip(card.front).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { front: plain, back: `${t("type.cloze")} c${card.clozeIndex}` };
    }
    return { front: card.front, back: card.back };
  }

  /* ══════════ 화면 전환 ══════════ */
  const views = ["home", "deck", "study", "stats", "friends", "room", "quiz", "write", "learn", "flash", "explore", "docs", "docreader", "overview", "recall"];

  function show(view) {
    document.body.dataset.view = view;
    views.forEach(v => $(`#view-${v}`).classList.toggle("hidden", v !== view));
    $$(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    if (view === "home") renderHome();
    if (view === "deck") renderDeck();
    if (view === "stats") renderStats();
    if (view === "friends") renderFriends();
    if (view === "room") renderRoom();
    if (view === "explore") renderExplore();
    if (view === "docs") renderDocs();
    if (view === "overview") renderOverview();
    if (view === "recall") renderRecall();
    window.scrollTo({ top: 0 });
    // Bunny Café: 룸에선 크게, 그 외 화면으로 나가면 바로 접기 (오디오·타이머는 유지)
    if (view === "room") setCafeState("room");
    else if (cafeState === "room") setCafeState("collapsed");
  }

  $("#brandHome").addEventListener("click", () => show("home"));
  $$(".nav-link").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  $$("[data-back]").forEach(b => b.addEventListener("click", () => show(b.dataset.back)));

  // 앱으로 돌아왔을 때, 보고 있는 '받은 덱'의 최신본을 자동으로 반영
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !Social.profile) return;
    if ($("#view-deck").classList.contains("hidden")) return;
    const deck = Store.getDeck(currentDeckId);
    if (deck && (deck.sourceId || (deck.collab && deck.sharedId))) checkDeckUpdate(deck);
  });

  /* ══════════ 문서 (빈칸 리더) ══════════ */
  const DOC_TOKEN = /\{\{c\d+::([\s\S]*?)\}\}/g;
  // 문서 렌더링에서 통째로 제거할 위험·불필요 태그
  // 격리 iframe이라 <button>은 안전하고 탭 내비게이션에 필요하므로 보존한다.
  const DOC_DROP = "script,noscript,iframe,object,embed,link,meta,base,form,input,select,textarea,style,title";
  let curDocId = null, docRevealed = false, docEditing = false, docModalMode = "new", docModalId = null;

  // 문서 정리: 위험한 것만 제거하고 서식(스타일·클래스·표 등)은 최대한 보존. {{cN::}} 텍스트 보존.
  function sanitizeDocHTML(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll(DOC_DROP).forEach(n => n.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(a => {
        const n = a.name.toLowerCase();
        if (n.startsWith("on")) el.removeAttribute(a.name);                       // 이벤트 핸들러 제거
        else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      });
    });
    return doc.body.innerHTML;
  }

  function renumberDoc(html) {
    let n = 0;
    return String(html).replace(DOC_TOKEN, (_, a) => `{{c${++n}::${a}}}`);
  }

  // 강조(굵게·형광펜·밑줄·이탤릭)된 부분을 {{cN::…}} 빈칸으로 변환
  function docAutoBlank(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("b,strong,mark,u,em").forEach(el => {
      if (el.querySelector("b,strong,mark,u,em")) return; // 중첩은 안쪽만
      const text = (el.textContent || "").trim();
      if (!text) { el.remove(); return; }
      el.replaceWith(doc.createTextNode(`{{c1::${text}}}`));
    });
    return renumberDoc(doc.body.innerHTML);
  }

  function plainToHtml(raw) {
    const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return raw.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  }

  // 문서 본문(html) + 원본 스타일(css)로 분리 — 격리된 iframe에서 렌더링하므로 css는 원본 그대로 보존
  function buildDocHtml(raw, auto) {
    const hasTags = /<[a-z!/][\s\S]*?>/i.test(raw);
    const src = hasTags ? raw : plainToHtml(raw);
    const doc = new DOMParser().parseFromString(src, "text/html");
    let css = "";
    doc.querySelectorAll("style").forEach(s => { css += "\n" + s.textContent; }); // <style> 블록 수집(그대로)
    let html = sanitizeDocHTML(doc.body.innerHTML);
    if (auto) html = docAutoBlank(html);
    return { html: renumberDoc(html), css };
  }

  const NO_SUBJECT = "__nosub__"; // 과목 미지정 필터 센티넬
  let curDocSubject = null;       // null = 전체, NO_SUBJECT = 과목 없음, 그 외 = 과목명

  // 문서들에 실제로 쓰인 과목 목록(가나다/알파벳 순)
  function docSubjects() {
    const set = new Set();
    Store.state.docs.forEach(d => { const s = (d.subject || "").trim(); if (s) set.add(s); });
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }

  function renderDocSubjectBar() {
    const bar = $("#docSubjectBar");
    const subs = docSubjects();
    const hasUnsorted = Store.state.docs.some(d => !(d.subject || "").trim());
    // 과목이 하나도 없으면 바 자체를 숨겨 화면을 깔끔하게
    if (!subs.length) { bar.innerHTML = ""; bar.hidden = true; curDocSubject = null; return; }
    bar.hidden = false;
    // 선택된 과목이 사라졌으면 전체로
    if (curDocSubject && curDocSubject !== NO_SUBJECT && !subs.includes(curDocSubject)) curDocSubject = null;
    if (curDocSubject === NO_SUBJECT && !hasUnsorted) curDocSubject = null;
    const chip = (key, label) =>
      `<button class="fchip${curDocSubject === key ? " active" : ""}" data-sub="${key === null ? "" : escapeHTML(key)}">${escapeHTML(label)}</button>`;
    let html = chip(null, t("docs.allSubjects"));
    subs.forEach(s => { html += chip(s, s); });
    if (hasUnsorted) html += chip(NO_SUBJECT, t("docs.noSubject"));
    bar.innerHTML = html;
    bar.querySelectorAll(".fchip").forEach(el => {
      el.addEventListener("click", () => {
        const v = el.dataset.sub;
        curDocSubject = v === "" ? null : v;
        renderDocs();
      });
    });
  }

  function docCardHTML(d) {
    const blanks = (d.html.match(DOC_TOKEN) || []).length;
    const preview = escapeHTML(sanitizeDocHTML(d.html).replace(/<[^>]+>/g, " ").replace(DOC_TOKEN, "___").replace(/\s+/g, " ").trim().slice(0, 80));
    return `<article class="doc-card" data-id="${d.id}" tabindex="0" role="button">
        <h3 class="doc-card-title">${escapeHTML(d.name)}</h3>
        <p class="doc-card-preview">${preview}</p>
        <span class="doc-card-meta">${t("docs.blanks", { n: blanks })}</span>
      </article>`;
  }

  function renderDocs() {
    renderDocSubjectBar();
    const wrap = $("#docGroups");
    const docs = Store.state.docs.slice().sort((a, b) => b.created - a.created);
    if (!docs.length) { wrap.innerHTML = `<p class="list-empty">${t("docs.empty")}</p>`; return; }

    const subOf = d => (d.subject || "").trim();
    const gridOf = arr => `<div class="doc-grid">${arr.map(docCardHTML).join("")}</div>`;

    if (curDocSubject === null) {
      // 전체 보기: 과목별로 묶어 소제목과 함께 (과목 없는 문서는 맨 아래)
      const subs = docSubjects();
      const parts = [];
      subs.forEach(s => {
        const arr = docs.filter(d => subOf(d) === s);
        if (arr.length) parts.push(`<div class="doc-group"><h2 class="doc-group-title">${escapeHTML(s)}<span class="doc-group-count">${arr.length}</span></h2>${gridOf(arr)}</div>`);
      });
      const unsorted = docs.filter(d => !subOf(d));
      if (unsorted.length) {
        const title = subs.length ? t("docs.noSubject") : "";
        parts.push(`<div class="doc-group">${title ? `<h2 class="doc-group-title">${escapeHTML(title)}<span class="doc-group-count">${unsorted.length}</span></h2>` : ""}${gridOf(unsorted)}</div>`);
      }
      wrap.innerHTML = parts.join("");
    } else {
      const arr = curDocSubject === NO_SUBJECT ? docs.filter(d => !subOf(d)) : docs.filter(d => subOf(d) === curDocSubject);
      wrap.innerHTML = arr.length ? gridOf(arr) : `<p class="list-empty">${t("docs.empty")}</p>`;
    }

    wrap.querySelectorAll(".doc-card").forEach(el => {
      el.addEventListener("click", () => openDocReader(el.dataset.id));
      el.addEventListener("keydown", e => { if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); openDocReader(el.dataset.id); } });
    });
  }

  function openDocReader(id) {
    const doc = Store.getDoc(id);
    if (!doc) return;
    curDocId = id;
    docRevealed = false;
    docEditing = false;
    show("docreader");
    $("#docReaderTitle").textContent = doc.name;
    renderDocFrame();
    syncDocButtons();
  }

  // 문서를 격리된 iframe 안에서 원본 CSS·구조 그대로 렌더링하고, 그 위에 빈칸을 얹는다.
  function renderDocFrame() {
    const doc = Store.getDoc(curDocId);
    if (!doc) return;
    $("#docFrame").srcdoc = docSrcdoc(sanitizeDocHTML(doc.html), doc.css || "");
  }

  // iframe 내부에서 실행될 스크립트(부모 스코프 참조 금지). 토큰→빈칸 변환·탭 공개·편집·높이 보고.
  function docFrameScript() {
    var C = document.getElementById("__c");
    var TOKEN = /\{\{c\d+::([\s\S]*?)\}\}/g;
    var editing = false, revealed = false;
    function tokenize() {
      var w = document.createTreeWalker(C, NodeFilter.SHOW_TEXT, null), t, arr = [];
      while ((t = w.nextNode())) { TOKEN.lastIndex = 0; if (TOKEN.test(t.nodeValue)) arr.push(t); }
      arr.forEach(function (tn) {
        var s = tn.nodeValue, f = document.createDocumentFragment(), last = 0, m; TOKEN.lastIndex = 0;
        while ((m = TOKEN.exec(s))) {
          if (m.index > last) f.appendChild(document.createTextNode(s.slice(last, m.index)));
          var sp = document.createElement("span"); sp.className = "dblank"; sp.setAttribute("data-a", m[1]); sp.textContent = m[1];
          f.appendChild(sp); last = m.index + m[0].length;
        }
        if (last < s.length) f.appendChild(document.createTextNode(s.slice(last)));
        tn.parentNode.replaceChild(f, tn);
      });
    }
    function wrapWords() {
      var w = document.createTreeWalker(C, NodeFilter.SHOW_TEXT, null), t, arr = [];
      while ((t = w.nextNode())) { if (t.parentElement && t.parentElement.closest(".dblank")) continue; if (t.nodeValue.trim()) arr.push(t); }
      arr.forEach(function (tn) {
        var f = document.createDocumentFragment();
        tn.nodeValue.split(/(\s+)/).forEach(function (p) {
          if (!p) return;
          if (/^\s+$/.test(p)) f.appendChild(document.createTextNode(p));
          else { var s = document.createElement("span"); s.className = "dword"; s.textContent = p; f.appendChild(s); }
        });
        tn.parentNode.replaceChild(f, tn);
      });
    }
    function unwrapWords() {
      C.querySelectorAll(".dword").forEach(function (x) { x.replaceWith(document.createTextNode(x.textContent)); });
      C.normalize();
    }
    function applyReveal() { C.querySelectorAll(".dblank").forEach(function (b) { b.classList.toggle("shown", revealed); }); }
    function serialize() {
      var clone = C.cloneNode(true);
      clone.querySelectorAll(".dblank").forEach(function (b) { b.replaceWith(document.createTextNode("{{c1::" + b.getAttribute("data-a") + "}}")); });
      clone.querySelectorAll(".dword").forEach(function (w) { w.replaceWith(document.createTextNode(w.textContent)); });
      return clone.innerHTML;
    }
    function save() { parent.postMessage({ __pdoc: 1, t: "save", html: serialize() }, "*"); }
    function height() { parent.postMessage({ __pdoc: 1, t: "h", h: document.documentElement.scrollHeight }, "*"); }
    // 문서 자체 스크립트는 보안상 제거되므로, 흔한 탭↔섹션 전환 패턴을 리더가 대신 처리한다.
    // (data-t / data-tab / data-target / data-section / data-view / href="#id" → 같은 id의 요소를 .active 토글)
    function tabTarget(el) {
      var v = el.getAttribute("data-t") || el.getAttribute("data-tab") || el.getAttribute("data-target") ||
              el.getAttribute("data-section") || el.getAttribute("data-view");
      if (!v && el.getAttribute("href") && el.getAttribute("href").charAt(0) === "#") v = el.getAttribute("href").slice(1);
      if (!v) return null;
      return document.getElementById(v.replace(/^#/, ""));
    }
    function wireTabs() {
      var trigs = [].slice.call(C.querySelectorAll("[data-t],[data-tab],[data-target],[data-section],[data-view],a[href^='#']"));
      var groups = []; // {nav, trigs:[], targets:[]}
      trigs.forEach(function (tr) {
        var tgt = tabTarget(tr); if (!tgt) return;
        var nav = tr.closest("nav") || tr.parentElement;
        var g = null;
        for (var i = 0; i < groups.length; i++) { if (groups[i].nav === nav) { g = groups[i]; break; } }
        if (!g) { g = { nav: nav, trigs: [], targets: [] }; groups.push(g); }
        g.trigs.push(tr); g.targets.push(tgt);
      });
      groups.forEach(function (g) {
        if (g.trigs.length < 2) return; // 탭 그룹으로 볼 만한 최소 조건
        g.trigs.forEach(function (tr) {
          tr.addEventListener("click", function (e) {
            if (editing) return; // 편집 모드에선 단어 토글이 우선
            e.preventDefault();
            g.trigs.forEach(function (x) { x.classList.remove("active"); });
            g.targets.forEach(function (x) { x.classList.remove("active"); });
            tr.classList.add("active");
            var tgt = tabTarget(tr); if (tgt) tgt.classList.add("active");
            revealed = false; applyReveal();
            setTimeout(height, 0); setTimeout(height, 220);
          });
        });
      });
    }
    // 공백만 있는 텍스트 노드는 건너뛰고, 지정한 방향의 바로 이웃 빈칸을 찾는다.
    function neighborBlank(node, dir) {
      var n = node[dir];
      while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n[dir];
      return (n && n.nodeType === 1 && n.classList.contains("dblank")) ? n : null;
    }
    function makeBlank(text) {
      var s = document.createElement("span"); s.className = "dblank";
      s.setAttribute("data-a", text); s.textContent = text; return s;
    }
    // 단어를 빈칸으로. 양옆에 이미 빈칸이 있으면 한 덩어리로 이어 묶는다(띄어쓰기로 연결된 단어들).
    function blankWord(word) {
      var prevB = neighborBlank(word, "previousSibling");
      var nextB = neighborBlank(word, "nextSibling");
      var left = prevB || word, right = nextB || word;
      // 같은 부모(같은 줄 흐름) 안에서만 병합 — 블록 경계를 넘지 않게
      if (left.parentNode !== right.parentNode) { left = word; right = word; }
      var range = document.createRange();
      range.setStartBefore(left); range.setEndAfter(right);
      var text = range.toString().replace(/\s+/g, " ").trim();
      range.deleteContents();
      range.insertNode(makeBlank(text));
      save();
    }
    // 빈칸을 다시 단어들로 풀기(덩어리면 공백 기준으로 여러 단어로 되돌림).
    function unblank(blank) {
      var parts = (blank.getAttribute("data-a") || "").split(/(\s+)/);
      var f = document.createDocumentFragment();
      parts.forEach(function (p) {
        if (!p) return;
        if (/^\s+$/.test(p)) f.appendChild(document.createTextNode(p));
        else { var s = document.createElement("span"); s.className = "dword"; s.textContent = p; f.appendChild(s); }
      });
      blank.replaceWith(f); save();
    }
    C.addEventListener("click", function (e) {
      var blank = e.target.closest(".dblank");
      if (editing) {
        var word = e.target.closest(".dword");
        if (blank) unblank(blank);
        else if (word) blankWord(word);
      } else if (blank) { blank.classList.toggle("shown"); }
    });
    window.addEventListener("message", function (e) {
      var d = e.data || {};
      if (d.t === "reveal") { revealed = !!d.on; applyReveal(); }
      else if (d.t === "edit") {
        editing = !!d.on; C.classList.toggle("editing", editing);
        if (editing) wrapWords(); else { unwrapWords(); revealed = false; applyReveal(); }
        setTimeout(height, 0);
      }
    });
    tokenize();
    wireTabs();
    window.addEventListener("load", height);
    setTimeout(height, 60); setTimeout(height, 400);
    if (window.ResizeObserver) new ResizeObserver(height).observe(document.documentElement);
  }

  const DOC_BLANK_CSS =
    "#__c .dblank{color:transparent!important;background:#cfccc6;border-radius:4px;padding:0 3px;cursor:pointer}" +
    "#__c .dblank.shown{color:#5b6b33!important;background:#e7f0cf;font-weight:600}" +
    "#__c.editing .dblank{color:#5b6b33!important;background:#dfe9c8}" +
    "#__c.editing .dword{cursor:pointer;border-radius:3px}" +
    "#__c.editing .dword:hover{background:#eef3dd}";

  function docSrcdoc(bodyHtml, css) {
    const hasCss = !!String(css || "").trim();
    // 자체 스타일이 있는 문서는 원본 레이아웃(중앙정렬·폭)에 맡기고,
    // 자체 스타일이 없는 일반 문서만 가독성을 위해 본문 폭을 제한한다.
    const baseWrap = hasCss ? "" : "#__c{max-width:760px;margin:0 auto}";
    return "<!doctype html><html><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<style>html,body{margin:0}body{padding:16px;font:15px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2b2b26;word-break:break-word}img{max-width:100%}" + baseWrap + "</style>" +
      "<style>" + String(css || "") + "</style>" +
      "<style>" + DOC_BLANK_CSS + "</style>" +
      "</head><body><div id='__c'>" + bodyHtml + "</div>" +
      "<script>(" + docFrameScript.toString() + ")()<\/script></body></html>";
  }

  // iframe → 부모 메시지: 높이 조정 / 편집 저장 (샌드박스 iframe은 opaque origin이라 source 비교 대신 마커로 식별)
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__pdoc !== 1) return;
    const frame = $("#docFrame");
    if (!frame) return;
    if (d.t === "h" && d.h) frame.style.height = (d.h + 6) + "px";
    else if (d.t === "save" && curDocId) Store.updateDoc(curDocId, { html: renumberDoc(String(d.html || "")) });
  });

  function syncDocButtons() {
    $("#btnDocReveal").textContent = docRevealed ? t("docs.hideAll") : t("docs.revealAll");
    $("#btnDocEdit").textContent = docEditing ? t("docs.editDone") : t("docs.edit");
    $("#btnDocEdit").classList.toggle("on", docEditing);
    $("#docEditHint").classList.toggle("hidden", !docEditing);
  }

  function postToFrame(msg) {
    const w = $("#docFrame").contentWindow;
    if (w) w.postMessage(msg, "*");
  }
  $("#btnDocReveal").addEventListener("click", () => { docRevealed = !docRevealed; postToFrame({ t: "reveal", on: docRevealed }); syncDocButtons(); });
  $("#btnDocEdit").addEventListener("click", () => {
    docEditing = !docEditing;
    if (!docEditing) docRevealed = false;
    postToFrame({ t: "edit", on: docEditing });
    syncDocButtons();
  });
  $("#btnDocDelete").addEventListener("click", () => {
    const doc = Store.getDoc(curDocId);
    if (!doc) return;
    confirmDialog(t("confirm.deleteDoc"), t("confirm.deleteDocText"), () => {
      Store.deleteDoc(curDocId);
      toast(t("toast.docDeleted"));
      show("docs");
    });
  });

  /* ── 문서 만들기/원문 편집 모달 ── */
  const docModal = $("#docModal");
  function openDocModal(id) {
    docModalMode = id ? "edit" : "new";
    docModalId = id || null;
    const doc = id ? Store.getDoc(id) : null;
    $("#docModalTitle").textContent = t(id ? "docModal.edit" : "docModal.new");
    $("#docSave").textContent = t(id ? "docs.save" : "docs.create");
    $("#docNameInput").value = doc ? doc.name : "";
    $("#docTextInput").value = doc ? doc.html : "";
    // 과목: 기존 과목들을 datalist로 제안, 새 문서면 현재 필터 중인 과목을 기본값으로
    $("#docSubjectList").innerHTML = docSubjects().map(s => `<option value="${escapeHTML(s)}"></option>`).join("");
    const preset = curDocSubject && curDocSubject !== NO_SUBJECT ? curDocSubject : "";
    $("#docSubjectInput").value = doc ? (doc.subject || "") : preset;
    $("#docModal").showModal();
  }
  $("#btnNewDoc").addEventListener("click", () => openDocModal());
  $("#btnDocRename").addEventListener("click", () => openDocModal(curDocId));
  $("#docPickFile").addEventListener("click", () => $("#docFileInput").click());
  $("#docFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      $("#docTextInput").value = await file.text();
      if (!$("#docNameInput").value.trim()) $("#docNameInput").value = file.name.replace(/\.(html?|txt)$/i, "");
    } catch { toast(t("imp.fail")); }
  });
  $("#docSave").addEventListener("click", () => {
    const name = $("#docNameInput").value.trim() || t("docs.untitled");
    const subject = $("#docSubjectInput").value.trim();
    const raw = $("#docTextInput").value;
    if (!raw.trim()) return;
    if (docModalMode === "edit" && docModalId) {
      // 원문 편집: 사용자가 넣은 토큰을 존중(자동 강조 변환 없음)
      const { html, css } = buildDocHtml(raw, false);
      Store.updateDoc(docModalId, { name, subject, html, ...(css ? { css } : {}) }); // 새 스타일이 없으면 기존 css 유지
      docModal.close();
      if (curDocId === docModalId) { docRevealed = false; docEditing = false; $("#docReaderTitle").textContent = name; renderDocFrame(); syncDocButtons(); }
      toast(t("toast.docSaved"));
    } else {
      const { html, css } = buildDocHtml(raw, true);
      const doc = Store.addDoc(name, html, css, subject);
      docModal.close();
      toast(t("toast.docSaved"));
      openDocReader(doc.id);
    }
  });

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

  // 루트→현재 폴더까지의 조상 경로(빵부스러기)
  function folderTrail(id) {
    const trail = [];
    const seen = new Set();
    let cur = Store.getFolder(id);
    while (cur && !seen.has(cur.id)) { trail.unshift(cur); seen.add(cur.id); cur = cur.parentId ? Store.getFolder(cur.parentId) : null; }
    return trail;
  }
  // 해당 폴더 + 모든 하위 폴더에 속한 덱(집계용)
  function folderDecks(folderId) {
    const ids = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of Store.state.folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
      }
    }
    return Store.state.decks.filter(d => d.folderId && ids.has(d.folderId));
  }
  const crumbSep = `<svg class="fcrumb-sep" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;

  function renderFolderBar() {
    const bar = $("#folderBar");
    if (currentFolder && currentFolder !== STARRED && !Store.getFolder(currentFolder)) currentFolder = null;
    const anyStarred = Store.state.decks.some(d => d.starred);
    if (currentFolder === STARRED && !anyStarred) currentFolder = null;

    // 개요(최상위)에서는 바를 비운다 — 폴더는 카드로 보여주고 '+폴더'도 카드로.
    if (!currentFolder) { bar.innerHTML = ""; return; }

    // '전체'로 돌아가는 루트 칩(화살표)
    let html = `
      <button class="fchip back" data-nav="">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        <span>${t("folder.all")}</span>
      </button>`;

    if (currentFolder === STARRED) {
      html += crumbSep + `<span class="fchip current star"><svg width="13" height="13"><use href="#i-star"/></svg><span>${t("folder.starred")}</span></span>`;
    } else {
      const trail = folderTrail(currentFolder);
      trail.forEach((f, idx) => {
        const last = idx === trail.length - 1;
        html += crumbSep;
        html += last
          ? `<span class="fchip current folder" style="--fc:${f.color}"><svg width="13" height="13"><use href="#${f.icon}"/></svg><span>${escapeHTML(f.name)}</span><i class="fchip-edit" title="${t("folder.titleEdit")}">✎</i></span>`
          : `<button class="fchip crumb" data-nav="${f.id}" style="--fc:${f.color}"><svg width="13" height="13"><use href="#${f.icon}"/></svg><span>${escapeHTML(f.name)}</span></button>`;
      });
    }
    bar.innerHTML = html;
    bar.querySelectorAll("[data-nav]").forEach(el =>
      el.addEventListener("click", () => { currentFolder = el.dataset.nav || null; renderHome(); window.scrollTo({ top: 0 }); }));
    bar.querySelector(".fchip-edit")?.addEventListener("click", () => openFolderModal(currentFolder));
  }

  function openFolderModal(folderId, presetParent) {
    editingFolderId = folderId;
    const folder = folderId ? Store.getFolder(folderId) : null;
    $("#folderModalTitle").textContent = folder ? t("folder.titleEdit") : t("folder.titleNew");
    $("#folderNameInput").value = folder ? folder.name : "";
    pickedIcon = folder?.icon || FOLDER_ICONS[0];
    pickedColor = folder?.color || FOLDER_COLORS[0];
    $("#folderDelete").classList.toggle("hidden", !folder);
    renderFolderParentSelect(folder, folder ? (folder.parentId || "") : (presetParent || ""));
    renderFolderPickers();
    $("#folderModal").showModal();
  }

  // 상위 폴더 선택 — 자기 자신과 자기 하위 폴더는 선택 불가(순환 방지)
  function renderFolderParentSelect(editing, selected) {
    const sel = $("#folderParentSelect");
    const opts = [`<option value="">${t("folder.parentNone")}</option>`];
    foldersInTreeOrder().forEach(({ f, depth }) => {
      if (editing && (f.id === editing.id || Store.isDescendantFolder(f.id, editing.id))) return;
      const pad = "　".repeat(depth); // 전각 공백으로 들여쓰기
      opts.push(`<option value="${f.id}" ${f.id === selected ? "selected" : ""}>${pad}${escapeHTML(f.name)}</option>`);
    });
    sel.innerHTML = opts.join("");
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
    const parentId = $("#folderParentSelect").value || null;
    if (editingFolderId) {
      Store.updateFolder(editingFolderId, { name, icon: pickedIcon, color: pickedColor, parentId });
    } else {
      const f = Store.addFolder(name, pickedIcon, pickedColor, parentId);
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
  // 덱 커버 타일 색: 폴더 없는 덱에 id 기반으로 안정적인 파스텔 톤을 배정 (앱 팔레트 계열)
  const COVER_TINTS = ["#c97f97", "#b06a82", "#8d9663", "#6d7548", "#b9975a", "#c27d4f"];
  function coverTint(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COVER_TINTS[h % COVER_TINTS.length];
  }

  // 덱 정렬: 별표 먼저, 그다음 이름 자연 정렬(숫자 인식) → "1 · 2 · 3 · 10 · 13"
  // 로마 숫자(I, II … IX, X, XI)까지 자연스럽게 정렬 — localeCompare의 numeric은
  // 아라비아 숫자만 다뤄서, "Splanchnology I/II/…/IX/X" 같은 로마 숫자 번호가 뒤섞인다.
  // 대문자 로마 숫자 토큰을 숫자 값으로 바꿔 정렬 키를 만든다.
  const ROMAN_RE = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
  function romanToInt(s) {
    const m = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0, prev = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      const v = m[s[i]]; if (v < prev) n -= v; else { n += v; prev = v; }
    }
    return n;
  }
  function nameSortKey(name) {
    return (name || "").split(/(\s+)/).map(tok =>
      tok && tok === tok.toUpperCase() && ROMAN_RE.test(tok)
        ? "\u0001" + String(romanToInt(tok)).padStart(6, "0")
        : tok
    ).join("");
  }
  function nameCompare(a, b) {
    return nameSortKey(a).localeCompare(nameSortKey(b), undefined, { numeric: true, sensitivity: "base" });
  }
  function sortDecks(arr) {
    return arr.slice().sort((a, b) =>
      (b.starred ? 1 : 0) - (a.starred ? 1 : 0) ||
      nameCompare(a.name, b.name));
  }
  // 여러 덱의 복습·새 카드·전체 수를 합산
  function aggCounts(list) {
    let due = 0, neu = 0, total = 0;
    for (const d of list) { const c = Store.deckCounts(d.id); due += c.due; neu += c.neu; total += c.total; }
    return { due, neu, total };
  }
  function countPill(due, neu, total) {
    return due ? `<span class="pill due">${t("pill.due", { n: due })}</span>`
      : neu ? `<span class="pill new">${t("pill.new", { n: neu })}</span>`
        : total ? `<span class="pill calm">${t("pill.rest")}</span>` : "";
  }

  function deckCardHTML(deck, i) {
    const c = Store.deckCounts(deck.id);
    const learned = c.total ? Math.round(((c.total - c.neu) / c.total) * 100) : 0;
    const folder = deck.folderId ? Store.getFolder(deck.folderId) : null;
    const picked = selectedDecks.has(deck.id);
    const cv = folder ? folder.color : coverTint(deck.id);
    // 커버 타일 라벨: 이름 앞 숫자(1, 13…)가 있으면 그 번호, 없으면 첫 글자
    const nm = deck.name.match(/^\s*(\d+)/);
    const coverLabel = nm ? nm[1] : (deck.name.trim()[0] || "·");
    const primary = countPill(c.due, c.neu, c.total);
    const secondary = (c.due && c.neu)
      ? `${t("pill.new", { n: c.neu })} · ${t("pill.total", { n: c.total })}`
      : t("pill.total", { n: c.total });
    return `
      <article class="deck-card ${selectMode ? "select-mode" : ""} ${picked ? "picked" : ""}" data-deck="${deck.id}" tabindex="0" role="button" style="--i:${i}; --accent:${cv}">
        ${selectMode ? `
        <span class="deck-check ${picked ? "on" : ""}" data-pick="${deck.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>` : ""}
        <span class="deck-cover">${escapeHTML(coverLabel)}</span>
        <div class="deck-main">
          <div class="deck-row-head">
            <h3>${escapeHTML(deck.name)}</h3>
            ${deck.sharedId ? `<span class="shared-tag">${deck.visibility === "friends" ? t("share.publishedFriends") : t("share.published")}</span>` : ""}
          </div>
          ${deck.desc ? `<p class="deck-card-desc">${escapeHTML(deck.desc)}</p>` : ""}
          <div class="deck-progress">
            <div class="deck-progress-bar"><i style="width:${learned}%"></i></div>
            <span class="deck-total">${secondary}</span>
          </div>
        </div>
        <div class="deck-card-meta">${primary}</div>
        ${selectMode ? "" : `
        <button class="deck-star ${deck.starred ? "on" : ""}" data-star="${deck.id}"
          title="${t("deck.star")}" aria-label="${t("deck.star")}">
          <svg width="16" height="16"><use href="#i-star"/></svg>
        </button>
        <svg class="deck-chevron" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`}
      </article>`;
  }

  function folderCardHTML(folder, i) {
    const decks = folderDecks(folder.id); // 하위 폴더 포함 집계
    const c = aggCounts(decks);
    const subs = Store.childFolders(folder.id).length;
    const desc = subs
      ? `${t("folder.subCount", { n: subs })} · ${t("folder.deckCount", { n: decks.length })}`
      : t("folder.deckCount", { n: decks.length });
    return `
      <article class="folder-card" data-folderopen="${folder.id}" tabindex="0" role="button" style="--i:${i}; --accent:${folder.color}">
        <span class="deck-cover folder"><svg width="20" height="20"><use href="#${folder.icon}"/></svg></span>
        <div class="deck-main">
          <div class="deck-row-head"><h3>${escapeHTML(folder.name)}</h3></div>
          <p class="deck-card-desc">${desc}</p>
        </div>
        <div class="deck-card-meta">${countPill(c.due, c.neu, c.total)}</div>
        <svg class="deck-chevron" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </article>`;
  }

  function starredCardHTML(i) {
    const decks = Store.state.decks.filter(d => d.starred);
    const c = aggCounts(decks);
    return `
      <article class="folder-card starred" data-folderopen="${STARRED}" tabindex="0" role="button" style="--i:${i}; --accent:#e3a92e">
        <span class="deck-cover folder"><svg width="18" height="18"><use href="#i-star"/></svg></span>
        <div class="deck-main">
          <div class="deck-row-head"><h3>${t("folder.starred")}</h3></div>
          <p class="deck-card-desc">${t("folder.deckCount", { n: decks.length })}</p>
        </div>
        <div class="deck-card-meta">${countPill(c.due, c.neu, 0)}</div>
        <svg class="deck-chevron" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </article>`;
  }

  function addFolderCardHTML(parentId) {
    const sub = !!parentId;
    return `
      <button class="folder-card add" data-addfolder="${parentId || ""}" type="button">
        <span class="deck-cover add"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>
        <div class="deck-main">
          <div class="deck-row-head"><h3>${sub ? t("folder.addSub") : t("folder.addCard")}</h3></div>
          <p class="deck-card-desc">${sub ? t("folder.addSubHint") : t("folder.addHint")}</p>
        </div>
      </button>`;
  }

  function wireDeckCards(grid) {
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
          renderHome();      // 별표 보기에서 해제 → 목록에서 빠져야 하니 이때만 재렌더
        } else if (currentFolder) {
          renderFolderBar(); // 폴더 안: 상단 칩만 갱신(그리드·스크롤 그대로)
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
  }

  function wireFolderCards(grid) {
    grid.querySelectorAll(".folder-card[data-folderopen]").forEach(el => {
      const open = () => { currentFolder = el.dataset.folderopen; renderHome(); window.scrollTo({ top: 0 }); };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); open(); }
      });
    });
    grid.querySelectorAll("[data-addfolder]").forEach(el =>
      el.addEventListener("click", () => openFolderModal(null, el.dataset.addfolder || null)));
  }

  // 폴더 이름 자연 정렬
  function sortFolders(arr) {
    return arr.slice().sort((a, b) => nameCompare(a.name, b.name));
  }
  // 트리 순서(부모→자식)로 펼친 폴더 목록 [{f, depth}]
  function foldersInTreeOrder() {
    const out = [];
    const walk = (parentId, depth) => {
      sortFolders(Store.childFolders(parentId)).forEach(f => { out.push({ f, depth }); walk(f.id, depth + 1); });
    };
    walk(null, 0);
    return out;
  }

  /* ══════════ 토끼 마스코트 ══════════ */
  const BUNNY_OUTFITS = ["oatmeal", "sage-knit", "rose", "corduroy", "navy", "doctor"];
  const BUNNY_FACES = ["ivory", "cream", "caramel", "cocoa", "grey", "charcoal"];
  const BUNNY_SPECIAL = ["skeleton"]; // 코스튬이 아닌 특별 토끼(해골 등)
  const BUNNY_DEFAULT = "oatmeal-ivory";
  const bunnyValid = v => typeof v === "string" && (BUNNY_SPECIAL.includes(v) || /^[a-z]+(?:-[a-z]+)?-(?:ivory|cream|caramel|cocoa|grey|charcoal)$/.test(v));
  function bunnyVariant() {
    const v = Store.settings && Store.settings.bunny;
    return bunnyValid(v) ? v : BUNNY_DEFAULT;
  }
  const bunnyURL = v => `assets/bunnies/bunny-${v}-sheet.png`;
  const bunnySitURL = v => `assets/bunnies/bunny-${v}-sit-sheet.png`;
  // 모든 변형(코스튬 36종 + 해골)에 앉은 시트가 있음.
  const bunnyHasSit = v => bunnyValid(v);
  function applyBunnies() {
    const url = `url('${bunnyURL(bunnyVariant())}')`;
    document.querySelectorAll(".bunny-sprite.js-bunny").forEach(el => { el.style.backgroundImage = url; });
    updateCardBunny();
  }
  function setBunnyVariant(v) {
    if (!bunnyValid(v)) return;
    Store.setSetting("bunny", v);
    applyBunnies();
    renderBunnyPicker();
    try { Social.refreshRoomMeta(); } catch { /* 룸에 새 토끼 반영 */ }
  }
  function renderBunnyPicker() {
    const host = $("#bunnyPicker");
    if (!host) return;
    const cur = bunnyVariant();
    const opt = v => `<button type="button" class="bunny-opt ${v === cur ? "active" : ""}" data-bunny="${v}" title="${v}">`
      + `<span class="bunny-sprite static" style="background-image:url('${bunnyURL(v)}')"></span></button>`;
    let html = "";
    for (const o of BUNNY_OUTFITS) for (const f of BUNNY_FACES) html += opt(`${o}-${f}`);
    for (const v of BUNNY_SPECIAL) html += opt(v); // 특별 토끼(해골)를 맨 뒤에
    host.innerHTML = html;
  }

  /* ══════════ Bunny Café 포커스 독 (전역 iframe 1개) ══════════ */
  let cafeFrame = null;          // iframe (지연 생성)
  let cafeState = "collapsed";   // collapsed | mini | room
  // 마스코트 변형(outfit-face) → 카페 파라미터(옷·색)
  const CAFE_OUT = { oatmeal: "Oatmeal", "sage-knit": "Sage knit", rose: "Rose", corduroy: "Corduroy", navy: "Navy", doctor: "Doctor" };
  function variantToCafe(v) {
    let fur = "ivory", outfit = "Sage knit";
    const m = String(v || "").match(/^(.*)-(ivory|cream|caramel|cocoa|grey|charcoal)$/);
    if (m && CAFE_OUT[m[1]]) { outfit = CAFE_OUT[m[1]]; fur = m[2]; }
    return { fur, outfit };
  }
  function cafeSrc() {
    const { fur, outfit } = variantToCafe(bunnyVariant());
    return `cafe.html?${new URLSearchParams({ fur, outfit, seat: "5" })}`;
  }
  // 지금 공부 중인 친구(나 제외)를 카페 자리에 앉히도록 iframe에 전달
  function syncCafeFriends() {
    if (!cafeFrame || !cafeFrame.contentWindow) return;
    const meId = Social.profile && Social.profile.id;
    const friends = (roomUsers || [])
      .filter(u => u && u.studying && u.id !== meId)
      .slice(0, 5)
      .map(u => {
        const c = variantToCafe(bunnyValid(u.bunny) ? u.bunny : BUNNY_DEFAULT);
        c.name = String(u.username || "").slice(0, 12);
        return c;
      });
    const meName = (Social.profile && Social.profile.username) || "";
    try { cafeFrame.contentWindow.postMessage({ type: "petale-cafe", friends, meName }, location.origin); } catch { /* 베스트에포트 */ }
  }
  function ensureCafeFrame() {
    if (cafeFrame) return;
    cafeFrame = document.createElement("iframe");
    cafeFrame.src = cafeSrc();
    cafeFrame.title = "Bunny Café";
    cafeFrame.allow = "autoplay";
    cafeFrame.addEventListener("load", syncCafeFriends); // 로드 후 현재 친구 전달
    $("#cafeFrameWrap").appendChild(cafeFrame);
  }
  function layoutCafe() {
    const dock = $("#cafeDock");
    if (!dock) return;
    if (cafeState === "room") {
      const slot = $("#cafeSlot");
      if (slot) {
        const r = slot.getBoundingClientRect();
        dock.style.left = `${Math.round(r.left)}px`;
        dock.style.top = `${Math.round(r.top)}px`;
        dock.style.width = `${Math.round(r.width)}px`;
        dock.style.height = `${Math.round(r.height)}px`;
        dock.style.right = "auto"; dock.style.bottom = "auto";
      }
    } else {
      dock.style.left = dock.style.top = dock.style.width = dock.style.height = "";
      dock.style.right = dock.style.bottom = "";
    }
  }
  function setCafeState(s) {
    cafeState = s;
    if (s !== "collapsed") ensureCafeFrame();
    const dock = $("#cafeDock");
    if (dock) dock.className = `cafe-dock ${s}`;
    layoutCafe();
    if (s === "room") requestAnimationFrame(layoutCafe); // 렌더 후 재측정
  }
  (function bindCafe() {
    const bar = $("#cafeBar"), min = $("#cafeMin");
    if (bar) bar.addEventListener("click", () => setCafeState("mini"));
    if (min) min.addEventListener("click", () => setCafeState("collapsed"));
    window.addEventListener("resize", layoutCafe);
    window.addEventListener("scroll", () => { if (cafeState === "room") layoutCafe(); }, { passive: true });
  })();
  // 홈 마스코트 말풍선 — 남은 복습량에 맞춘 멘트(누르면 랜덤으로 바뀜)
  // 오늘의 학습 목표(남은 수) — 복습(예정된 복습) + 새 학습(플랜 페이스)
  function todayGoal(now = Date.now()) {
    const plans = Store.state.plans || [];
    if (plans.length) {
      let reviews = 0, neu = 0;
      plans.forEach(p => { const s = Store.planStats(p, now); reviews += s.dueToday; neu += s.todayNew; });
      return { reviews, neu, total: reviews + neu, hasPlan: true };
    }
    // 플랜이 없으면 '예정된 복습'만 목표로 삼는다(새 카드는 페이스가 없어 전부 쌓이지 않게)
    const reviews = Store.state.cards.filter(c => !c.suspended && (c.views || 0) > 0 && c.due <= now).length;
    return { reviews, neu: 0, total: reviews, hasPlan: false };
  }
  function setBunnyBubble(cycle) {
    const el = $("#bunnyBubble");
    if (!el) return;
    const g = todayGoal();
    // 오늘 목표 or 응원을 말풍선에 (누르면 바뀜). 토끼 아래엔 따로 표시 안 함.
    const pool = g.total > 0
      ? [t("bunny.goalLeft", { n: g.total }), t("bunny.cheer"), t("bunny.lets")]
      : [t("bunny.done"), t("bunny.proud"), t("bunny.rest")];
    el.textContent = pool[cycle ? Math.floor(Math.random() * pool.length) : 0];
  }
  $("#bunnyPicker")?.addEventListener("click", (e) => {
    const b = e.target.closest(".bunny-opt");
    if (b) setBunnyVariant(b.dataset.bunny);
  });
  $("#homeBunny")?.addEventListener("click", () => setBunnyBubble(true));
  applyBunnies(); // 초기화 시 게이트(로딩/로그인) 등 정적 마스코트에 현재 토끼 적용

  /* ══════════ 스터디룸 (실시간 접속 토끼) ══════════ */
  let roomUsers = [];
  Social.setOnRoomState((users) => {
    roomUsers = Array.isArray(users) ? users : [];
    if (!$("#view-room").classList.contains("hidden")) renderRoom();
    syncCafeFriends(); // 카페에도 지금 공부 중인 친구 반영
  });
  $("#roomSignin")?.querySelector("button")?.addEventListener("click", () => show("friends"));
  function renderRoom() {
    const signedIn = Social.roomReady && Social.roomReady();
    $("#roomSignin").classList.toggle("hidden", !!signedIn);
    $("#roomFloor").classList.toggle("hidden", !signedIn);
    if (!signedIn) { $("#roomSummary").textContent = ""; $("#roomFloor").innerHTML = ""; return; }
    const me = Social.profile && Social.profile.id;
    const users = (roomUsers || []).slice().sort((a, b) =>
      ((b.studying ? 1 : 0) - (a.studying ? 1 : 0)) || ((a.since || 0) - (b.since || 0)));
    const studyingN = users.filter(u => u.studying).length;
    $("#roomSummary").textContent = studyingN > 0
      ? t("room.studyingN", { n: studyingN })
      : t("room.onlineN", { n: users.length });
    if (!users.length) { $("#roomFloor").innerHTML = `<div class="room-empty">${t("room.empty")}</div>`; return; }
    $("#roomFloor").innerHTML = users.map(u => {
      const v = bunnyValid(u.bunny) ? u.bunny : BUNNY_DEFAULT;
      const isMe = me && u.id === me;
      const name = isMe ? t("room.you") : escapeHTML(String(u.username || "익명").slice(0, 20));
      return `<div class="room-bunny ${u.studying ? "studying" : "idle"} ${isMe ? "me" : ""}">
        <span class="bunny-sprite ${u.studying ? "" : "static"}" style="background-image:url('${bunnyURL(v)}')"></span>
        <span class="room-name">${name}</span>
        <span class="room-status">${u.studying ? t("room.studying") : t("room.online")}</span>
      </div>`;
    }).join("");
  }

  /* ══════════ 학습 플랜 (마감/자동 분배) ══════════ */
  let editingPlanId = null;
  const planDateVal = (ts) => { const d = new Date(ts); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  function ddayLabel(daysLeft) {
    if (daysLeft == null) return "";
    if (daysLeft > 0) return "D-" + daysLeft;
    if (daysLeft === 0) return "D-DAY";
    return "D+" + (-daysLeft);
  }
  function planNewCount(deckId) { return Store.cardsOf(deckId).filter(c => !c.suspended && (c.views || 0) === 0).length; }
  function planFocusDeck(plan) {
    let best = null, bestNew = -1;
    for (const id of plan.deckIds || []) { const n = planNewCount(id); if (n > bestNew) { bestNew = n; best = id; } }
    return best ? Store.getDeck(best) : null;
  }
  // 오늘 할 일: 복습 R · 새 N 로 분리 표기 (0이면 완료)
  function planTodayLabel(s) {
    if (s.todayTotal <= 0) return t("plan.todayDone");
    const parts = [];
    if (s.dueToday) parts.push(t("plan.splitReview", { n: s.dueToday }));
    if (s.todayNew) parts.push(t("plan.splitNew", { n: s.todayNew }));
    return parts.join(" · ");
  }

  function renderPlanSection() {
    const host = $("#planSection");
    if (!host) return;
    const plans = Store.state.plans || [];
    const addBtn = `<button class="btn ghost sm plan-add" id="btnAddPlan">+ <span>${t("plan.add")}</span></button>`;
    if (!plans.length) {
      host.innerHTML = `<div class="plan-head"><h3>${t("plan.title")}</h3>${addBtn}</div>`
        + `<p class="plan-empty">${t("plan.empty")}</p>`;
      $("#btnAddPlan")?.addEventListener("click", () => openPlanModal(null));
      return;
    }
    const now = Date.now();
    const ddayCls = d => d == null ? "" : d < 0 ? "past" : d <= 3 ? "soon" : d <= 7 ? "near" : "";
    const rows = plans.map(p => ({ p, s: Store.planStats(p, now) }))
      .sort((a, b) => ((a.s.daysLeft == null ? 1e9 : a.s.daysLeft) - (b.s.daysLeft == null ? 1e9 : b.s.daysLeft)));
    const active = rows.filter(x => !x.p.completed);
    const focus = active.find(x => (x.s.daysLeft == null || x.s.daysLeft >= 0) && x.s.todayTotal > 0) || active[0] || null;

    const fmtDate = ts => new Intl.DateTimeFormat(I18N.lang === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" }).format(new Date(ts));
    const taskLine = s => {
      if (s.todayTotal <= 0) return t("plan.todayDone");
      const parts = [];
      if (s.dueToday) parts.push(t("plan.splitReview", { n: s.dueToday }));
      if (s.todayNew) parts.push(t("plan.splitNew", { n: s.todayNew }));
      return parts.join(" · ");
    };

    // ── 오늘의 집중 — 담백하게: 이름 · D-day · 얇은 진도선 · 오늘 할 일 · 조용한 버튼 ──
    let hero = "";
    if (focus) {
      const s = focus.s, fd = planFocusDeck(focus.p);
      const pct = Math.round(s.progress * 100);
      const dcls = ddayCls(s.daysLeft);
      const dday = s.daysLeft != null
        ? `<span class="pf-dday ${dcls}">${ddayLabel(s.daysLeft)}<em>${fmtDate(s.examTs)}</em></span>` : "";
      const goLabel = s.todayTotal > 0 ? t("plan.goNowN", { n: s.todayTotal }) : t("plan.studyNow");
      hero = `<div class="plan-focus" data-plan="${focus.p.id}" role="button" tabindex="0">
        <div class="pf-top"><span class="pf-kicker">${t("plan.todayFocus")}</span>${dday}</div>
        <div class="pf-plan">${escapeHTML(focus.p.name)}</div>
        ${fd ? `<div class="pf-deck">${escapeHTML(fd.name)}</div>` : ""}
        <div class="pf-prog"><span class="pf-track"><i style="width:${pct}%"></i></span><span class="pf-pct">${pct}%</span></div>
        <div class="pf-bottom">
          <span class="pf-task">${taskLine(s)}</span>
          <button class="pf-go" data-plan="${focus.p.id}">${goLabel}</button>
        </div>
      </div>`;
    }

    // ── 나머지 플랜 — 조용한 리스트 행 (완료한 플랜은 맨 아래 흐리게) ──
    const others = rows.filter(x => !focus || x.p.id !== focus.p.id)
      .sort((a, b) => (a.p.completed ? 1 : 0) - (b.p.completed ? 1 : 0));
    const list = others.map(({ p, s }) => {
      if (p.completed) {
        return `<li class="plan-row done" data-plan="${p.id}" role="button" tabindex="0">
          <span class="pr-main"><span class="pr-name">${escapeHTML(p.name)}</span><span class="pr-sub">${t("plan.completed")}</span></span>
          <span class="pr-check">✓</span>
        </li>`;
      }
      const pct = Math.round(s.progress * 100);
      const dcls = ddayCls(s.daysLeft);
      return `<li class="plan-row" data-plan="${p.id}" role="button" tabindex="0">
        <span class="pr-main">
          <span class="pr-name">${escapeHTML(p.name)}</span>
          <span class="pr-sub">${taskLine(s)}</span>
        </span>
        <span class="pr-track"><i style="width:${pct}%"></i></span>
        <span class="pr-dday ${dcls}">${ddayLabel(s.daysLeft)}</span>
      </li>`;
    }).join("");
    const grid = list ? `<ul class="plan-list">${list}</ul>` : "";

    host.innerHTML = `<div class="plan-head"><h3>${t("plan.title")}</h3>${addBtn}</div>${hero}${grid}`;
    $("#btnAddPlan")?.addEventListener("click", () => openPlanModal(null));
    const openDetail = el => openPlanDetail(el.dataset.plan);
    host.querySelectorAll(".plan-row, .plan-focus").forEach(el => {
      el.addEventListener("click", () => openDetail(el));
      el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(el); } });
    });
    // '지금 학습' → 바로 카드가 아니라 상세(오늘 할 덱)부터 보여준다
    host.querySelectorAll(".pf-go").forEach(el => el.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlanDetail(el.dataset.plan);
    }));
  }

  // ── 플랜 상세: 끝낸 거 · 남은 거 · 전체 · 오늘 할 덱, 그리고 시작/완료/수정 ──
  let detailPlanId = null;
  function openPlanDetail(planId) {
    const p = Store.getPlan(planId); if (!p) return;
    detailPlanId = planId;
    const now = Date.now();
    const s = Store.planStats(p, now);
    const pct = Math.round(s.progress * 100);
    const fmtDate = ts => new Intl.DateTimeFormat(I18N.lang === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" }).format(new Date(ts));
    $("#pdName").textContent = p.name;
    $("#pdDday").textContent = s.daysLeft != null ? `${ddayLabel(s.daysLeft)} · ${fmtDate(s.examTs)}` : "";
    $("#pdDday").className = "pd-dday " + (s.daysLeft == null ? "" : s.daysLeft < 0 ? "past" : s.daysLeft <= 3 ? "soon" : "");
    $("#pdBar").style.width = pct + "%";
    $("#pdPct").textContent = pct + "%";
    $("#pdStats").innerHTML =
      `<span><b>${s.learned}</b>${t("plan.doneLabel")}</span>` +
      `<span><b>${s.newCards}</b>${t("plan.remainLabel")}</span>` +
      `<span><b>${s.total}</b>${t("plan.totalLabel")}</span>`;
    const perDeck = (p.deckIds || []).map(id => {
      const deck = Store.getDeck(id); if (!deck) return null;
      const cs = Store.state.cards.filter(c => c.deckId === id && !c.suspended);
      const due = cs.filter(c => (c.views || 0) > 0 && c.due <= now).length;
      const neu = cs.filter(c => (c.views || 0) === 0).length;
      return { deck, due, neu };
    }).filter(Boolean);
    const todayDecks = perDeck.filter(x => x.due > 0 || x.neu > 0);
    $("#pdTodayTitle").textContent = t("plan.todayDecks");
    $("#pdDecks").innerHTML = todayDecks.length
      ? todayDecks.map(x => {
        const parts = [];
        if (x.due) parts.push(t("plan.splitReview", { n: x.due }));
        if (x.neu) parts.push(t("plan.splitNew", { n: x.neu }));
        return `<div class="pd-deck"><span class="pdk-name">${escapeHTML(x.deck.name)}</span><span class="pdk-cnt">${parts.join(" · ")}</span></div>`;
      }).join("")
      : `<p class="pd-empty">${t("plan.noTodayDecks")}</p>`;
    $("#pdStart").textContent = s.todayTotal > 0 ? t("plan.goNowN", { n: s.todayTotal }) : t("plan.studyNow");
    $("#pdStart").classList.toggle("hidden", !!p.completed || s.todayTotal <= 0);
    $("#pdComplete").textContent = p.completed ? t("plan.uncomplete") : t("plan.complete");
    $("#planDetailModal").showModal();
  }
  $("#pdStart").addEventListener("click", () => {
    const p = Store.getPlan(detailPlanId);
    $("#planDetailModal").close();
    if (p) startPlanSession(p);
  });
  $("#pdEdit").addEventListener("click", () => {
    const id = detailPlanId;
    $("#planDetailModal").close();
    openPlanModal(id);
  });
  $("#pdComplete").addEventListener("click", () => {
    const p = Store.getPlan(detailPlanId); if (!p) return;
    Store.updatePlan(detailPlanId, { completed: !p.completed });
    if (!p.completed) toast(t("plan.completedToast"));
    $("#planDetailModal").close();
    renderPlanSection();
  });

  function startPlanSession(plan) {
    const now = Date.now();
    const deckSet = new Set(plan.deckIds || []);
    const cards = Store.state.cards.filter(c => deckSet.has(c.deckId) && !c.suspended);
    const due = cards.filter(c => (c.views || 0) > 0 && c.due <= now);
    const st = Store.planStats(plan, now);
    const neu = cards.filter(c => (c.views || 0) === 0).slice(0, st.todayNew);
    const queue = [...due.map(c => c.id), ...neu.map(c => c.id)];
    startSessionWith(queue, { global: true, emptyMsg: t("plan.nothingToday") });
  }

  function renderPlanDeckPick(selected) {
    const host = $("#planDeckPick");
    const decks = sortDecks(Store.state.decks);
    if (!decks.length) { host.innerHTML = `<p class="plan-empty">${t("plan.noDecks")}</p>`; return; }
    const optHTML = d => {
      const n = planNewCount(d.id);
      return `<label class="plan-deck-opt"><input type="checkbox" value="${d.id}" ${selected.has(d.id) ? "checked" : ""}>
        <span>${escapeHTML(d.name)}</span><em>${t("plan.newN", { n })}</em></label>`;
    };
    // 과목(폴더)별로 묶어 접었다 펼 수 있게. 폴더가 전혀 없으면 평평하게.
    const byFolder = new Map();
    for (const d of decks) { const k = d.folderId || ""; (byFolder.get(k) || byFolder.set(k, []).get(k)).push(d); }
    const folders = sortFolders([...byFolder.keys()].filter(Boolean).map(id => Store.getFolder(id)).filter(Boolean));
    if (!folders.length) {
      host.innerHTML = decks.map(optHTML).join("");
      host.querySelectorAll("input").forEach(i => i.addEventListener("change", renderPlanPreview));
      return;
    }
    const chev = `<svg class="pg-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
    const group = (list, name) => {
      const sel = list.filter(d => selected.has(d.id)).length;
      return `<div class="plan-group ${sel ? "open" : ""}">
        <button type="button" class="plan-group-head">${chev}<span class="pg-name">${escapeHTML(name)}</span><span class="pg-count">${sel ? sel + "/" : ""}${list.length}</span></button>
        <div class="plan-group-body">${list.map(optHTML).join("")}</div>
      </div>`;
    };
    const parts = folders.map(f => group(byFolder.get(f.id), f.name));
    if (byFolder.has("")) parts.push(group(byFolder.get(""), t("plan.ungrouped")));
    host.innerHTML = parts.join("");
    host.querySelectorAll(".plan-group-head").forEach(h => h.addEventListener("click", () => h.closest(".plan-group").classList.toggle("open")));
    host.querySelectorAll("input").forEach(i => i.addEventListener("change", renderPlanPreview));
  }
  function planFormDeckIds() { return [...$("#planDeckPick").querySelectorAll("input:checked")].map(i => i.value); }

  function renderPlanPreview() {
    const host = $("#planPreview");
    const date = $("#planDateInput").value;
    const deckIds = planFormDeckIds();
    if (!date || !deckIds.length) { host.innerHTML = ""; return; }
    const dailyNew = Math.max(0, Number($("#planDailyNew").value) || 0);
    const temp = { date, deckIds, dailyNew };
    const s = Store.planStats(temp);
    const tl = Store.planTimeline(temp);
    const max = Math.max(1, ...tl.map(d => d.newCount));
    const fmt = new Intl.DateTimeFormat(I18N.lang === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" });
    const bars = tl.map((d, i) => {
      const h = d.newCount ? Math.max(8, Math.round((d.newCount / max) * 60)) : 2;
      const heavy = d.newCount >= max * 0.8 && d.newCount > 0;
      const lbl = i === 0 ? t("fc.today") : d.isExam ? "🎯" : "";
      return `<div class="tl-col ${i === 0 ? "today" : ""} ${d.isExam ? "exam" : ""} ${heavy ? "heavy" : ""}" title="${fmt.format(new Date(d.ts))} · ${t("plan.newN", { n: d.newCount })}">
        <span class="tl-n">${d.newCount || ""}</span><i class="tl-bar" style="height:${h}px"></i><span class="tl-d">${lbl}</span></div>`;
    }).join("");
    host.innerHTML = `<div class="plan-stat-row">
        <span class="plan-chip">${ddayLabel(s.daysLeft)}</span>
        <span>${t("plan.totalN", { n: s.total })}</span>
        <span>${t("plan.perDayN", { n: s.perDay })}</span>
        <span>${t("plan.todaySplit", { r: s.dueToday, n: s.todayNew })}</span>
      </div>
      <div class="tl-strip">${bars}</div>`;
  }

  function openPlanModal(planId) {
    editingPlanId = planId || null;
    const p = planId ? Store.getPlan(planId) : null;
    $("#planModalTitle").textContent = p ? t("plan.editTitle") : t("plan.newTitle");
    $("#planModalSubmit").textContent = p ? t("plan.save") : t("plan.create");
    $("#planNameInput").value = p ? p.name : "";
    $("#planDateInput").value = p ? p.date : planDateVal(Date.now() + 14 * 86400000);
    $("#planDailyNew").value = p && p.dailyNew ? p.dailyNew : "";
    $("#planDelete").classList.toggle("hidden", !p);
    renderPlanDeckPick(new Set(p ? p.deckIds : []));
    renderPlanPreview();
    $("#planModal").showModal();
  }
  $("#planDateInput").addEventListener("change", renderPlanPreview);
  $("#planDailyNew").addEventListener("input", renderPlanPreview);
  $("#planDelete").addEventListener("click", () => {
    if (!editingPlanId) return;
    confirmDialog(t("plan.deleteTitle"), t("plan.deleteConfirm"), () => {
      Store.deletePlan(editingPlanId);
      $("#planModal").close();
      renderPlanSection();
    });
  });
  $("#planForm").addEventListener("submit", () => {
    const name = $("#planNameInput").value.trim();
    const date = $("#planDateInput").value;
    const deckIds = planFormDeckIds();
    const dailyNew = Math.max(0, Number($("#planDailyNew").value) || 0);
    if (!name || !date) return;
    if (editingPlanId) Store.updatePlan(editingPlanId, { name, date, deckIds, dailyNew });
    else Store.addPlan({ name, date, deckIds, dailyNew });
    renderPlanSection();
  });

  function renderHome() {
    renderFolderBar();
    renderPlanSection();
    const grid = $("#deckGrid");
    const hasFolders = Store.state.folders.length > 0;
    // mode: 'overview'(최상위·폴더 있음) | 'folder'(폴더 안) | 'starred' | 'flat'(폴더 없음 폴백)
    const mode = currentFolder === STARRED ? "starred"
      : currentFolder ? "folder"
        : hasFolders ? "overview" : "flat";

    let i = 0, html = "";
    if (mode === "overview") {
      const anyStarred = Store.state.decks.some(d => d.starred);
      const tops = sortFolders(Store.childFolders(null));
      const unfiled = sortDecks(Store.state.decks.filter(d => !d.folderId));
      if (anyStarred) html += starredCardHTML(i++);
      html += tops.map(f => folderCardHTML(f, i++)).join("");
      html += addFolderCardHTML(null);
      if (unfiled.length) {
        html += `<div class="home-divider">${t("home.unfiled")}</div>`;
        html += unfiled.map(d => deckCardHTML(d, i++)).join("");
      }
    } else if (mode === "folder") {
      const subs = sortFolders(Store.childFolders(currentFolder));
      const decks = sortDecks(Store.state.decks.filter(d => d.folderId === currentFolder));
      html += subs.map(f => folderCardHTML(f, i++)).join("");
      html += addFolderCardHTML(currentFolder);
      if (decks.length) {
        if (subs.length) html += `<div class="home-divider">${t("folder.decksHere")}</div>`;
        html += decks.map(d => deckCardHTML(d, i++)).join("");
      } else if (!subs.length) {
        html += `<div class="deck-empty"><span class="bunny-sprite js-bunny empty-bunny" aria-hidden="true"></span><p>${t("folder.empty")}</p></div>`;
      }
    } else { // starred | flat
      const decks = sortDecks(Store.state.decks.filter(d => mode === "starred" ? d.starred : true));
      html = decks.length
        ? decks.map((d, k) => deckCardHTML(d, k)).join("")
        : `<div class="deck-empty"><span class="bunny-sprite js-bunny empty-bunny" aria-hidden="true"></span><p>${t("hero.empty")}</p></div>`;
    }

    grid.innerHTML = html;
    wireFolderCards(grid);
    wireDeckCards(grid);

    // 토끼 아래 요약 텍스트는 표시하지 않음 — 오늘 목표/응원은 말풍선(#bunnyBubble)으로만
    $("#heroSummary").textContent = "";
    setBunnyBubble(false);
    applyBunnies();
    // "모두 학습"은 지금 할 수 있는(예정 복습+남은 새) 게 있을 때만
    const all = aggCounts(Store.state.decks);
    const waiting = all.due + all.neu;
    $("#btnStudyAll").classList.toggle("hidden", !waiting || selectMode);
    $("#btnNewDeck").classList.toggle("hidden", selectMode);

    // 선택 모드 토글: 개요에서는 숨김(덱 아닌 폴더 카드뿐), 그 외 덱이 있을 때만
    const showSelect = mode !== "overview" && (Store.state.decks.length > 0 || selectMode);
    $("#btnSelectMode").classList.toggle("hidden", !showSelect);
    $("#btnSelectMode").textContent = selectMode ? t("home.selectCancel") : t("home.select");
    renderBulkBar();
  }

  function toggleDeckPick(id) {
    if (selectedDecks.has(id)) selectedDecks.delete(id); else selectedDecks.add(id);
    renderHome();
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

    // 별표한 카드가 있을 때만 '별표 학습' 버튼 노출
    const starredCount = Store.cardsOf(deck.id).filter(c => c.starred && !c.suspended).length;
    $("#btnStudyStarred").classList.toggle("hidden", !starredCount);
    // '다시'를 자주 누른(≥5회) 카드가 있을 때만 '자주 틀림' 버튼 노출
    const leechCount = Store.cardsOf(deck.id).filter(isLeech).length;
    $("#btnStudyLeeches").classList.toggle("hidden", !leechCount);

    renderShareButton();
    renderCardList();
    checkDeckUpdate(deck);
  }

  // 받은(다운로드한) 덱이면 원본이 갱신됐는지 확인해 자동으로 최신본을 받아온다.
  // (주인의 수정이 자동 반영 — 내가 직접 넣은 카드는 병합에서 보존된다.)
  let autoPulling = false;
  function checkDeckUpdate(deck) {
    const btn = $("#btnDeckUpdate");
    btn.classList.add("hidden");
    // 받은 덱(sourceId)뿐 아니라 '내가 공개한 공동편집 덱(sharedId+collab)'도 확인해야
    // 친구가 올린 수정·추가가 내 쪽으로 내려온다.
    const srcId = deck.sourceId || (deck.collab && deck.sharedId) || null;
    if (!srcId || !Social.checkDeckUpdate) return;
    Social.checkDeckUpdate(srcId, deck.sourceUpdatedAt).then(async r => {
      if (!r || !r.hasUpdate || currentDeckId !== deck.id || autoPulling) return;
      // 편집 모달 등이 열려 있으면 자동 적용을 미루고 버튼만 노출(작업 방해 방지)
      if (document.querySelector("dialog[open]")) { btn.classList.remove("hidden"); return; }
      autoPulling = true;
      try {
        const collab = r.collab || deck.collab;
        let res;
        if (collab) res = await Social.syncCollabDeck(deck.id, srcId); // 공동편집 → 양방향 병합
        else if (deck.sourceId) res = await Social.pullDeckUpdate(deck.id, deck.sourceId); // 일반 → 받기만
        else return; // 내가 공개한 비공동편집 덱은 내려받을 게 없음
        if (res && res.notCollab) { // 공동편집이 꺼졌으면 일반 받기로 폴백(받은 덱만)
          Store.patchDeck(deck.id, { collab: false });
          if (deck.sourceId) res = await Social.pullDeckUpdate(deck.id, deck.sourceId);
        }
        if (currentDeckId === deck.id) renderDeck();
        const a = res?.added || 0, u = res?.updated || 0, rm = res?.removed || 0;
        if (a || u || rm) toast(t("update.autoDone", { a, u, r: rm }));
      } catch { btn.classList.remove("hidden"); }
      finally { autoPulling = false; }
    }).catch(() => {});
  }

  $("#btnDeckUpdate").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    if (!deck) return;
    const srcId = deck.sourceId || (deck.collab && deck.sharedId) || null;
    if (!srcId) return;
    confirmDialog(t("update.title"), t("update.text"), async () => {
      try {
        const res = (deck.collab)
          ? await Social.syncCollabDeck(currentDeckId, srcId)
          : await Social.pullDeckUpdate(currentDeckId, srcId);
        const { added = 0, updated = 0, removed = 0 } = res || {};
        renderDeck();
        toast(t("update.doneSmart", { a: added, u: updated, r: removed }));
      } catch {
        toast(t("update.fail"));
      }
    });
  });

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
      .sort((a, b) => a.created - b.created); // 추가한 순서(오래된 것부터)

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

    const cardRowHTML = (c) => {
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
    };
    const secHeadHTML = (name, n) =>
      `<li class="section-head"><span class="section-name">${escapeHTML(name)}</span><span class="section-count">${n}</span></li>`;
    const sortIn = arr => arr.sort((a, b) => a.created - b.created); // 추가한 순서(오래된 것부터)

    // 섹션(장)이 있는 덱은 목록을 장별로 묶어 보여준다(검색·필터 없을 때만).
    const sections = (!q && listFilter === "all") ? Store.sectionsOf(currentDeckId) : [];
    if (sections.length) {
      const bySec = new Map(sections.map(s => [s, []]));
      const none = [];
      cards.forEach(c => {
        const s = (c.section || "").trim();
        if (s && bySec.has(s)) bySec.get(s).push(c); else none.push(c);
      });
      let html = "";
      for (const s of sections) {
        const arr = bySec.get(s);
        if (!arr.length) continue;
        html += secHeadHTML(s, arr.length) + sortIn(arr).map(cardRowHTML).join("");
      }
      if (none.length) html += secHeadHTML(t("deck.noSection"), none.length) + sortIn(none).map(cardRowHTML).join("");
      list.innerHTML = html;
    } else {
      list.innerHTML = cards.map(cardRowHTML).join("");
    }

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
        // '별표 학습' 버튼 노출 갱신
        const sc = Store.cardsOf(currentDeckId).filter(c => c.starred && !c.suspended).length;
        $("#btnStudyStarred").classList.toggle("hidden", !sc);
      });
      row.querySelector(".susp").addEventListener("click", () => {
        Store.updateCard(id, { suspended: !card.suspended });
        renderDeck(); // 학습 대기 수치도 갱신
      });
      row.querySelector(".texts").addEventListener("click", () => openCardView(id));
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
  // 선택한 카드만 학습
  $("#cardBulkStudy").addEventListener("click", () => {
    if (!selectedCards.size) return;
    const ids = shuffleIds(Store.cardsOf(currentDeckId).filter(c => selectedCards.has(c.id)));
    cardSelectMode = false;
    selectedCards.clear();
    startSessionWith(ids, { emptyMsg: t("study.nothingDue") });
  });
  // 선택 카드를 다른 덱으로 이동
  $("#cardBulkMove").addEventListener("click", () => {
    const n = selectedCards.size;
    if (!n) return;
    const others = sortDecks(Store.state.decks.filter(d => d.id !== currentDeckId));
    if (!others.length) { toast(t("move.noTarget")); return; }
    $("#moveSub").textContent = t("move.sub", { n });
    $("#moveDeckSel").innerHTML = others
      .map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join("");
    $("#moveModal").showModal();
  });
  $("#moveConfirm").addEventListener("click", () => {
    const n = selectedCards.size;
    const target = $("#moveDeckSel").value;
    if (!n || !target) return;
    Store.moveCards([...selectedCards], target);
    $("#moveModal").close();
    cardSelectMode = false;
    selectedCards.clear();
    renderDeck();
    toast(t("toast.cardsMoved", { n }));
  });

  /* ══════════ 덱 모달 ══════════ */
  const deckModal = $("#deckModal");

  function fillFolderSelect(selectedId) {
    $("#deckFolderSel").innerHTML =
      `<option value="">${t("folder.none")}</option>` +
      foldersInTreeOrder().map(({ f, depth }) =>
        `<option value="${f.id}" ${f.id === selectedId ? "selected" : ""}>${"　".repeat(depth)}${escapeHTML(f.name)}</option>`).join("");
  }

  function fillDeckSubjects(selected) {
    $("#deckSubjectList").innerHTML = docSubjects().map(s => `<option value="${escapeHTML(s)}"></option>`).join("");
    $("#deckSubjectInput").value = selected || "";
  }

  $("#btnNewDeck").addEventListener("click", () => {
    editingDeck = false;
    $("#deckModalTitle").textContent = t("deckModal.new");
    $("#deckModalSubmit").textContent = t("deckModal.create");
    $("#deckNameInput").value = "";
    $("#deckDescInput").value = "";
    fillDeckSubjects("");
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
    fillDeckSubjects(deck.subject || "");
    fillFolderSelect(deck.folderId || "");
    deckModal.showModal();
  });

  $("#deckForm").addEventListener("submit", () => {
    const name = $("#deckNameInput").value.trim();
    const desc = $("#deckDescInput").value.trim();
    const subject = $("#deckSubjectInput").value.trim();
    const folderId = $("#deckFolderSel").value || null;
    if (!name) return;
    if (editingDeck) {
      Store.updateDeck(currentDeckId, name, desc);
      Store.patchDeck(currentDeckId, { folderId, subject });
      renderDeck();
      toast(t("toast.deckUpdated"));
    } else {
      const deck = Store.addDeck(name, desc);
      Store.patchDeck(deck.id, { folderId, subject });
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
    // 공동편집 토글은 내가 공개한 덱(sharedId)에서만 노출
    const cbtn = $("#btnCollab");
    cbtn.classList.toggle("hidden", !deck?.sharedId);
    if (deck?.sharedId) {
      cbtn.textContent = deck.collab ? t("collab.on") : t("collab.off");
      cbtn.classList.toggle("is-shared", !!deck.collab);
    }
  }

  $("#btnCollab").addEventListener("click", async () => {
    const deck = Store.getDeck(currentDeckId);
    if (!deck?.sharedId) return;
    const next = !deck.collab;
    const cbtn = $("#btnCollab"); cbtn.disabled = true;
    try {
      await Social.setDeckCollab(deck.sharedId, next);
      Store.patchDeck(deck.id, { collab: next });
      renderShareButton();
      toast(next ? t("collab.turnedOn") : t("collab.turnedOff"));
    } catch { toast(t("fr.offline")); }
    finally { cbtn.disabled = false; }
  });

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
      const { sharedId, count, docCount } = await Social.publishDeck(deck, Store.cardsOf(deck.id), shareVisibility);
      Store.patchDeck(deck.id, { sharedId, visibility: shareVisibility });
      renderShareButton();
      shareModal.close();
      toast(docCount ? t("share.doneDocs", { n: count, d: docCount }) : t("share.done", { n: count }));
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

  // 덱 파일로 내보내기 (이미지 포함) — 친구에게 파일 전달용
  $("#btnExportDeck").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    const bundle = Store.exportDeckBundle(currentDeckId);
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    downloadBlob(blob, `${deck.name.replace(/[\\/:*?"<>|]/g, "_")}.petale.json`);
    toast(t("toast.exported"));
  });

  // 덱 학습 초기화 — 모든 카드를 새 카드 상태로 (예약된 복습 일정 초기화)
  $("#btnResetDeck").addEventListener("click", () => {
    const deck = Store.getDeck(currentDeckId);
    const n = Store.cardsOf(currentDeckId).length;
    if (!n) { toast(t("toast.resetDone", { n: 0 })); return; }
    confirmDialog(t("confirm.resetDeck", { name: deck.name }), t("confirm.resetDeckText", { n }), () => {
      const cnt = Store.resetDeckSchedule(currentDeckId);
      renderDeck();
      toast(t("toast.resetDone", { n: cnt }));
    });
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

  const scaleFields = ["cardScale", "imageScale"];
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
    setRich($("#cardNotesInput"), card?.notes || "");
    $("#cardSectionInput").value = card?.section || "";
    $("#sectionList").innerHTML = Store.sectionsOf(currentDeckId).map(s => `<option value="${escapeHTML(s)}">`).join("");
    noteImageData = card?.noteImageId ? (Store.getMedia(card.noteImageId) || null) : null;
    renderNoteImagePreview();
    backImageData = card?.backImageId ? (Store.getMedia(card.backImageId) || null) : null;
    renderBackImagePreview();
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
      // 새 카드는 항상 basic으로 시작(직전 타입을 기억하지 않아 헷갈리지 않게)
      setCardType("basic");
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
      if (card && card.id === editingCardId) rerenderStudyFaces(card);
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

  /* ── 답(back) 이미지 첨부 — 메모 이미지와 동일 방식 ── */
  let backImageData = null; // 현재 모달의 답 이미지 dataURL
  function renderBackImagePreview() {
    const wrap = $("#backImgPreview");
    if (backImageData) {
      $("#backImgThumb").src = backImageData;
      wrap.classList.remove("hidden");
      $("#backImgBtn").textContent = t("cardModal.changeImage");
    } else {
      $("#backImgThumb").removeAttribute("src");
      wrap.classList.add("hidden");
      $("#backImgBtn").textContent = t("cardModal.addImage");
    }
  }
  function commitBackImage(existingId) {
    if (!backImageData) return null;
    if (existingId && Store.getMedia(existingId) === backImageData) return existingId;
    return Store.addMedia(backImageData);
  }
  $("#backImgBtn").addEventListener("click", () => $("#backImgFile").click());
  $("#backImgFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { backImageData = await fileToNoteDataURL(f); renderBackImagePreview(); }
    catch { toast(t("toast.imageFail")); }
  });
  $("#backImgRemove").addEventListener("click", () => { backImageData = null; renderBackImagePreview(); });
  // 붙여넣기에서 이미지를 꺼낸다 — files / items / HTML의 data:URL 모두 지원.
  // 동기 감지만 하고(여기서 preventDefault를 즉시 부를 수 있게) 파일 변환은 뒤에서 처리.
  function pickPasteImage(e) {
    const cd = e.clipboardData; if (!cd) return null;
    for (const f of (cd.files || [])) if (f.type && f.type.startsWith("image/")) return { file: f };
    for (const it of (cd.items || [])) if (it.kind === "file" && it.type && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) return { file: f }; }
    const html = cd.getData && cd.getData("text/html");
    const m = html && html.match(/<img[^>]+src=["'](data:image\/[^"']+)["']/i);
    if (m) return { dataUrl: m[1] };
    return null;
  }
  async function pasteToBackImage(hit) {
    try {
      let f = hit.file;
      if (!f && hit.dataUrl) { const r = await fetch(hit.dataUrl); const b = await r.blob(); f = new File([b], "paste", { type: b.type }); }
      backImageData = await fileToNoteDataURL(f);
      renderBackImagePreview();
    } catch { toast(t("toast.imageFail")); }
  }
  // 답 칸에 이미지 붙여넣기(Ctrl+V) → 답 이미지로 첨부
  $("#cardBackInput").addEventListener("paste", (e) => {
    const hit = pickPasteImage(e);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pasteToBackImage(hit);
  });

  $("#cardForm").addEventListener("submit", (e) => {
    const notes = getRich($("#cardNotesInput"));
    const section = $("#cardSectionInput").value.trim();
    const editCard = editingCardId ? Store.state.cards.find(c => c.id === editingCardId) : null;
    const noteImageId = commitNoteImage(editCard?.noteImageId);
    const backImageId = commitBackImage(editCard?.backImageId);

    // 이미지 가리기 편집: 헤더 + 메모만
    if (editCard?.type === "occlusion") {
      Store.updateCard(editingCardId, { front: $("#occHeaderInput").value.trim(), notes, noteImageId, ...scaleValues() });
      Store.setSection(editingCardId, section); // 같은 노트의 형제 카드에도 섹션 반영
      toast(t("toast.cardUpdated"));
      afterCardSaved();
      return;
    }

    if (cardType === "cloze") {
      const text = getRich($("#clozeInput"));
      const indices = clozeIndices(text);
      if (!text || !indices.length) { e.preventDefault(); toast(t("toast.clozeNeeded")); return; }
      if (editingCardId) {
        // 같은 노트에서 나온 형제 빈칸 카드들에 본문·메모·배율을 함께 반영(빈칸 추가·삭제 포함)
        Store.syncClozeSiblings(editingCardId, text, indices, { notes, noteImageId, section, ...scaleValues() });
        toast(t("toast.cardUpdated"));
      } else {
        const noteId = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const rows = indices.map(idx => ({ type: "cloze", front: text, back: "", clozeIndex: idx, clozeNoteId: noteId, notes, noteImageId, section, ...scaleValues() }));
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
      Store.updateCard(editingCardId, { front, back, notes, noteImageId, backImageId, section, ...scaleValues() });
      toast(t("toast.cardUpdated"));
    } else {
      const rows = [{ type: "basic", front, back, notes, noteImageId, backImageId, section, ...scaleValues() }];
      // 역방향 자동 카드: 답 이미지는 뒷면(원래 답)에 붙어 있으므로 앞면이 되는 쪽(frontImageId)으로 옮긴다
      if ($("#cardReversed").checked) rows.push({ type: "basic", front: back, back: front, notes, noteImageId, frontImageId: backImageId, section, ...scaleValues() });
      const ok = Store.bulkAddCards(currentDeckId, rows);
      toast(ok ? (rows.length > 1 ? t("toast.cardsAdded", { n: rows.length }) : t("toast.cardAdded")) : t("toast.storageFull"));
    }
    afterCardSaved();
  });

  /* ══════════ 서식 툴바(굵게/밑줄/글자색/하이라이트) ══════════ */
  let activeRichField = $("#cardFrontInput");
  [$("#cardFrontInput"), $("#cardBackInput"), $("#clozeInput"), $("#cardNotesInput")].forEach(el => {
            el.addEventListener("focusin", () => {
      activeRichField = el;
      try { document.execCommand("defaultParagraphSeparator", false, "br"); } catch {}
    });
    el.addEventListener("focus", () => { activeRichField = el; });
    // 붙여넣기: 스프레드시트/웹의 '표'는 표로 보존, 그 외엔 일반 텍스트만
    el.addEventListener("paste", (e) => {
      const cd = e.clipboardData || window.clipboardData;
      const html = cd && cd.getData("text/html");
      if (html && /<table[\s>]/i.test(html)) {
        e.preventDefault();
        document.execCommand("insertHTML", false, sanitizeRichHTML(html));
        return;
      }
      e.preventDefault();
      document.execCommand("insertText", false, cd.getData("text/plain"));
    });
    // 표 안에서 Tab: 다음 셀로 이동(마지막 셀이면 행 추가), Shift+Tab: 이전 셀
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" && e.key !== "Enter") return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      let n = sel.getRangeAt(0).startContainer;
      const base = n.nodeType === 1 ? n : n.parentElement;
      // Enter: 목록·표가 아니면 <br>로 줄바꿈한다. 브라우저가 Enter마다 <div> 블록을
      // 만들면, 거기에 밑줄/굵게를 적용할 때 위아래로 빈 줄이 생기는 문제가 있다.
      if (e.key === "Enter") {
        if (e.shiftKey) return;                    // Shift+Enter는 기본(<br>)
        if (base?.closest("li, td, th")) return;   // 목록·표는 기본 동작 유지
        e.preventDefault();
        let ok = false;
        try { ok = document.execCommand("insertLineBreak"); } catch { /* 무시 */ }
        if (!ok) { try { document.execCommand("insertHTML", false, "<br>"); } catch { /* 무시 */ } }
        return;
      }
      const cell = base?.closest("td,th");
      if (cell && el.contains(cell)) { // 표 안: 셀 이동
        e.preventDefault();
        const cells = [...el.querySelectorAll("td,th")];
        const i = cells.indexOf(cell);
        if (e.shiftKey) { if (i > 0) focusCell(cells[i - 1]); }
        else if (i < cells.length - 1) focusCell(cells[i + 1]);
        else focusCell(addTableRow(cell));
        return;
      }
      // 목록 안: Tab = 들여쓰기(중첩), Shift+Tab = 내어쓰기
      const li = base?.closest("li");
      if (li && el.contains(li)) {
        e.preventDefault();
        try { document.execCommand("styleWithCSS", false, false); } catch { /* 무시 */ }
        try { document.execCommand(e.shiftKey ? "outdent" : "indent"); } catch { /* 무시 */ }
        return;
      }
      // 그 외: 기본 Tab 동작(포커스 이동)
    });
  });
  document.addEventListener("selectionchange", () => {
    if (!document.activeElement || !document.activeElement.closest?.("#basicFields, #clozeFields, #notesField")) return;
    try {
      $("#richToolbar .rt-btn[data-cmd=bold]")?.classList.toggle("active", document.queryCommandState("bold"));
      $("#richToolbar .rt-btn[data-cmd=italic]")?.classList.toggle("active", document.queryCommandState("italic"));
      $("#richToolbar .rt-btn[data-cmd=underline]")?.classList.toggle("active", document.queryCommandState("underline"));
    } catch { /* 일부 브라우저는 지원 안 함 — 무시 */ }
  });
  // 선택 영역을 지정한 인라인 요소로 직접 감싼다.
  // execCommand의 색/형광펜은 브라우저마다 줄 전체에 적용되거나 글자 크기를
  // 건드리는 문제가 있어, 색·형광펜은 이 방식으로 "선택한 부분만" 정확히 칠한다.
  const INLINE_TAG = { bold: "strong", underline: "u", italic: "em" };
  function wrapSelection(field, tag, style, className) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!field.contains(range.commonAncestorContainer)) return false;
    const wrap = document.createElement(tag);
    if (style) for (const [k, v] of Object.entries(style)) {
      if (k.startsWith("--")) wrap.style.setProperty(k, v); // 커스텀 속성(--hl)은 setProperty로
      else wrap.style[k] = v;
    }
    if (className) wrap.className = className;
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

  // 선택 지점이 속한 형광펜 요소(.hl / mark)를 찾는다(없으면 null)
  function highlightAncestor(node, field) {
    let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (el && el !== field) {
      if ((el.classList && el.classList.contains("hl")) || el.tagName === "MARK") return el;
      el = el.parentElement;
    }
    return null;
  }
  // 형광펜 요소를 벗겨 일반 텍스트로(토글 off)
  function unwrapHighlight(el) {
    const parent = el.parentNode;
    if (!parent) return;
    const sel = window.getSelection();
    const r = document.createRange();
    const first = el.firstChild;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    const last = el.previousSibling;
    parent.removeChild(el);
    parent.normalize();
    if (first) { try { r.setStartBefore(first); r.setEndAfter(last || first); sel.removeAllRanges(); sel.addRange(r); } catch { /* 무시 */ } }
  }
  // 형광펜 토글: 이미 같은 색이면 제거, 다른 색이면 교체, 없으면 선택 영역에 적용
  function toggleHighlight(field, val) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const hit = highlightAncestor(range.commonAncestorContainer, field);
    if (hit) {
      const cur = (hit.style.getPropertyValue("--hl") || "").trim().toLowerCase();
      if (!val || cur === String(val).toLowerCase()) { unwrapHighlight(hit); return; } // 같은 색 → 제거
      hit.style.setProperty("--hl", val); hit.classList.add("hl"); hit.style.removeProperty("background-color"); // 다른 색 → 교체
      return;
    }
    wrapSelection(field, "span", { "--hl": val }, "hl"); // 새로 적용
  }

  // 표 편집 헬퍼 — 셀로 커서 이동(내용 선택) / 마지막 행 뒤에 빈 행 추가
  function focusCell(cell) {
    if (!cell) return;
    const r = document.createRange();
    r.selectNodeContents(cell);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return cell;
  }
  function addTableRow(cell) {
    const row = cell.closest("tr");
    const section = row.parentElement; // tbody/thead
    const nr = document.createElement("tr");
    for (let k = 0; k < row.children.length; k++) {
      const td = document.createElement("td");
      td.innerHTML = "<br>";
      nr.appendChild(td);
    }
    section.appendChild(nr);
    return nr.firstChild;
  }

  // 표 삽입 버튼 — 현재 리치 필드에 머리글 1행 + 본문 2행(3열) 표를 넣는다
  const btnTable = $("#richInsertTable");
  if (btnTable) {
    btnTable.addEventListener("mousedown", (e) => e.preventDefault());
    btnTable.addEventListener("click", () => {
      const field = activeRichField || $("#cardFrontInput");
      field.focus();
      const html =
        '<table class="ctbl"><thead><tr><th>제목</th><th>제목</th><th>제목</th></tr></thead>' +
        '<tbody><tr><td>내용</td><td>내용</td><td>내용</td></tr>' +
        '<tr><td>내용</td><td>내용</td><td>내용</td></tr></tbody></table><br>';
      document.execCommand("insertHTML", false, html);
      const tbls = field.querySelectorAll("table.ctbl");
      const tbl = tbls[tbls.length - 1];
      if (tbl) focusCell(tbl.querySelector("th"));
    });
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
      if (cmd === "hiliteColor" || cmd === "backColor") { toggleHighlight(field, btn.dataset.val); return; }
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
  // 빈칸 삽입. sameGroup=true 면 새 번호를 매기지 않고 현재 가장 큰 번호를 재사용해
  // 여러 곳을 같은 번호로 묶는다 → 그 카드에서 동시에 가려지고 동시에 공개된다.
  function insertClozeToken(sameGroup) {
    const field = $("#clozeInput");
    field.focus();
    const existing = clozeIndices(field.textContent || "");
    const max = existing.length ? Math.max(...existing) : 0;
    const n = sameGroup ? (max || 1) : max + 1;
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
  }
  $("#richInsertCloze").addEventListener("mousedown", (e) => e.preventDefault());
  $("#richInsertCloze").addEventListener("click", () => insertClozeToken(false));
  $("#richInsertClozeSame").addEventListener("mousedown", (e) => e.preventDefault());
  $("#richInsertClozeSame").addEventListener("click", () => insertClozeToken(true));
  $("#richFont").addEventListener("change", e => {
    if (!e.target.value) return;
    activeRichField.focus(); document.execCommand("styleWithCSS", false, true); document.execCommand("fontName", false, e.target.value); e.target.value = "";
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
      // 마스크 위치·범위 수정을 같은 이미지의 모든 형제 카드에 반영
      Store.syncOcclusionSiblings(editingOccCardId, { ...fields, ...scaleValues() });
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

  $("#impDeckFile").addEventListener("click", () => $("#deckFile").click());
  $("#deckFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    pickFile("deckfile", file);
  });

  // 문서(HTML/텍스트)에서 빈칸 만들기: 강조된 부분(굵게·형광펜·밑줄·제목)을 {{c}} 로 바꿔
  // 아래 텍스트 칸에 채워 넣는다. 사용자는 만들기 전에 자유롭게 손볼 수 있다.
  $("#impDoc").addEventListener("click", () => $("#docFile").click());
  $("#docFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const out = htmlToCloze(text);
      pendingFile = null;
      $("#importPicked").classList.add("hidden");
      $("#importError").textContent = "";
      $("#bulkText").value = out;
      $("#bulkText").focus();
      if (!/\{\{c\d+::/.test(out)) toast(t("imp.docNoEmph"));
    } catch { $("#importError").textContent = t("imp.fail"); }
  });

  // HTML/텍스트 → cloze 초안. 블록(문단·목록·제목)은 // 로 구분,
  // 강조 요소(b/strong/mark/u/em, 굵게·배경색 스타일)는 {{cN::…}} 로 감싼다.
  function htmlToCloze(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const blockSel = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,dd,dt";
    const isEmph = (el) => el.matches("b,strong,mark,u,em") ||
      /font-weight\s*:\s*(bold|[6-9]00)/i.test(el.getAttribute("style") || "") ||
      /background(-color)?\s*:/i.test(el.getAttribute("style") || "");
    const blocks = [...doc.body.querySelectorAll(blockSel)].filter(n => !n.querySelector(blockSel));
    const lines = [];
    const build = (node) => {
      let n = 0;
      const parts = [];
      const walk = (el) => {
        el.childNodes.forEach(ch => {
          if (ch.nodeType === 3) parts.push(ch.textContent);
          else if (ch.nodeType === 1) {
            const inner = (ch.textContent || "").trim();
            if (isEmph(ch) && inner) { parts.push(`{{c${++n}::${inner}}}`); }
            else walk(ch);
          }
        });
      };
      walk(node);
      return parts.join("").replace(/\s+/g, " ").trim();
    };
    if (blocks.length) {
      for (const b of blocks) { const line = build(b); if (/\{\{c\d+::/.test(line)) lines.push(line); }
    }
    // 강조가 하나도 없으면(또는 블록이 없으면) 평문을 문단별로 넣어 직접 빈칸을 칠 수 있게 한다
    if (!lines.length) {
      const raw = (doc.body.textContent || html || "").split(/\n{2,}|\r\n\r\n/).map(s => s.trim()).filter(Boolean);
      return raw.join("\n//\n");
    }
    return lines.join("\n//\n");
  }

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
      const { added, sections, deckId, createdNew } = await Apkg.importFile(file, currentDeckId,
        msg => { $("#importPicked").textContent = msg; });
      $("#importModal").close();
      if (createdNew && deckId) currentDeckId = deckId; // 대상 덱이 없어 새로 만든 경우 그 덱을 연다
      renderDeck();
      toast(added
        ? (sections ? t("imp.doneSections", { n: added, s: sections }) : t("imp.done", { n: added }))
        : t("imp.empty"));
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

  // CSV 헤더에서 앞면/뒷면/장(섹션) 열 위치를 찾는다. 장 열이 있으면 헤더 기반 매핑을 쓴다.
  const CSV_FRONT = ["front", "question", "term", "word", "앞면", "질문", "단어"];
  const CSV_BACK = ["back", "answer", "definition", "meaning", "뒷면", "답", "뜻", "정의"];
  const CSV_SECTION = ["section", "chapter", "장", "챕터", "단원", "섹션"];
  const CSV_NOTE = ["note", "notes", "memo", "메모", "노트", "설명"];
  async function runCsvImport(file) {
    $("#importError").textContent = "";
    try {
      let text = await file.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM 제거
      const parsed = parseCSV(text, detectDelim(text));
      const header = (parsed[0] || []).map(c => c.trim().toLowerCase());
      const find = names => header.findIndex(h => names.includes(h));
      const si = find(CSV_SECTION), ni = find(CSV_NOTE);
      let fi = find(CSV_FRONT), bi = find(CSV_BACK);

      const rows = [];
      if (si >= 0 || ni >= 0 || fi >= 0 || bi >= 0) {
        // 헤더 CSV → 열 이름으로 매핑 (front/back/장/메모). front·back 열 이름이 없으면
        // 장·메모 열을 피해 앞에서부터 순서대로 채운다.
        const taken = new Set([si, ni].filter(x => x >= 0));
        if (fi < 0) { fi = 0; while (taken.has(fi)) fi++; }
        taken.add(fi);
        if (bi < 0) { bi = 0; while (taken.has(bi)) bi++; }
        for (const cols of parsed.slice(1)) {
          const front = inlineMd((cols[fi] || "").trim());
          const back = inlineMd((cols[bi] || "").trim());
          const section = si >= 0 ? (cols[si] || "").trim() : "";
          const noteRaw = ni >= 0 ? (cols[ni] || "").trim() : "";
          if (!front || !back) continue;
          const row = { type: "basic", front, back, section };
          if (noteRaw) row.notes = inlineMd(noteRaw).replace(/\n/g, "<br>");
          rows.push(row);
        }
      } else {
        // 기존 방식: 앞면 = 첫 열, 뒷면 = 나머지 열들
        for (const cols of parsed) {
          const front = (cols[0] || "").trim();
          const back = cols.slice(1).map(c => c.trim()).filter(Boolean).join(" — ");
          if (front && back) rows.push({ type: "basic", front: inlineMd(front), back: inlineMd(back) });
        }
        if (rows.length && new RegExp(`^(${CSV_FRONT.join("|")})$`, "i").test(rows[0].front)) rows.shift();
      }
      if (!rows.length) { $("#importError").textContent = t("imp.empty"); return; }
      const ok = Store.bulkAddCards(currentDeckId, rows);
      const sections = new Set(rows.map(r => r.section).filter(Boolean)).size;
      $("#importModal").close();
      renderDeck();
      toast(ok ? (sections ? t("imp.doneSections", { n: rows.length, s: sections }) : t("imp.done", { n: rows.length })) : t("toast.storageFull"));
    } catch {
      $("#importError").textContent = t("imp.fail");
    }
  }

  // Petale 덱 파일(.json, 이미지 포함) 가져오기 — 지금 열려 있는 덱에 카드 추가(이미지 포함)
  async function runDeckFileImport(file) {
    $("#importError").textContent = "";
    try {
      const bundle = JSON.parse(await file.text());
      const { count } = Store.importDeckBundle(bundle, currentDeckId);
      $("#importModal").close();
      cardSelectMode = false; selectedCards.clear();
      renderDeck();
      toast(t("imp.done", { n: count }));
    } catch (e) {
      $("#importError").textContent = e && e.message === "bad_file" ? t("imp.badDeckFile") : t("imp.fail");
    }
  }

  // 가져오기 공통 인라인 서식: **굵게** → <strong>, ==형광== → <mark>(초록, 글자 아래 밴드)
  const HL_GREEN = "#d6e3b8";
  const inlineMd = (s) => String(s || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/==([^=\n]+)==/g, `<mark class="hl" style="--hl:${HL_GREEN}">$1</mark>`);
  // 표 셀: HTML 이스케이프 후 인라인 서식 적용 ({{cN::}}는 그대로 남음)
  const mdCellInline = (s) => inlineMd(escapeHTML(s));
  function mdTableToHtml(lines) {
    const rows = lines.map(l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    const isSep = cells => cells.length && cells.every(c => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
    const sep = rows.findIndex(isSep);
    const head = sep >= 0 ? rows.slice(0, sep) : rows.slice(0, 1);
    const body = sep >= 0 ? rows.slice(sep + 1) : rows.slice(1);
    const tr = (cells, tag) => `<tr>${cells.map(c => `<${tag}>${mdCellInline(c)}</${tag}>`).join("")}</tr>`;
    let html = '<table class="ctbl">';
    if (head.length) html += "<thead>" + head.map(r => tr(r, "th")).join("") + "</thead>";
    if (body.length) html += "<tbody>" + body.map(r => tr(r, "td")).join("") + "</tbody>";
    return html + "</table>";
  }
  const isMdTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);

  function runTextImport() {
    // 카드는 "//" 로 구분 — 한 카드 안에서는 자유롭게 줄바꿈할 수 있다
    const blocks = $("#bulkText").value.split("//").map(b => b.trim()).filter(Boolean);
    const rows = [];
    let section = ""; // "# 챕터명" 제목을 만나면 이후 카드들의 장이 된다 (띄어쓰기 가능)
    for (let block of blocks) {
      // 장 제목: 블록 첫 줄이 "#"으로 시작하고 콤마/탭·빈칸문법이 없으면 제목으로 떼어낸다.
      // 제목 뒤에 "//" 없이 바로 카드를 이어 써도 인식되도록, 첫 줄만 제목으로 처리한다.
      if (block.startsWith("#")) {
        const nl = block.indexOf("\n");
        const headLine = (nl === -1 ? block : block.slice(0, nl)).trim();
        if (!headLine.includes(",") && !headLine.includes("\t") && !/\{\{c\d+::/.test(headLine)) {
          const hm = /^#+\s*(.*)$/.exec(headLine);
          if (hm && hm[1].trim()) section = hm[1].trim();
          block = (nl === -1 ? "" : block.slice(nl + 1)).trim();
          if (!block) continue; // 제목만 있는 블록
        }
      }
      // 메모(노트): 블록 안에서 "> "로 시작하는 줄은 카드 메모로 떼어낸다
      let blkLines = block.split("\n");
      const noteLines = [];
      blkLines = blkLines.filter(l => {
        const m = /^\s*>\s?(.*)$/.exec(l);
        if (m) { noteLines.push(m[1]); return false; }
        return true;
      });
      if (noteLines.length) block = blkLines.join("\n").trim();
      const notes = noteLines.length ? inlineMd(escapeHTML(noteLines.join("\n"))).replace(/\n/g, "<br>") : "";
      if (!block) continue; // 메모만 있고 카드 내용이 없으면 건너뜀

      // 마크다운 표: "|...|" 줄이 2줄 이상이면 표 카드로 변환
      const tLines = blkLines.filter(isMdTableLine);
      if (tLines.length >= 2) {
        const tableHtml = mdTableToHtml(tLines);
        const frontText = blkLines.filter(l => !isMdTableLine(l)).join("\n").trim();
        const frontHtml = frontText ? inlineMd(escapeHTML(frontText)).replace(/\n/g, "<br>") : "";
        if (/\{\{c\d+::/.test(block)) {
          // 표 안에 빈칸이 있으면 cloze 카드 (표 + 위쪽 설명)
          const front = (frontHtml ? frontHtml + "<br>" : "") + tableHtml;
          for (const idx of clozeIndices(front)) rows.push({ type: "cloze", front, back: "", clozeIndex: idx, section, notes });
        } else {
          // 기본 카드: 설명이 있으면 앞=설명·뒤=표, 없으면 앞=표
          rows.push({ type: "basic", front: frontHtml || tableHtml, back: frontHtml ? tableHtml : "", section, notes });
        }
        continue;
      }
      // 빈칸(cloze) 문법이 있으면 cloze 카드로 처리 — c1, c2…마다 카드가 하나씩 생성된다
      if (/\{\{c\d+::/.test(block)) {
        const front = formatNote(block); // 소제목 가운데·본문 좌측·초록 불릿 + **굵게**·==형광== 서식
        const indices = clozeIndices(block);
        for (const idx of indices) rows.push({ type: "cloze", front, back: "", clozeIndex: idx, section, notes });
        continue;
      }
      let front, back;
      // Q/A 구분선(--- 또는 ===): 윗부분 = 질문, 아랫부분 = 답 (여러 줄·불릿 자유)
      const qaSep = blkLines.findIndex(l => /^\s*(?:-{3,}|={3,})\s*$/.test(l));
      if (qaSep >= 0) {
        front = blkLines.slice(0, qaSep).join("\n").trim();
        back = blkLines.slice(qaSep + 1).join("\n").trim();
      } else if (block.includes("\t")) {
        [front, ...back] = block.split("\t");
        back = back.join(" ").trim();
      } else {
        const i = block.indexOf(",");
        if (i < 0) continue;
        front = block.slice(0, i);
        back = block.slice(i + 1).trim();
      }
      front = linesToHtml(front.trim().split("\n")); // 불릿/번호 줄은 <ul>/<ol>로
      back = linesToHtml(String(back || "").split("\n"));
      if (front && back) rows.push({ type: "basic", front, back, section, notes });
    }
    if (!rows.length) { $("#importError").textContent = t("imp.empty"); return; }
    const ok = Store.bulkAddCards(currentDeckId, rows);
    const sections = new Set(rows.map(r => r.section).filter(Boolean)).size;
    $("#importModal").close();
    renderDeck();
    toast(ok ? (sections ? t("imp.doneSections", { n: rows.length, s: sections }) : t("imp.done", { n: rows.length })) : t("toast.storageFull"));
  }

  // '가져오기' 버튼: 선택된 파일(apkg/csv) 또는 입력한 텍스트를 처리
  $("#bulkImportRun").addEventListener("click", () => {
    $("#importError").textContent = "";
    if (pendingFile?.kind === "apkg") { runApkgImport(pendingFile.file); return; }
    if (pendingFile?.kind === "csv") { runCsvImport(pendingFile.file); return; }
    if (pendingFile?.kind === "deckfile") { runDeckFileImport(pendingFile.file); return; }
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

  // deckId가 null이면 모든 덱을 통합 학습. 새 카드는 제한 없이 전부 포함한다.
  function buildQueue(deckId) {
    const now = Date.now();
    const decks = deckId ? [Store.getDeck(deckId)].filter(Boolean) : Store.state.decks;
    const due = [];
    const neu = [];
    for (const deck of decks) {
      const cards = Store.cardsOf(deck.id).filter(c => !c.suspended);
      due.push(...cards.filter(c => !SRS.isNew(c) && SRS.isDue(c, now)));
      neu.push(...cards.filter(SRS.isNew)); // 하루 새 카드 제한 없음(무제한)
    }
    const shuffle = arr => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    // 복습 카드는 섞고, 새 카드(처음 학습)는 등록한 순서 그대로 (cardsOf가 생성 순서로 반환)
    return [...shuffle(due), ...neu].map(c => c.id);
  }

  function startSessionWith(queue, { global = false, emptyMsg } = {}) {
    if (!queue.length) { toast(emptyMsg || t("study.nothingDue")); return; }
    // main: 복습·새 카드(복습 먼저, 새 카드 나중) / learning: 세션 중 '다시·어려움' 누른 학습 카드 {id, dueAt}
    session = { main: queue, learning: [], current: null, done: 0, total: queue.length, revealed: false, global, history: [], again: 0 };
    $("#studyDone").classList.add("hidden");
    $(".study-stage").classList.remove("hidden");
    $("#btnUndo").classList.add("hidden");
    try { Social.setRoomStudying(true); } catch { /* 룸은 베스트에포트 */ }
    show("study");
    nextCard();
  }
  function startSession(deckId) { startSessionWith(buildQueue(deckId), { global: !deckId }); }

  const shuffleIds = cards => cards.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1].id);

  // 별표한 카드만 학습 — 예약 일정과 무관하게 별표된(정지 아님) 카드를 모아 본다
  function startStarredSession(deckId) {
    startSessionWith(shuffleIds(Store.cardsOf(deckId).filter(c => c.starred && !c.suspended)), { emptyMsg: t("study.noStarred") });
  }
  // '다시'를 자주 누른(≥5회) 카드만 학습 — 자주 틀리는 카드 집중 복습
  function startLeechSession(deckId) {
    startSessionWith(shuffleIds(Store.cardsOf(deckId).filter(isLeech)), { emptyMsg: t("study.noLeeches") });
  }

  $("#btnStudy").addEventListener("click", () => startSession(currentDeckId));
  $("#btnStudyStarred").addEventListener("click", () => startStarredSession(currentDeckId));
  $("#btnStudyLeeches").addEventListener("click", () => startLeechSession(currentDeckId));
  $("#btnStudyAll").addEventListener("click", () => startSession(null));

  /* ── 연습 모드 (퀴즈/쓰기/매치) ── */
  function startPractice(mode, view) {
    Practice.setDeck(currentDeckId);
    const started = mode(currentDeckId, () => show("deck"));
    if (!started) { toast(t("practice.needCards")); return; }
    show(view);
  }
  $("#btnLearn").addEventListener("click", () => startPractice(Practice.startLearn, "learn"));
  $("#btnQuiz").addEventListener("click", () => startPractice(Practice.startQuiz, "quiz"));
  $("#btnWrite").addEventListener("click", () => startPractice(Practice.startWrite, "write"));

  /* ── 개요(흐름 보기): 덱 전체를 장(섹션)별로 이어지는 한 편의 글처럼 읽기 ── */
  $("#btnOverview").addEventListener("click", () => show("overview"));

  /* ── 백지 테스트 ── */
  $("#btnRecall").addEventListener("click", openRecall);
  $("#recallScope").addEventListener("change", (e) => { recallScope = e.target.value; renderRecall(); });
  $("#recallReveal").addEventListener("click", revealRecall);
  $("#recallAgain").addEventListener("click", renderRecall);

  function notesBlockHTML(card) {
    const noteImg = card.noteImageId ? Store.getMedia(card.noteImageId) : null;
    const hasText = card.notes && card.notes.trim();
    if (!hasText && !noteImg) return "";
    let html = hasText ? `<div class="note-text">${sanitizeRichHTML(card.notes)}</div>` : "";
    if (noteImg) html += `<img class="note-img" src="${noteImg}" alt="">`;
    return `<div class="ov-notes">${html}</div>`;
  }

  // 빈칸(cloze) 형제는 같은 본문을 공유하므로 개요·백지테스트에선 한 번만 보여준다
  function dedupeClozeSiblings(cards) {
    const seen = new Set();
    return cards.filter(c => {
      if (c.type !== "cloze") return true;
      if (seen.has(c.front)) return false;
      seen.add(c.front); return true;
    });
  }

  // 카드들을 장(섹션)별로 묶어 '정답 펼친' 시트(ov-sheet) DOM을 만든다 (개요·백지테스트 공용)
  function buildOverviewSheet(cards) {
    const sections = Store.sectionsOf(currentDeckId);
    const groups = [];
    if (sections.length) {
      const bySec = new Map(sections.map(s => [s, []]));
      const none = [];
      cards.forEach(c => { const s = (c.section || "").trim(); if (s && bySec.has(s)) bySec.get(s).push(c); else none.push(c); });
      sections.forEach(s => { if (bySec.get(s).length) groups.push({ name: s, cards: bySec.get(s) }); });
      if (none.length) groups.push({ name: t("deck.noSection"), cards: none });
    } else {
      groups.push({ name: "", cards });
    }

    const sheet = document.createElement("div");
    sheet.className = "ov-sheet";
    let chapNo = 0;
    groups.forEach(g => {
      const chap = document.createElement("section");
      chap.className = "ov-chap";
      if (g.name) {
        chapNo++;
        const h = document.createElement("h2");
        h.className = "ov-chap-title";
        h.innerHTML = `<span class="ov-chap-no">${String(chapNo).padStart(2, "0")}</span>`
          + `<span class="ov-chap-name">${escapeHTML(g.name)}</span>`
          + `<span class="ov-chap-count">${t("overview.cardCount", { n: g.cards.length })}</span>`;
        chap.appendChild(h);
      }
      g.cards.forEach(c => {
        const note = document.createElement("article");
        note.className = "ov-note" + (isMediaCard(c) || c.type === "occlusion" ? " media" : "");
        if (c.type === "basic") {
          const front = document.createElement("div"); front.className = "ov-term";
          const back = document.createElement("div"); back.className = "ov-def";
          renderFace(front, c, false);
          renderFace(back, c, true);
          note.append(front, back);
        } else if (c.type === "cloze") {
          // 빈칸을 전부 초록 정답으로 드러낸 본문 한 벌
          const face = document.createElement("div"); face.className = "ov-body";
          face.innerHTML = renderClozeAll(c.front);
          note.appendChild(face);
        } else {
          // occlusion: 라벨 공개 이미지
          const face = document.createElement("div"); face.className = "ov-body";
          renderFace(face, c, true);
          note.appendChild(face);
        }
        const notes = notesBlockHTML(c);
        if (notes) note.insertAdjacentHTML("beforeend", notes);
        chap.appendChild(note); // 개요는 읽기 전용 — 클릭 없음
      });
      sheet.appendChild(chap);
    });
    return sheet;
  }

  function renderOverview() {
    const deck = Store.getDeck(currentDeckId);
    if (!deck) { show("deck"); return; }
    $("#overviewTitle").textContent = deck.name;
    const body = $("#overviewBody");
    const allCards = Store.cardsOf(currentDeckId).filter(c => !c.suspended);
    if (!allCards.length) {
      $("#overviewSub").textContent = "";
      body.innerHTML = `<p class="list-empty">${t("overview.empty")}</p>`;
      return;
    }
    const cards = dedupeClozeSiblings(allCards);
    const sections = Store.sectionsOf(currentDeckId);
    $("#overviewSub").textContent = sections.length
      ? t("overview.subSections", { c: cards.length, s: sections.length })
      : t("overview.subFlat", { c: cards.length });
    body.replaceChildren(buildOverviewSheet(cards));
  }

  /* ── 백지 테스트 (브레인덤프: 빈 종이에 다 적고 정답 펼쳐 대조) ── */
  let recallScope = ""; // "" = 덱 전체, 그 외 = 섹션명

  function openRecall() {
    if (!Store.getDeck(currentDeckId)) return;
    recallScope = "";
    show("recall"); // show()가 renderRecall() 호출
  }

  function recallCards() {
    const all = Store.cardsOf(currentDeckId).filter(c => !c.suspended);
    const scoped = recallScope ? all.filter(c => (c.section || "").trim() === recallScope) : all;
    return dedupeClozeSiblings(scoped);
  }

  function renderRecall() {
    const deck = Store.getDeck(currentDeckId);
    if (!deck) { show("deck"); return; }
    $("#recallTitle").textContent = deck.name;
    // 범위 선택: 덱 전체 + 섹션들
    const sections = Store.sectionsOf(currentDeckId);
    const sel = $("#recallScope");
    sel.innerHTML = `<option value="">${t("recall.whole")}</option>`
      + sections.map(s => `<option value="${escapeHTML(s)}" ${s === recallScope ? "selected" : ""}>${escapeHTML(s)}</option>`).join("");
    sel.value = recallScope;
    sel.classList.toggle("hidden", !sections.length); // 섹션 없으면 선택 숨김
    const n = recallCards().length;
    $("#recallCount").textContent = t("recall.count", { n });
    // 입력·정답 초기화
    $("#recallInput").value = "";
    $("#recallAnswers").classList.add("hidden");
    $("#recallAnswers").replaceChildren();
    $("#recallReveal").classList.remove("hidden");
    $("#recallAgain").classList.add("hidden");
    $("#recallInput").focus();
  }

  function revealRecall() {
    const answers = $("#recallAnswers");
    answers.replaceChildren(buildOverviewSheet(recallCards()));
    answers.classList.remove("hidden");
    $("#recallReveal").classList.add("hidden");
    $("#recallAgain").classList.remove("hidden");
    answers.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
    $("#flipBackRow").classList.add("hidden");
    $("#revealRow").classList.remove("hidden");
    $("#acAnswerWrap").classList.add("hidden");
    $("#keyHint").textContent = t("study.revealHint");
    $("#speakBtn").hidden = !(Store.settings.tts && "speechSynthesis" in window && card.type !== "occlusion");
    answerCard.classList.toggle("media-card", isMediaCard(card));
    // occlusion만 카드 박스를 없애고 이미지를 꽉 채운다. 기본 이미지 카드는 카드 안에 그대로.
    answerCard.classList.toggle("occ-card", card.type === "occlusion");
    renderFace($("#acQuestion"), card, false);
    showNotes(card, false);
    updateStudyStar();
    updateStudyRibbon();
    updateRepBadge(card);
    updateCardBunny();
  }

  // 카드 모서리에 앉아 있는 토끼 — 선택한 마스코트의 앉은 버전으로 표시
  function updateCardBunny() {
    const el = $("#cardBunny");
    if (!el) return;
    const v = bunnyVariant();
    const off = Store.settings.cardBunny === false;
    if (off || !bunnyHasSit(v)) { el.classList.add("hidden"); return; }
    el.style.backgroundImage = `url('${bunnySitURL(v)}')`;
    el.classList.remove("hidden");
  }

  // 이 카드를 지금 몇 회째 보고 있는지 캡슐로 표시 (지난 복습 횟수 + 이번)
  function updateRepBadge(card) {
    const el = $("#repBadge");
    if (!el) return;
    if (Store.settings.repBadge === false) { el.classList.add("hidden"); return; }
    const n = (card.views || 0) + 1;
    el.textContent = t("study.rep", { n });
    el.classList.remove("hidden");
  }

  // 학습 중인 카드의 질문/정답 면을 타입·공개상태에 맞게 다시 그린다.
  // (기본 카드의 질문면은 항상 '앞면'이어야 한다 — 공개 상태를 넘기면 정답으로 덮여버린다)
  function rerenderStudyFaces(card) {
    if (card.type === "basic") {
      renderFace($("#acQuestion"), card, false);
      if (session.revealed) renderFace($("#acAnswer"), card, true);
    } else {
      // cloze / occlusion: 질문면이 공개 상태를 반영
      renderFace($("#acQuestion"), card, session.revealed);
    }
    showNotes(card, session.revealed);
  }

  // 학습 중 현재 카드가 속한 장(섹션)을 상단 리본으로 보여줘 흐름의 위치를 알려준다
  function updateStudyRibbon() {
    const el = $("#studyRibbon");
    const card = session && session.current ? currentCard() : null;
    const sec = card ? (card.section || "").trim() : "";
    if (!card || !sec) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const deck = Store.getDeck(card.deckId);
    el.innerHTML =
      `<svg class="rib-ic" width="16" height="16"><use href="#i-book"/></svg>` +
      `<span class="rib-text">` +
        (deck ? `<span class="rib-deck">${escapeHTML(deck.name)}</span>` : "") +
        `<span class="rib-sec">${escapeHTML(sec)}</span>` +
      `</span>`;
    el.classList.remove("hidden");
  }

  // 답 공개 시 카드의 추가 설명(메모)을 보여준다
  function showNotes(card, revealed) {
    const el = $("#acNotes");
    const noteImg = card.noteImageId ? Store.getMedia(card.noteImageId) : null;
    const hasText = card.notes && card.notes.trim();
    if (revealed && (hasText || noteImg)) {
      let html = hasText ? `<div class="note-text">${sanitizeRichHTML(card.notes)}</div>` : "";
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

  // 카드 목록에서 개별 카드를 눌렀을 때: 앞·뒷면을 그대로 보여주는 읽기 전용 뷰어
  function openCardView(id) {
    const card = Store.state.cards.find(c => c.id === id);
    if (!card) return;
    renderFace($("#cardViewFront"), card, false); // 앞면(문제)
    renderFace($("#cardViewBack"), card, true);   // 뒷면(정답)

    const noteImg = card.noteImageId ? Store.getMedia(card.noteImageId) : null;
    const hasText = card.notes && card.notes.trim();
    const nEl = $("#cardViewNotes");
    if (hasText || noteImg) {
      let html = hasText ? `<div class="note-text">${sanitizeRichHTML(card.notes)}</div>` : "";
      if (noteImg) html += `<img class="note-img" src="${noteImg}" alt="">`;
      nEl.innerHTML = html;
      nEl.classList.remove("hidden");
    } else {
      nEl.classList.add("hidden");
      nEl.innerHTML = "";
    }

    // 이미지 가리기(occlusion)는 전용 편집기를 쓰므로 여기선 편집 버튼 숨김
    const editBtn = $("#cardViewEdit");
    editBtn.classList.toggle("hidden", card.type === "occlusion");
    editBtn.onclick = () => { $("#cardViewModal").close(); openCardModal(id); };

    $("#cardViewModal").showModal();
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
    $("#flipBackRow").classList.remove("hidden");
    $("#keyHint").textContent = t("study.keysHint");
  }

  // 정답을 접고 다시 문제만 보는 상태로(뒤집기) — 같은 카드를 다시 풀어볼 수 있다. 채점·일정 변화 없음.
  function unreveal() {
    if (!session || !session.current || !session.revealed) return;
    const card = currentCard();
    session.revealed = false;
    $("#acAnswerWrap").classList.add("hidden");
    renderFace($("#acQuestion"), card, false); // cloze/occlusion은 빈칸 상태로 복귀
    showNotes(card, false);
    ratingRow.classList.add("hidden");
    $("#flipBackRow").classList.add("hidden");
    $("#revealRow").classList.remove("hidden");
    $("#keyHint").textContent = t("study.revealHint");
  }

  function rate(rating) {
    if (!session || !session.revealed || !session.current) return;
    const id = session.current;
    const snapshot = Store.applyReview(id, rating);
    if (snapshot?.autoStarred) toast(t("study.autoStarred"));
    Social.pushStatsQuiet();
    if (rating === 0) session.again++; // 이번 세션 '다시' 누른 횟수 (완료 요약용)
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
    if (entry.rating === 0 && session.again > 0) session.again--;

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

  // 학습 중 별표 토글
  function updateStudyStar() {
    const card = session && session.current ? currentCard() : null;
    $("#btnStarStudyCard").classList.toggle("on", !!(card && card.starred));
  }
  $("#btnStarStudyCard").addEventListener("click", () => {
    if (!session || !session.current) return;
    const card = currentCard();
    Store.updateCard(card.id, { starred: !card.starred });
    updateStudyStar();
  });

  // 학습 중 현재 카드 삭제
  $("#btnDeleteStudyCard").addEventListener("click", () => {
    if (!session || !session.current) return;
    const id = session.current;
    confirmDialog(t("confirm.deleteCard"), t("confirm.deleteCardText"), () => {
      Store.deleteCard(id);
      session.current = null;
      session.main = session.main.filter(x => x !== id);
      session.learning = session.learning.filter(l => l.id !== id);
      session.history = session.history.filter(h => h.cardId !== id); // 삭제된 카드의 undo 항목 제거
      if (session.total > session.done) session.total--;
      $("#btnUndo").classList.toggle("hidden", !session.history.length);
      toast(t("toast.cardDeleted"));
      nextCard();
    });
  });

  answerCard.addEventListener("click", () => reveal());
  $("#btnReveal").addEventListener("click", () => reveal());
  $("#btnFlipBack").addEventListener("click", () => unreveal());
  $$(".rate-btn").forEach(b => b.addEventListener("click", () => rate(Number(b.dataset.rate))));

  /* ── TTS ── */
  // 음성 목록은 비동기로 로드되므로(크롬) 캐시하고 voiceschanged 때 갱신한다
  let ttsVoices = [];
  function loadTtsVoices() {
    try { ttsVoices = speechSynthesis.getVoices() || []; } catch { ttsVoices = []; }
  }
  if ("speechSynthesis" in window) {
    loadTtsVoices();
    try { speechSynthesis.addEventListener("voiceschanged", () => { loadTtsVoices(); try { renderTtsVoiceOptions(); } catch {} }); } catch {}
  }
  const ttsNorm = s => (s || "").toLowerCase().replace(/_/g, "-");
  function findVoiceById(id) {
    if (!id) return null;
    if (!ttsVoices.length) loadTtsVoices();
    return ttsVoices.find(v => v.voiceURI === id || v.name === id) || null;
  }

  // 같은 언어의 음성 중 가장 자연스러운(신경망·고품질) 것을 고른다
  const TTS_GOOD = /(neural|premium|enhanced|natural|siri|google|wavenet|multilingual|online|nuance)/i;
  const TTS_BAD = /(compact|eloquence|espeak|robot|novelty|lo-?fi)/i;
  function pickTtsVoice(lang) {
    if (!ttsVoices.length) loadTtsVoices();
    const base = lang.slice(0, 2).toLowerCase();
    const norm = s => (s || "").toLowerCase().replace(/_/g, "-");
    const cand = ttsVoices.filter(v => norm(v.lang).startsWith(base));
    if (!cand.length) return null;
    const score = v => {
      let s = 0;
      const n = `${v.name || ""} ${v.voiceURI || ""}`;
      if (TTS_GOOD.test(n)) s += 10;
      if (TTS_BAD.test(n)) s -= 8;
      if (v.localService === false) s += 4;      // 온라인 음성(크롬 구글 등)이 대체로 더 자연스러움
      if (norm(v.lang) === lang.toLowerCase()) s += 2; // 정확한 지역 매칭
      if (v.default) s += 1;
      return s;
    };
    return cand.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  // 설정에서 고른 목소리가 이 언어와 맞으면 그걸, 아니면 자동 선택
  function voiceForLang(lang) {
    const base = lang.slice(0, 2).toLowerCase();
    const pref = findVoiceById(Store.settings.ttsVoice);
    if (pref && ttsNorm(pref.lang).startsWith(base)) return pref;
    return pickTtsVoice(lang);
  }

  function speak(text, voiceOverride) {
    if (!("speechSynthesis" in window) || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[가-힣]/.test(text) ? "ko-KR" : "en-US";
    const v = voiceOverride || voiceForLang(u.lang);
    if (v) { u.voice = v; if (v.lang) u.lang = v.lang; }
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

  // ── 설정: 읽어주기 목소리 선택 ──
  function ttsVoiceLabel(v) {
    const base = (v.lang || "").slice(0, 2).toLowerCase();
    const flag = base === "ko" ? "🇰🇷 " : base === "en" ? "🇬🇧 " : "";
    return `${flag}${v.name} (${v.lang})`;
  }
  function renderTtsVoiceOptions() {
    const sel = $("#ttsVoiceSelect");
    if (!sel) return;
    if (!ttsVoices.length) loadTtsVoices();
    const list = ttsVoices
      .filter(v => { const b = (v.lang || "").slice(0, 2).toLowerCase(); return b === "ko" || b === "en"; })
      .sort((a, b) => (a.lang || "").localeCompare(b.lang || "") || (a.name || "").localeCompare(b.name || ""));
    const cur = Store.settings.ttsVoice || "";
    sel.innerHTML = `<option value="">${escapeHTML(t("tts.auto"))}</option>`
      + list.map(v => `<option value="${escapeHTML(v.voiceURI || v.name)}">${escapeHTML(ttsVoiceLabel(v))}</option>`).join("");
    sel.value = cur;
    if (sel.value !== cur) sel.value = ""; // 저장된 음성이 이 기기에 없으면 표시만 '자동'(설정값은 유지)
  }
  $("#ttsVoiceSelect")?.addEventListener("change", (e) => Store.setSetting("ttsVoice", e.target.value || ""));
  $("#ttsVoicePreview")?.addEventListener("click", () => {
    const uri = $("#ttsVoiceSelect")?.value || "";
    const v = uri ? findVoiceById(uri) : null;
    const base = v ? (v.lang || "").slice(0, 2).toLowerCase() : (Store.settings.lang === "en" ? "en" : "ko");
    speak(base === "en" ? t("tts.sampleEn") : t("tts.sampleKo"), v || undefined);
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
    if (e.code === "Backspace" || e.key === "0") { if (session?.revealed) { e.preventDefault(); unreveal(); } return; }
    if (["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key) - 1);
    if (e.key === "z" || e.key === "Z") undo();
    if (e.code === "Escape") quitStudy();
  });

  // 밀리초 → 사람이 읽는 짧은 기간(분·시간·일·개월·년)
  function fmtDuration(ms) {
    const DAY = 86400000;
    if (ms < 3600000) return t("iv.min", { n: Math.max(1, Math.round(ms / 60000)) });
    if (ms < DAY) return t("iv.hour", { n: Math.round(ms / 3600000) });
    const days = Math.round(ms / DAY);
    if (days < 30) return t("iv.day", { n: days });
    if (days < 365) return t("iv.month", { n: (days / 30).toFixed(1).replace(/\.0$/, "") });
    return t("iv.year", { n: (days / 365).toFixed(1).replace(/\.0$/, "") });
  }

  // 이번 학습 범위에서 다음 복습까지 남은 시간(가장 이른 예약 카드). 없으면 null
  function nextReviewMs() {
    const now = Date.now();
    const pool = session.global ? Store.state.cards : Store.cardsOf(currentDeckId);
    let min = Infinity;
    for (const c of pool) {
      if (c.suspended || SRS.isNew(c)) continue;
      if (c.due > now && c.due < min) min = c.due;
    }
    return min === Infinity ? null : min - now;
  }

  function finishSession() {
    $(".study-stage").classList.add("hidden");
    $("#studyRibbon").classList.add("hidden");
    ratingRow.classList.add("hidden");
    $("#keyHint").textContent = "";
    $("#sessionChips").innerHTML = "";
    $("#doneSummary").textContent = t("study.doneSub", { n: session.total });
    // 틀림 없이 마쳤으면 격려, 아니면 '다시' 횟수를 조용히 알려준다
    $("#doneStats").textContent = session.again > 0
      ? t("study.doneAgain", { n: session.again })
      : t("study.donePerfect");
    const next = nextReviewMs();
    $("#doneNext").textContent = next != null
      ? t("study.doneNext", { d: fmtDuration(next) })
      : t("study.doneNextNone");
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
    try { Social.setRoomStudying(false); } catch { /* 베스트에포트 */ }
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

    renderHeatmap();
  }

  function renderHeatmap() {
    const hm = $("#heatmap");
    const rev = Store.state.reviews;
    const cells = [];
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + (6 - end.getDay()));        // 이번 주 토요일까지(열 정렬)
    const WEEKS = 53;                                        // 약 1년치
    const start = new Date(end);
    start.setDate(start.getDate() - 7 * WEEKS + 1);

    const todayStr = Store.todayKey();
    const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ko" ? "ko-KR" : "en-US",
      { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = Store.todayKey(d.getTime());
      const count = rev[key] || 0;
      const future = d > now;
      let lvl = 0;
      if (count >= 1) lvl = 1;
      if (count >= 5) lvl = 2;
      if (count >= 15) lvl = 3;
      if (count >= 30) lvl = 4;
      const tip = future ? "" : t("stats.hmTip", { n: count, date: dateFmt.format(d) });
      cells.push(`<i class="hm l${lvl} ${key === todayStr ? "today" : ""}"
        style="${future ? "visibility:hidden" : ""}"
        data-tip="${tip}"></i>`);
    }
    hm.innerHTML = cells.join("");
    hm.scrollLeft = hm.scrollWidth;                          // 최근(오른쪽)이 보이게 스크롤

    // 요약 통계 (Anki 스타일): 전체 기록 기준
    const keys = Object.keys(rev).filter(k => (rev[k] || 0) > 0).sort();
    let avg = 0, learnedPct = 0, longest = 0;
    if (keys.length) {
      const first = new Date(keys[0] + "T00:00:00");
      let span = 0, learned = 0, run = 0, total = 0;
      for (const k of keys) total += rev[k] || 0;
      for (let d = new Date(first); d <= now; d.setDate(d.getDate() + 1)) {
        span++;
        if ((rev[Store.todayKey(d.getTime())] || 0) > 0) { run++; longest = Math.max(longest, run); learned++; }
        else run = 0;
      }
      span = Math.max(1, span);
      avg = Math.round(total / span);
      learnedPct = Math.min(100, Math.round((learned / span) * 100));
    }
    const current = Store.streak();
    const unit = t("stats.daysUnit");
    $("#hmSummary").innerHTML = `
      <div class="hm-stat"><b>${avg}</b><span>${t("stats.hmAvg")}</span></div>
      <div class="hm-stat"><b>${learnedPct}%</b><span>${t("stats.hmLearned")}</span></div>
      <div class="hm-stat"><b>${longest}${unit}</b><span>${t("stats.hmLongest")}</span></div>
      <div class="hm-stat"><b>${current}${unit}</b><span>${t("stats.hmCurrent")}</span></div>`;
  }

  // 히트맵 셀 호버 시 사진처럼 날짜·횟수가 뜨는 커스텀 툴팁
  (function initHeatmapTip() {
    const hm = $("#heatmap");
    if (!hm) return;
    let tipEl = null;
    const ensure = () => {
      if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "hm-tip"; tipEl.hidden = true; document.body.appendChild(tipEl); }
      return tipEl;
    };
    const show = (cell) => {
      const txt = cell.dataset.tip;
      if (!txt) return;
      const el = ensure();
      el.textContent = txt;
      el.hidden = false;
      const r = cell.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      let top = r.top - tr.height - 9;
      if (top < 6) top = r.bottom + 9;           // 위 공간 부족하면 아래로
      el.style.left = left + "px";
      el.style.top = top + "px";
    };
    const hide = () => { if (tipEl) tipEl.hidden = true; };
    hm.addEventListener("mouseover", (e) => { const c = e.target.closest(".hm[data-tip]"); if (c) show(c); });
    hm.addEventListener("mouseout", (e) => { if (e.target.closest(".hm")) hide(); });
    hm.addEventListener("mouseleave", hide);
    hm.addEventListener("scroll", hide, { passive: true });
    // 모바일 탭 지원
    hm.addEventListener("click", (e) => { const c = e.target.closest(".hm[data-tip]"); if (c) { show(c); setTimeout(hide, 1600); } });
  })();

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

  // 이미 공개한 덱들을 전부 다시 올린다 → 소제목(장)·과목 문서가 공유본에 반영됨
  $("#btnResyncShared").addEventListener("click", async () => {
    if (!Social.profile) { toast(t("share.needLogin")); return; }
    const decks = Store.state.decks.filter(d => d.sharedId);
    if (!decks.length) { toast(t("set.resyncNone")); return; }
    const btn = $("#btnResyncShared");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = t("set.resyncing");
    let ok = 0;
    for (const deck of decks) {
      try {
        const { sharedId } = await Social.publishDeck(deck, Store.cardsOf(deck.id), deck.visibility || "public");
        Store.patchDeck(deck.id, { sharedId });
        ok++;
      } catch { /* 개별 실패는 건너뛴다 */ }
    }
    btn.disabled = false; btn.textContent = orig;
    toast(t("set.resyncDone", { n: ok }));
  });
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
    applyTheme();
    I18N.apply();
    $$("#langSeg .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.lang === Store.settings.lang));
    $$("#appearanceSeg .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.appearance === (Store.settings.appearance || "auto")));
    $$("#themeGrid .theme-swatch").forEach(b => b.classList.toggle("active", b.dataset.theme === Store.settings.theme));
    $("#ttsToggle").checked = !!Store.settings.tts;
    $("#repBadgeToggle").checked = Store.settings.repBadge !== false;
    $("#cardBunnyToggle").checked = Store.settings.cardBunny !== false;
    $("#autoStarToggle").checked = !!Store.settings.autoStar;
    $("#autoStarCount").value = Store.settings.autoStarCount || 5;
    $("#autoStarCountRow").classList.toggle("hidden", !Store.settings.autoStar);
    renderTtsVoiceOptions();
    $("#ttsVoiceRow").classList.toggle("hidden", !Store.settings.tts);
    renderBunnyPicker();
    applyBunnies();
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

  $$("#appearanceSeg .seg-btn").forEach(b => b.addEventListener("click", () => {
    Store.setSetting("appearance", b.dataset.appearance);
    applySettingsToUI();
    refreshCurrentView();
  }));

  $$("#themeGrid .theme-swatch").forEach(b => b.addEventListener("click", () => {
    Store.setSetting("theme", b.dataset.theme);
    applySettingsToUI();
    refreshCurrentView();
  }));

  $("#ttsToggle").addEventListener("change", (e) => {
    Store.setSetting("tts", e.target.checked);
    $("#ttsVoiceRow").classList.toggle("hidden", !e.target.checked);
  });

  $("#repBadgeToggle").addEventListener("change", (e) => {
    Store.setSetting("repBadge", e.target.checked);
    // 학습 중이면 즉시 반영
    if (session && session.current) updateRepBadge(currentCard());
  });

  $("#cardBunnyToggle").addEventListener("change", (e) => {
    Store.setSetting("cardBunny", e.target.checked);
    updateCardBunny();
  });

  $("#autoStarToggle").addEventListener("change", (e) => {
    Store.setSetting("autoStar", e.target.checked);
    $("#autoStarCountRow").classList.toggle("hidden", !e.target.checked);
  });
  $("#autoStarCount").addEventListener("change", (e) => {
    const n = Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 0)));
    e.target.value = n;
    Store.setSetting("autoStarCount", n);
  });

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
    try { Social.leaveRoom(); } catch { /* 스터디룸 정리 */ }
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
        <li class="friend-item" data-id="${f.id}" data-name="${escapeHTML(f.username || "?")}">
          <button type="button" class="friend-row friend-row-btn">
            <span class="friend-avatar">${escapeHTML((f.username || "?")[0])}</span>
            <span class="fr-name">${escapeHTML(f.username || "?")}</span>
            <span class="fr-meta">
              <span class="pill new">${t("fr.today", { n: st.today })}</span>
              <span class="pill due">${t("fr.streakN", { n: st.streak })}</span>
            </span>
            <svg class="friend-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="friend-panel hidden">
            <div class="friend-decks"></div>
            <button type="button" class="friend-remove">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              ${t("fr.remove")}
            </button>
          </div>
        </li>`;
    }).join("");

    list.querySelectorAll(".friend-item").forEach(item => {
      const btn = item.querySelector(".friend-row-btn");
      const panel = item.querySelector(".friend-panel");
      const box = item.querySelector(".friend-decks");
      btn.addEventListener("click", () => {
        const open = !panel.classList.contains("hidden");
        if (open) { panel.classList.add("hidden"); item.classList.remove("open"); return; }
        item.classList.add("open");
        panel.classList.remove("hidden");
        if (!box.dataset.loaded) loadFriendDecks(item.dataset.id, box);
      });
      item.querySelector(".friend-remove").addEventListener("click", () => {
        const name = item.dataset.name;
        confirmDialog(t("fr.removeTitle", { name }), t("fr.removeText"), async () => {
          try {
            await Social.removeFriend(item.dataset.id);
            friendIdsCache = null; // explore 친구 필터 캐시 무효화
            toast(t("fr.removed"));
            renderFriendsPanel();
          } catch {
            toast(t("fr.offline"));
          }
        }, t("fr.remove"));
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
          const { deck, count, docCount } = await Social.downloadDeck(btn.closest(".friend-deck-row").dataset.id);
          toast(docCount ? t("explore.gotDocs", { name: deck.name, n: count, d: docCount }) : t("explore.got", { name: deck.name, n: count }));
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
    const rowHTML = r => `
      <li class="xp-row" data-id="${r.id}">
        <div class="xp-row-body">
          <div class="xp-row-title">${escapeHTML(r.name)}</div>
          ${r.description ? `<div class="xp-row-desc">${escapeHTML(r.description)}</div>` : ""}
          <div class="xp-row-meta">
            <span>${t("explore.cards", { n: r.cardCount })}</span>
            <span class="xp-dot">·</span>
            <span>${t("explore.downloads", { n: r.downloads })}</span>
            <span class="xp-dot">·</span>
            <span class="xp-by">${escapeHTML(r.author || "?")}</span>
          </div>
        </div>
        <button class="btn secondary sm get xp-get">${t("explore.get")}</button>
      </li>`;

    // 과목(subject)별로 묶는다 — 과목 없는 덱은 '미분류'로 맨 아래
    const NO_SUB = "\u0000";
    const groups = new Map();
    const order = [];
    results.forEach(r => {
      const s = (r.subject || "").trim() || NO_SUB;
      if (!groups.has(s)) { groups.set(s, []); order.push(s); }
      groups.get(s).push(r);
    });
    order.sort((a, b) => a === NO_SUB ? 1 : b === NO_SUB ? -1 : a.localeCompare(b, "ko"));
    const showHeads = order.length > 1 || order[0] !== NO_SUB; // 과목이 실제로 있을 때만 헤더
    list.innerHTML = order.map(s => {
      const rows = groups.get(s);
      const head = showHeads
        ? `<li class="xp-head"><span class="xp-head-name">${s === NO_SUB ? t("docs.noSubject") : escapeHTML(s)}</span><span class="xp-head-n">${rows.length}</span></li>`
        : "";
      return head + rows.map(rowHTML).join("");
    }).join("");

    list.querySelectorAll(".xp-row .get").forEach(btn =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const { deck, count, docCount } = await Social.downloadDeck(btn.closest(".xp-row").dataset.id);
          toast(docCount ? t("explore.gotDocs", { name: deck.name, n: count, d: docCount }) : t("explore.got", { name: deck.name, n: count }));
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

    Store.setOnSave(() => { Social.schedulePush(); Social.scheduleSharedResync(); });
    // 다른 기기의 변경을 받아 반영하면(앱 복귀 시) 현재 화면을 다시 그린다
    Social.setOnRemoteUpdate(() => { applySettingsToUI(); refreshCurrentView(); });
    try {
      const r = await Social.syncOnLogin();
      if (r && r.pulled) applySettingsToUI(); // 서버본 채택 시 언어·테마 반영
    } catch { /* 오프라인이어도 로컬 데이터로 진입 */ }

    document.body.classList.remove("pre-auth");
    I18N.apply();
    show("home");
    Reminders.start(); // 로그인·동기화 후 학습 알림 예약 (설정 켜져 있을 때만)
    try { Social.joinRoom(); } catch { /* 스터디룸은 베스트에포트 */ }

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
      rerenderStudyFaces(currentCard());
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
    // 새 배포가 뜨면 자동으로 최신 버전으로 갱신한다.
    // 이미 SW가 제어 중이던 페이지에서만(= 재방문/업데이트) 새 SW 활성화 시 새로고침 → 첫 방문엔 불필요한 리로드 없음.
    const hadController = !!navigator.serviceWorker.controller;
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swRefreshing || !hadController) return;
      swRefreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.update?.();
      // 주기적으로 + 앱이 다시 보일 때 새 버전 확인 (설치형 PWA가 재개될 때도 갱신)
      setInterval(() => reg.update?.(), 120 * 1000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update?.(); });
    }).catch(() => {});
  }
})();
