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

  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  // 텍스트 Q/A 쌍으로 변환 가능한 카드만 (일시정지 제외)
  function pool(deckId) {
    return Store.cardsOf(deckId)
      .filter(c => !c.suspended)
      .map(c => {
        if (c.type === "basic") return { q: c.front, a: c.back };
        if (c.type === "cloze") {
          let answer = null;
          const q = c.front.replace(CLOZE_RE, (_, i, ans) => {
            if (Number(i) === c.clozeIndex) { answer = ans; return "＿＿＿"; }
            return ans;
          });
          return answer ? { q, a: answer } : null;
        }
        return null; // occlusion은 연습 모드 제외
      })
      .filter(Boolean);
  }

  let onExit = null; // 종료 시 복귀 콜백 (덱 화면으로)

  /* ══════════ 퀴즈 (객관식) ══════════ */
  let quiz = null; // { items:[{q,a,options}], i, correct }

  function startQuiz(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 2) return false;
    onExit = exit;
    const answers = p.map(x => x.a);
    const items = shuffle(p).slice(0, 20).map(item => {
      const wrong = shuffle(answers.filter(a => a !== item.a)).slice(0, 3);
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
  let write = null; // { items, i, correct, revealed }

  const normalize = (s) => s.toLowerCase()
    .replace(/[.,!?;:'"“”‘’()\[\]{}~\-–—·]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  function startWrite(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 1) return false;
    onExit = exit;
    write = { items: shuffle(p).slice(0, 20), i: 0, correct: 0, revealed: false };
    $("#writeDone").classList.add("hidden");
    $("#writeBody").classList.remove("hidden");
    renderWrite();
    return true;
  }

  function renderWrite() {
    const { items, i } = write;
    write.revealed = false;
    $("#writeProgress").textContent = `${i + 1} / ${items.length}`;
    $("#writeBar").style.width = `${(i / items.length) * 100}%`;
    $("#writeQuestion").textContent = items[i].q;
    $("#writeFeedback").innerHTML = "";
    $("#writeInput").value = "";
    $("#writeInput").disabled = false;
    $("#writeCheck").classList.remove("hidden");
    $("#writeDontKnow").classList.remove("hidden");
    $("#writeNext").classList.add("hidden");
    $("#writeInput").focus();
  }

  function checkWrite(gaveUp = false) {
    if (write.revealed) return;
    write.revealed = true;
    const item = write.items[write.i];
    const ok = !gaveUp && normalize($("#writeInput").value) === normalize(item.a);
    if (ok) write.correct++;
    $("#writeInput").disabled = true;
    $("#writeFeedback").innerHTML = ok
      ? `<span class="wf ok">${t("write.correct")}</span>`
      : `<span class="wf no">${t("write.wrongWas", { a: esc(item.a) })}</span>`;
    $("#writeCheck").classList.add("hidden");
    $("#writeDontKnow").classList.add("hidden");
    $("#writeNext").classList.remove("hidden");
    $("#writeNext").focus();
  }

  function nextWrite() {
    write.i++;
    if (write.i >= write.items.length) {
      const pct = Math.round((write.correct / write.items.length) * 100);
      $("#writeBar").style.width = "100%";
      $("#writeBody").classList.add("hidden");
      $("#writeDone").classList.remove("hidden");
      $("#writeScore").textContent = t("quiz.score", { c: write.correct, n: write.items.length, pct });
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
    $("#writeNext").addEventListener("click", nextWrite);
    $("#writeInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); write?.revealed ? nextWrite() : checkWrite(false); }
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
