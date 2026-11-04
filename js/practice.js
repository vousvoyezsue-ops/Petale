/* ═══════════════════════════════════════════════════════
   Petale Practice — 퀴즐렛 스타일 연습 모드
   퀴즈(객관식) · 쓰기(주관식) · 매치(짝 맞추기 타임어택)
   연습 모드는 SRS 스케줄에 영향을 주지 않는다.
   ═══════════════════════════════════════════════════════ */

const Practice = (() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);

  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 카드 앞/뒷면은 서식이 들어간 리치 HTML로 저장된다. 연습 모드(쓰기·퀴즈·매치)는
  // 평문으로 다뤄야 화면에 태그가 그대로 노출되지 않고, 정답 대조도 정확해진다.
  const htmlToText = (html) => {
    const tmp = String(html || "").replace(/<(?:br|\/p|\/div|\/li)\s*\/?>/gi, " ");
    const d = document.createElement("div");
    d.innerHTML = tmp;
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  };

  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  // 텍스트 Q/A 쌍으로 변환 가능한 카드만 (일시정지 제외)
  function pool(deckId) {
    return Store.cardsOf(deckId)
      .filter(c => !c.suspended)
      .map(c => {
        if (c.type === "basic") return { q: htmlToText(c.front), a: htmlToText(c.back) };
        if (c.type === "cloze") {
          let answer = null;
          const q = c.front.replace(CLOZE_RE, (_, i, ans) => {
            if (Number(i) === c.clozeIndex) { answer = ans; return "＿＿＿"; }
            return ans;
          });
          return answer ? { q: htmlToText(q), a: htmlToText(answer) } : null;
        }
        return null; // occlusion은 연습 모드 제외
      })
      .filter(Boolean);
  }

  let onExit = null; // 종료 시 복귀 콜백 (덱 화면으로)

  /* ══════════ 퀴즈 (객관식) ══════════ */
  let quiz = null; // { items:[{q,a,options}], i, correct }

  // 두 답의 유사도(0~1): 문자 바이그램 겹침 + 길이 근접도.
  // 정답과 비슷한 오답을 골라 선택지가 너무 뻔해지지 않게 한다.
  function similarity(a, b) {
    a = String(a).toLowerCase(); b = String(b).toLowerCase();
    const bigrams = (s) => {
      const t = "  " + s + "  ", set = new Set();
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
      return set;
    };
    const ga = bigrams(a), gb = bigrams(b);
    let inter = 0; ga.forEach(x => { if (gb.has(x)) inter++; });
    const jac = inter / (ga.size + gb.size - inter || 1);
    const lenClose = 1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1);
    return jac * 0.7 + lenClose * 0.3;
  }

  // 정답과 가장 비슷한 후보군에서 무작위로 오답 n개를 뽑는다(변별력 + 매번 다른 조합)
  function pickDistractors(correct, answers, n = 3) {
    const others = answers.filter(a => a !== correct);
    if (others.length <= n) return shuffle(others);
    const ranked = others
      .map(a => [similarity(a, correct), a])
      .sort((x, y) => y[0] - x[0])
      .map(r => r[1]);
    const poolSize = Math.min(others.length, Math.max(n + 3, 6));
    return shuffle(ranked.slice(0, poolSize)).slice(0, n);
  }

  function startQuiz(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 2) return false;
    onExit = exit;
    const answers = [...new Set(p.map(x => x.a))]; // 중복 정답 제거
    const items = shuffle(p).slice(0, 20).map(item => {
      const wrong = pickDistractors(item.a, answers);
      return { ...item, options: shuffle([item.a, ...wrong]) };
    });
    quiz = { items, i: 0, correct: 0, locked: false };
    $("#quizDone").classList.add("hidden");
    $("#quizBody").classList.remove("hidden");
    renderQuiz();
    return true;
  }

  function renderQuiz() {
    const { items, i } = quiz;
    $("#quizProgress").textContent = `${i + 1} / ${items.length}`;
    $("#quizBar").style.width = `${(i / items.length) * 100}%`;
    $("#quizQuestion").textContent = items[i].q;
    quiz.locked = false;
    $("#quizOptions").innerHTML = items[i].options.map(o =>
      `<button class="quiz-opt" data-a="${esc(o)}">${esc(o)}</button>`).join("");
    $("#quizOptions").querySelectorAll(".quiz-opt").forEach(btn =>
      btn.addEventListener("click", () => pickOption(btn)));
  }

  function pickOption(btn) {
    if (quiz.locked) return;
    quiz.locked = true;
    const item = quiz.items[quiz.i];
    const chosen = btn.dataset.a;
    const ok = chosen === item.a;
    if (ok) quiz.correct++;
    btn.classList.add(ok ? "correct" : "wrong");
    if (!ok) {
      $$("#quizOptions .quiz-opt").forEach(b => {
        if (b.dataset.a === item.a) b.classList.add("correct");
      });
    }
    setTimeout(() => {
      quiz.i++;
      if (quiz.i >= quiz.items.length) finishQuiz();
      else renderQuiz();
    }, ok ? 550 : 1300);
  }

  function finishQuiz() {
    const { correct, items } = quiz;
    const pct = Math.round((correct / items.length) * 100);
    $("#quizBar").style.width = "100%";
    $("#quizBody").classList.add("hidden");
    $("#quizDone").classList.remove("hidden");
    $("#quizScore").textContent = t("quiz.score", { c: correct, n: items.length, pct });
  }

  /* ══════════ 쓰기 (주관식) ══════════ */
  let write = null; // { queue, total, misses, current, revealed, lastOk, markedCorrect }

  const normalize = (s) => s.toLowerCase()
    .replace(/[.,!?;:'"“”‘’()\[\]{}~\-–—·]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 퀴즐렛 Write 방식: 덱의 모든 카드를 직접 입력해 맞혀야 끝난다.
  // 틀린 카드는 큐 뒤쪽에 다시 들어가 반드시 다시 풀게 되고, 전부 맞혀야(큐가 비어야) 완료.
  const WRITE_TARGET = 2; // 통과하려면 '연속' 정답 횟수 (동그라미 개수와 동일)

  function startWrite(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 1) return false;
    onExit = exit;
    const items = shuffle(p);
    items.forEach(it => it.hits = 0);  // 카드별 연속 정답 수
    write = { queue: items.slice(), total: items.length, misses: 0, current: null, revealed: false, lastOk: false, markedCorrect: false };
    $("#writeDone").classList.add("hidden");
    $("#writeBody").classList.remove("hidden");
    renderWrite();
    return true;
  }

  function writeMastered() { return write.total - write.queue.length; }

  // 연속 정답 진행 동그라미 — 현재 카드의 hits 만큼 녹색으로 채움
  function paintDots() {
    const n = write.current.hits || 0;
    $$("#writeDots .wd").forEach((d, i) => { d.classList.remove("miss", "pop"); d.classList.toggle("on", i < n); });
  }
  function dotsCorrect() {   // 정답: hits(증가 전) 인덱스까지 채우고 마지막 동그라미 팝
    const n = write.current.hits || 0, dots = $$("#writeDots .wd");
    dots.forEach((d, i) => { d.classList.remove("miss"); d.classList.toggle("on", i <= n); });
    const last = dots[Math.min(n, dots.length - 1)];
    if (last) { last.classList.add("pop"); setTimeout(() => last.classList.remove("pop"), 340); }
  }
  function dotsMiss() {      // 오답: 분홍으로 깜빡였다가 빈 동그라미로
    const dots = $$("#writeDots .wd");
    dots.forEach(d => { d.classList.remove("on"); d.classList.add("miss"); });
    setTimeout(() => dots.forEach(d => d.classList.remove("miss")), 640);
  }

  function renderWrite() {
    write.current = write.queue[0];
    write.revealed = false;
    write.lastOk = false;
    write.markedCorrect = false;
    write.retyping = false;
    const done = writeMastered();
    $("#writeProgress").textContent = `${done} / ${write.total}`;
    $("#writeBar").style.width = `${(done / write.total) * 100}%`;
    $("#writeQuestion").textContent = write.current.q;
    $("#writeFeedback").innerHTML = "";
    $("#writeInput").value = "";
    $("#writeInput").disabled = false;
    $("#writeCheck").classList.remove("hidden");
    $("#writeDontKnow").classList.remove("hidden");
    $("#writeNext").classList.add("hidden");
    $("#writeMarkCorrect").classList.add("hidden");
    paintDots();
    $("#writeInput").focus();
  }

  function checkWrite(gaveUp = false) {
    if (write.revealed) return;
    write.revealed = true;
    const item = write.current;
    const ok = !gaveUp && normalize($("#writeInput").value) === normalize(item.a);
    write.lastOk = ok;
    $("#writeCheck").classList.add("hidden");
    $("#writeDontKnow").classList.add("hidden");
    if (ok) {
      dotsCorrect();
      write.retyping = false;
      $("#writeInput").disabled = true;
      $("#writeFeedback").innerHTML = `<span class="wf ok">${t("write.correct")}</span>`;
      $("#writeMarkCorrect").classList.add("hidden");
      $("#writeNext").classList.remove("hidden");
      $("#writeNext").focus();
    } else {
      // 틀리면 정답을 직접 입력(그대로 쓰기)해야 넘어갈 수 있다
      write.misses++;
      dotsMiss();
      write.retyping = true;
      $("#writeFeedback").innerHTML =
        `<span class="wf no">${t("write.wrongWas", { a: esc(item.a) })}</span>` +
        `<span class="wf retype">${t("write.retypeHint")}</span>`;
      $("#writeInput").value = "";
      $("#writeInput").disabled = false;
      $("#writeMarkCorrect").classList.remove("hidden"); // 오탐 구제(동의어·오타)
      $("#writeNext").classList.add("hidden");           // 정답을 쓰기 전엔 숨김
      $("#writeInput").focus();
    }
  }

  // 틀린 뒤 정답을 그대로 입력하면 통과시켜 '다음'을 연다 (맞을 때까지 쓰기)
  function onWriteInput() {
    if (!write || !write.revealed || !write.retyping) return;
    if (normalize($("#writeInput").value) === normalize(write.current.a)) {
      write.retyping = false;
      $("#writeInput").disabled = true;
      $("#writeMarkCorrect").classList.add("hidden");
      $("#writeFeedback").innerHTML = `<span class="wf ok">${t("write.retypeOk")}</span>`;
      $("#writeNext").classList.remove("hidden");
      $("#writeNext").focus();
    }
  }

  // 사용자가 직접 정답으로 인정 (자동 채점 오탐 구제). 한 문항당 한 번만 반영
  function markCorrect() {
    if (!write || !write.revealed || write.markedCorrect) return;
    write.markedCorrect = true;
    write.lastOk = true;
    write.retyping = false;
    if (write.misses > 0) write.misses--; // 방금 집계한 오답 취소
    $("#writeInput").disabled = true;
    $("#writeFeedback").innerHTML = `<span class="wf ok">${t("write.correct")}</span>`;
    dotsCorrect();
    $("#writeMarkCorrect").classList.add("hidden");
    $("#writeNext").classList.remove("hidden");
    $("#writeNext").focus();
  }

  function nextWrite() {
    const cur = write.queue.shift();          // 현재 카드 큐에서 빼기
    cur.hits = write.lastOk ? (cur.hits || 0) + 1 : 0;   // 연속: 틀리면 0으로 리셋
    if (cur.hits < WRITE_TARGET) {            // 연속 목표 미달 → 다시 넣어 재출제
      // 틀린 카드는 금방 다시(바로 다음다음), 1번 맞힌 카드는 약간 간격 두고
      const pos = write.lastOk ? Math.min(write.queue.length, 3) : Math.min(write.queue.length, 1);
      write.queue.splice(pos, 0, cur);
    }
    if (write.queue.length === 0) {
      $("#writeBar").style.width = "100%";
      $("#writeBody").classList.add("hidden");
      $("#writeDone").classList.remove("hidden");
      $("#writeScore").textContent = t("write.doneSummary", { n: write.total, m: write.misses });
    } else {
      renderWrite();
    }
  }

  /* ══════════ 매치 (짝 맞추기) ══════════ */
  let match = null; // { deckId, tiles, chosen, remaining, timer, t0 }

  function startMatch(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 3) return false;
    onExit = exit;
    const pairs = shuffle(p).slice(0, 6);
    const tiles = shuffle(pairs.flatMap((pair, i) => [
      { id: i, text: pair.q },
      { id: i, text: pair.a },
    ]));
    match = { deckId, tiles, chosen: null, remaining: pairs.length, t0: performance.now(), timer: null };
    $("#matchDone").classList.add("hidden");
    $("#matchBody").classList.remove("hidden");
    renderMatchGrid();
    clearInterval(match.timer);
    match.timer = setInterval(() => {
      $("#matchTime").textContent = t("match.time", { s: ((performance.now() - match.t0) / 1000).toFixed(1) });
    }, 100);
    const best = Store.getDeck(deckId)?.matchBest;
    $("#matchBest").textContent = best ? t("match.best", { s: best.toFixed(1) }) : "";
    return true;
  }

  function renderMatchGrid() {
    $("#matchGrid").innerHTML = match.tiles.map((tile, idx) =>
      `<button class="match-tile" data-idx="${idx}">${esc(tile.text)}</button>`).join("");
    $("#matchGrid").querySelectorAll(".match-tile").forEach(el =>
      el.addEventListener("click", () => pickTile(el)));
  }

  function pickTile(el) {
    if (el.classList.contains("cleared") || el.classList.contains("selected")) return;
    const idx = Number(el.dataset.idx);
    if (match.chosen == null) {
      match.chosen = idx;
      el.classList.add("selected");
      return;
    }
    const prevEl = $(`#matchGrid .match-tile[data-idx="${match.chosen}"]`);
    const a = match.tiles[match.chosen];
    const b = match.tiles[idx];
    match.chosen = null;
    if (a.id === b.id) {
      [prevEl, el].forEach(x => { x.classList.remove("selected"); x.classList.add("cleared"); });
      match.remaining--;
      if (!match.remaining) finishMatch();
    } else {
      el.classList.add("shake");
      prevEl.classList.add("shake");
      prevEl.classList.remove("selected");
      setTimeout(() => $$("#matchGrid .shake").forEach(x => x.classList.remove("shake")), 450);
    }
  }

  function finishMatch() {
    clearInterval(match.timer);
    const secs = (performance.now() - match.t0) / 1000;
    const deck = Store.getDeck(match.deckId);
    let isBest = false;
    if (deck && (!deck.matchBest || secs < deck.matchBest)) {
      deck.matchBest = Math.round(secs * 10) / 10;
      Store.save();
      isBest = true;
    }
    $("#matchBody").classList.add("hidden");
    $("#matchDone").classList.remove("hidden");
    $("#matchResult").textContent = t("match.time", { s: secs.toFixed(1) });
    $("#matchNewBest").textContent = isBest ? t("match.newBest") : "";
  }

  function stopMatchTimer() { if (match) clearInterval(match.timer); }

  function exit() {
    stopMatchTimer();
    quiz = write = match = null;
    onExit?.();
  }

  /* ── 바인딩 (한 번만) ── */
  function bind() {
    $$("[data-practice-exit]").forEach(b => b.addEventListener("click", exit));
    $("#writeCheck").addEventListener("click", () => checkWrite(false));
    $("#writeDontKnow").addEventListener("click", () => checkWrite(true));
    $("#writeMarkCorrect").addEventListener("click", markCorrect);
    $("#writeNext").addEventListener("click", nextWrite);
    $("#writeInput").addEventListener("input", onWriteInput);
    $("#writeInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!write) return;
      if (!write.revealed) checkWrite(false);        // 채점
      else if (!write.retyping) nextWrite();          // 다음 (정답 쓰기 중엔 Enter 무시)
    });
    $("#quizRetry").addEventListener("click", () => {
      const deckId = currentPracticeDeck;
      startQuiz(deckId, onExit);
    });
    $("#writeRetry").addEventListener("click", () => startWrite(currentPracticeDeck, onExit));
    $("#matchRetry").addEventListener("click", () => startMatch(currentPracticeDeck, onExit));
  }

  let currentPracticeDeck = null;
  function setDeck(id) { currentPracticeDeck = id; }

  return { startQuiz, startWrite, startMatch, bind, setDeck, exit, stopMatchTimer };
})();
