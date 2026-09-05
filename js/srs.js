/* ═══════════════════════════════════════════════════════
   Petale SRS — SM-2 기반 간격 반복 스케줄러
   rating: 0 다시 · 1 어려움 · 2 보통 · 3 쉬움
   ═══════════════════════════════════════════════════════ */

const SRS = (() => {
  const DAY = 24 * 60 * 60 * 1000;
  const MIN_EF = 1.3;

  // 단위 → 밀리초. 학습 단계(새 카드 '다시'/'어려움', 복습 실패)를
  // 초·분·시간·일 단위로 사용자가 직접 설정할 수 있게 한다.
  const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, day: DAY };
  function unitLabel(u) { return UNIT_MS[u] ? u : "m"; }
  function stepMs(step) {
    if (!step) return 60 * 1000;
    const n = Math.max(0.01, Number(step.value) || 1);
    return Math.max(1000, Math.round(n * UNIT_MS[unitLabel(step.unit)]));
  }

  const DEFAULT_STEPS = {
    againNew: { value: 1, unit: "m" },    // 새 카드 '다시'
    againReview: { value: 10, unit: "m" }, // 복습 카드 실패(다시)
    hardNew: { value: 10, unit: "m" },     // 새 카드 '어려움' → 졸업 전 단계
  };
  let steps = { ...DEFAULT_STEPS };
  function setSteps(s) {
    if (!s) return;
    steps = {
      againNew: s.againNew && s.againNew.value ? s.againNew : steps.againNew,
      againReview: s.againReview && s.againReview.value ? s.againReview : steps.againReview,
      hardNew: s.hardNew && s.hardNew.value ? s.hardNew : steps.hardNew,
    };
  }
  function getSteps() { return steps; }
  function defaultSteps() { return { ...DEFAULT_STEPS }; }

  function newCardState() {
    return { ef: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now() };
  }

  // rating을 적용한 다음 상태를 계산한다 (원본은 변경하지 않음)
  // 새/학습 중 카드(reps 0): 다시·어려움 간격은 설정값(steps) 따름 · 보통 1일 · 쉬움 4일
  // 복습 카드(reps ≥ 1): SM-2 기반 간격 확장
  function schedule(card, rating, now = Date.now()) {
    let { ef, interval, reps, lapses } = card;
    const learning = reps === 0; // 아직 졸업하지 않은(새·학습 단계) 카드

    if (rating === 0) { // 다시
      ef = Math.max(MIN_EF, ef - 0.2);
      const ms = learning ? stepMs(steps.againNew) : stepMs(steps.againReview);
      return { ef, interval: 0, reps: 0, lapses: learning ? lapses : lapses + 1, due: now + ms };
    }

    if (rating === 1 && learning) { // 새 카드 어려움 → 설정된 학습 단계(졸업 전)
      ef = Math.max(MIN_EF, ef - 0.15);
      return { ef, interval: 0, reps: 0, lapses, due: now + stepMs(steps.hardNew) };
    }

    if (rating === 1) { // 복습 어려움
      ef = Math.max(MIN_EF, ef - 0.15);
      interval = Math.max(1, Math.round(interval * 1.2));
    } else if (rating === 2) { // 보통
      interval = learning ? 1 : Math.max(1, Math.round(interval * ef));
    } else { // 쉬움
      ef = Math.min(3.0, ef + 0.15);
      interval = learning ? 4 : Math.max(1, Math.round(interval * ef * 1.3));
    }

    interval = Math.min(interval, 365 * 4);
    return { ef, interval, reps: reps + 1, lapses, due: now + interval * DAY };
  }

  // 버튼 라벨용 예상 간격 문자열
  function previewInterval(card, rating, now = Date.now()) {
    const next = schedule(card, rating, now);
    const diff = next.due - now;
    if (diff < 60 * 60 * 1000) return t("iv.min", { n: Math.round(diff / 60000) });
    if (diff < DAY) return t("iv.hour", { n: Math.round(diff / 3600000) });
    const days = Math.round(diff / DAY);
    if (days < 30) return t("iv.day", { n: days });
    if (days < 365) return t("iv.month", { n: (days / 30).toFixed(1).replace(/\.0$/, "") });
    return t("iv.year", { n: (days / 365).toFixed(1).replace(/\.0$/, "") });
  }

  function isDue(card, now = Date.now()) {
    return card.due <= now;
  }

  function isNew(card) {
    return card.reps === 0 && card.lapses === 0 && card.interval === 0;
  }

  // 카드 목록 표시용: 다음 복습까지 남은 시간 설명
  function dueLabel(card, now = Date.now()) {
    if (isNew(card)) return { text: t("due.new"), fresh: true, overdue: false };
    if (card.due <= now) return { text: t("due.now"), overdue: true };
    const diff = card.due - now;
    if (diff < DAY) return { text: t("due.today"), overdue: false };
    const days = Math.ceil(diff / DAY);
    return { text: t("due.days", { n: days }), overdue: false };
  }

  return {
    newCardState, schedule, previewInterval, isDue, isNew, dueLabel, DAY,
    setSteps, getSteps, defaultSteps, UNIT_MS,
  };
})();
