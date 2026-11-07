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
  // HTML을 '구조를 살린' 텍스트로 변환 — 표는 「셀 | 셀」 줄로, 리스트는 「• 항목」 줄로,
  // 문단·줄바꿈은 개행으로 유지한다. (pre-wrap으로 그대로 보여주면 표·불렛이 안 깨진다)
  const htmlToText = (html) => {
    const s = String(html || "")
      .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "\n• ")
      .replace(/<\/\s*(td|th)\s*>\s*<\s*(td|th)[^>]*>/gi, " | ")
      .replace(/<\/\s*(p|div|h[1-6]|tr|li|blockquote|ul|ol|table|thead|tbody)\s*>/gi, "\n");
    const d = document.createElement("div");
    d.innerHTML = s;
    return (d.textContent || "")
      .replace(/[ \t ]+/g, " ")   // 가로 공백만 정리(개행은 보존)
      .replace(/ *\n */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  };

  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  // 텍스트 Q/A 쌍으로 변환 가능한 카드만 (일시정지 제외)
  function pool(deckId) {
    return Store.cardsOf(deckId)
      .filter(c => !c.suspended)
      .map(c => {
        if (c.type === "basic") return { id: c.id, q: htmlToText(c.front), a: htmlToText(c.back) };
        if (c.type === "cloze") {
          let answer = null;
          const q = c.front.replace(CLOZE_RE, (_, i, ans) => {
            if (Number(i) === c.clozeIndex) { answer = ans; return "＿＿＿"; }
            return ans;
          });
          return answer ? { id: c.id, q: htmlToText(q), a: htmlToText(answer) } : null;
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
    $("#quizQuestion").classList.toggle("rich", items[i].q.includes("\n"));
    quiz.locked = false;
    $("#quizOptions").innerHTML = items[i].options.map(o =>
      `<button class="quiz-opt${o.includes("\n") ? " rich" : ""}" data-a="${esc(o)}">${esc(o)}</button>`).join("");
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

  // ── 진행 상황 저장/이어하기 (덱별, 로컬 전용) ──
  let writeDeckId = null;
  const WKEY = id => "petale.write." + id;
  function saveWrite() {
    if (!write || !writeDeckId) return;
    try {
      if (!write.queue.length) { localStorage.removeItem(WKEY(writeDeckId)); return; }
      localStorage.setItem(WKEY(writeDeckId), JSON.stringify({
        total: write.total, misses: write.misses,
        queue: write.queue.map(c => ({ id: c.id, q: c.q, a: c.a, hits: c.hits || 0 })),
      }));
    } catch { /* 저장소 접근 불가 시 무시 */ }
  }
  function loadWrite(deckId) {
    try {
      const d = JSON.parse(localStorage.getItem(WKEY(deckId)) || "null");
      return (d && Array.isArray(d.queue) && d.queue.length) ? d : null;
    } catch { return null; }
  }
  function clearWrite(deckId) { try { localStorage.removeItem(WKEY(deckId)); } catch {} }

  function startWrite(deckId, exit, { fresh = false } = {}) {
    const p = pool(deckId);
    if (p.length < 1) return false;
    onExit = exit;
    writeDeckId = deckId;
    // 저장된 진행을 '현재 카드 내용' 기준으로 복원 — 카드 id로 최신 q/a를 다시 읽어
    // 수정·삭제가 바로 반영된다 (삭제된 카드는 제외, 진행 수 hits는 유지).
    // id가 없는 구버전 저장은 질문 텍스트로 매칭해 이어가서 기존 진행을 잃지 않는다.
    const byId = new Map(p.map(it => [it.id, it]));
    const byQ = new Map(p.map(it => [it.q, it]));
    const saved = fresh ? null : loadWrite(deckId);
    let queue = null;
    if (saved) {
      const restored = saved.queue
        .map(c => {
          const cur = (c.id != null && byId.get(c.id)) || byQ.get(c.q);
          return cur ? { id: cur.id, q: cur.q, a: cur.a, hits: c.hits || 0 } : null;
        })
        .filter(Boolean);
      if (restored.length) queue = restored;  // 복원할 게 남아있을 때만 이어하기
    }
    if (queue) {   // 이어하기
      write = { queue, total: saved.total || queue.length, misses: saved.misses || 0, current: null, revealed: false, lastOk: false, markedCorrect: false };
    } else {       // 새로 시작
      const items = shuffle(p);
      items.forEach(it => it.hits = 0);  // 카드별 연속 정답 수
      write = { queue: items.slice(), total: items.length, misses: 0, current: null, revealed: false, lastOk: false, markedCorrect: false };
    }
    $("#writeDone").classList.add("hidden");
    $("#writeBody").classList.remove("hidden");
    renderWrite();
    return true;
  }

  // 진행 수 = '통과(패스)' 횟수 기준 — 한번 통과한 것도 1로 세고, 복습(2번째 통과)까지 포함.
  // 카드마다 WRITE_TARGET 패스 필요 → 전체 필요 패스 = total × TARGET, 완료 시 딱 꽉 참.
  function writePasses() {
    const mastered = write.total - write.queue.length;      // 2연속 끝난 카드 = TARGET 패스
    let partial = 0;
    for (const c of write.queue) partial += Math.min(c.hits || 0, WRITE_TARGET);
    return mastered * WRITE_TARGET + partial;
  }
  function writeNeeded() { return write.total * WRITE_TARGET; }

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
    const done = writePasses(), need = writeNeeded();
    $("#writeProgress").textContent = `${done} / ${need}`;
    $("#writeBar").style.width = `${(done / need) * 100}%`;
    $("#writeQuestion").textContent = write.current.q;
    $("#writeQuestion").classList.toggle("rich", write.current.q.includes("\n"));
    $("#writeFeedback").innerHTML = "";
    $("#writeWrong").innerHTML = "";
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
    const typed = $("#writeInput").value;   // 사용자가 쓴 답
    const ok = !gaveUp && normalize(typed) === normalize(item.a);
    write.lastOk = ok;
    $("#writeCheck").classList.add("hidden");
    $("#writeDontKnow").classList.add("hidden");
    if (ok) {
      dotsCorrect();
      write.retyping = false;
      $("#writeInput").disabled = true;
      $("#writeWrong").innerHTML = "";
      $("#writeFeedback").innerHTML = `<span class="wf ok">${t("write.correct")}</span>`;
      $("#writeMarkCorrect").classList.add("hidden");
      $("#writeNext").classList.add("hidden");
      scheduleAutoNext();   // 맞으면 자동으로 다음 카드
    } else {
      // 틀리면 정답을 직접 입력(그대로 쓰기)해야 넘어갈 수 있다
      write.misses++;
      dotsMiss();
      write.retyping = true;
      $("#writeFeedback").innerHTML =
        `<span class="wf no">${t("write.wrongWas", { a: esc(item.a) })}</span>` +
        `<span class="wf retype">${t("write.retypeHint")}</span>`;
      // 내가 틀리게 쓴 답을 입력창 위에 연하게 보여준다
      $("#writeWrong").innerHTML = typed.trim()
        ? `${t("write.youWrote")} <s>${esc(typed.trim())}</s>`
        : "";
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
      $("#writeWrong").innerHTML = "";
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
    $("#writeWrong").innerHTML = "";
    $("#writeFeedback").innerHTML = `<span class="wf ok">${t("write.correct")}</span>`;
    dotsCorrect();
    $("#writeMarkCorrect").classList.add("hidden");
    $("#writeNext").classList.add("hidden");
    scheduleAutoNext();
  }

  // 정답이면 잠깐 보여주고 자동으로 다음 카드로 (Enter로 더 빨리 넘길 수도 있음)
  function scheduleAutoNext() {
    clearTimeout(write._auto);
    write._auto = setTimeout(() => {
      if (write && write.revealed && write.lastOk && !write.retyping) nextWrite();
    }, 600);
  }

  function nextWrite() {
    clearTimeout(write._auto);
    const cur = write.queue.shift();          // 현재 카드 큐에서 빼기
    cur.hits = write.lastOk ? (cur.hits || 0) + 1 : 0;   // 연속: 틀리면 0으로 리셋
    if (cur.hits < WRITE_TARGET) {            // 연속 목표 미달 → 다시 넣어 재출제
      // 틀린 카드는 금방 다시(한 장 뒤), 1번 맞힌 카드는 덱 맨 뒤로
      const pos = write.lastOk ? write.queue.length : Math.min(write.queue.length, 1);
      write.queue.splice(pos, 0, cur);
    }
    saveWrite();   // 진행 상황 저장 (큐가 비면 자동 삭제)
    if (write.queue.length === 0) {
      const need = writeNeeded();
      $("#writeProgress").textContent = `${need} / ${need}`;
      $("#writeBar").style.width = "100%";
      $("#writeBody").classList.add("hidden");
      $("#writeDone").classList.remove("hidden");
      $("#writeScore").textContent = t("write.doneSummary", { n: write.total, m: write.misses });
    } else {
      renderWrite();
    }
  }

  /* ══════════ Learn (적응형: 객관식 → 타이핑) ══════════ */
  // 카드마다 숙련도 단계(stage): 0 새 단어(객관식) → 1 익히는 중(타이핑) → 2 완료.
  // 라운드로 나눠 돌리고, 맞히면 다음 단계로, 틀리면 같은 단계로 다시. 전부 완료하면 끝.
  let learn = null;
  const LEARN_ROUND = 7;

  function learnMastered() { return learn.terms.filter(t => t.stage >= 2).length; }

  function startLearn(deckId, exit) {
    const p = pool(deckId);
    if (p.length < 1) return false;
    onExit = exit;
    const answers = [...new Set(p.map(x => x.a))];
    const terms = shuffle(p).map(it => ({ q: it.q, a: it.a, stage: 0 }));
    learn = { terms, answers, queue: [], round: 0, current: null, phase: "mc", misses: 0, locked: false, revealed: false, wrongPending: false, _auto: null };
    $("#learnDone").classList.add("hidden");
    $("#learnBody").classList.remove("hidden");
    buildLearnRound();
    nextLearn();
    return true;
  }

  function buildLearnRound() {
    const unmastered = learn.terms.filter(t => t.stage < 2);
    learn.queue = shuffle(unmastered).sort((a, b) => a.stage - b.stage).slice(0, LEARN_ROUND);
    learn.round++;
  }

  function nextLearn() {
    clearTimeout(learn._auto);
    learn.wrongPending = false;
    if (!learn.queue.length) {
      if (learn.terms.every(t => t.stage >= 2)) { finishLearn(); return; }
      buildLearnRound();
    }
    learn.current = learn.queue[0];
    // 새 단어(stage 0)는 객관식, 한 번 맞힌 뒤(stage 1)는 타이핑. 보기 부족한 작은 덱은 바로 타이핑.
    learn.phase = (learn.current.stage === 0 && learn.answers.length >= 3) ? "mc" : "typed";
    learn.locked = false;
    learn.revealed = false;
    renderLearn();
  }

  function renderLearn() {
    const total = learn.terms.length, done = learnMastered();
    $("#learnProgress").textContent = `${done} / ${total}`;
    $("#learnBar").style.width = `${(done / total) * 100}%`;
    $("#learnRound").textContent = t("learn.round", { n: learn.round });
    const cur = learn.current;
    $("#learnStage").textContent = t(cur.stage === 0 ? "learn.stageNew" : "learn.stageSeen");
    $("#learnStage").className = "learn-stage " + (cur.stage === 0 ? "s-new" : "s-seen");
    $("#learnQuestion").textContent = cur.q;
    $("#learnQuestion").classList.toggle("rich", cur.q.includes("\n"));
    $("#learnFeedback").innerHTML = "";
    if (learn.phase === "mc") {
      $("#learnType").classList.add("hidden");
      $("#learnChoices").classList.remove("hidden");
      const opts = shuffle([cur.a, ...pickDistractors(cur.a, learn.answers)]);
      $("#learnChoices").innerHTML = opts.map(o => `<button class="quiz-opt${o.includes("\n") ? " rich" : ""}" data-a="${esc(o)}">${esc(o)}</button>`).join("");
      $("#learnChoices").querySelectorAll(".quiz-opt").forEach(btn => btn.addEventListener("click", () => pickLearn(btn)));
    } else {
      $("#learnChoices").classList.add("hidden");
      $("#learnType").classList.remove("hidden");
      $("#learnInput").value = "";
      $("#learnInput").disabled = false;
      $("#learnCheck").classList.remove("hidden");
      $("#learnDontKnow").classList.remove("hidden");
      $("#learnMarkCorrect").classList.add("hidden");
      $("#learnNext").classList.add("hidden");
      $("#learnInput").focus();
    }
  }

  function applyLearn(ok) {
    const cur = learn.current;
    learn.queue.shift();
    if (ok) cur.stage = Math.min(2, cur.stage + 1);
    else { learn.misses++; learn.queue.push(cur); }  // 틀리면 같은 단계로 큐 뒤에 다시
  }

  function pickLearn(btn) {
    if (learn.locked) return;
    learn.locked = true;
    const cur = learn.current;
    const ok = btn.dataset.a === cur.a;
    btn.classList.add(ok ? "correct" : "wrong");
    if (!ok) $$("#learnChoices .quiz-opt").forEach(b => { if (b.dataset.a === cur.a) b.classList.add("correct"); });
    applyLearn(ok);
    learn._auto = setTimeout(nextLearn, ok ? 650 : 1250);
  }

  function checkLearn(gaveUp = false) {
    if (!learn || learn.revealed) return;
    learn.revealed = true;
    const cur = learn.current;
    const typed = $("#learnInput").value;
    const ok = !gaveUp && normalize(typed) === normalize(cur.a);
    $("#learnInput").disabled = true;
    $("#learnCheck").classList.add("hidden");
    $("#learnDontKnow").classList.add("hidden");
    if (ok) {
      $("#learnFeedback").innerHTML = `<span class="wf ok">${t("write.correct")}</span>`;
      applyLearn(true);
      learn._auto = setTimeout(nextLearn, 700);
    } else {
      $("#learnFeedback").innerHTML = `<span class="wf no">${t("write.wrongWas", { a: esc(cur.a) })}</span>`;
      learn.wrongPending = true;
      $("#learnMarkCorrect").classList.remove("hidden");  // 동의어·오타 구제
      $("#learnNext").classList.remove("hidden");
      $("#learnNext").focus();
    }
  }

  function learnMark() {   // 틀렸지만 사실 정답(동의어/오타)으로 인정
    if (!learn || !learn.wrongPending) return;
    learn.wrongPending = false;
    applyLearn(true);
    nextLearn();
  }

  function learnNextManual() {
    if (learn && learn.wrongPending) { learn.wrongPending = false; applyLearn(false); }
    nextLearn();
  }

  function finishLearn() {
    $("#learnBar").style.width = "100%";
    $("#learnBody").classList.add("hidden");
    $("#learnDone").classList.remove("hidden");
    $("#learnScore").textContent = t("learn.doneSummary", { n: learn.terms.length, m: learn.misses });
  }

  function exit() {
    if (learn) clearTimeout(learn._auto);
    saveWrite();   // 나가도 Write 진행 상황 유지 (다음에 이어하기)
    quiz = write = learn = null;
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
    $("#writeRetry").addEventListener("click", () => { clearWrite(currentPracticeDeck); startWrite(currentPracticeDeck, onExit, { fresh: true }); });
    $("#learnCheck").addEventListener("click", () => checkLearn(false));
    $("#learnDontKnow").addEventListener("click", () => checkLearn(true));
    $("#learnMarkCorrect").addEventListener("click", learnMark);
    $("#learnNext").addEventListener("click", learnNextManual);
    $("#learnInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!learn) return;
      if (!learn.revealed) checkLearn(false); else learnNextManual();
    });
    $("#learnRetry").addEventListener("click", () => startLearn(currentPracticeDeck, onExit));
  }

  let currentPracticeDeck = null;
  function setDeck(id) { currentPracticeDeck = id; }

  return { startQuiz, startWrite, startLearn, bind, setDeck, exit };
})();
