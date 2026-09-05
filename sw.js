/* Petale Service Worker — 오프라인 지원
   전략: 네트워크 우선 + 캐시 폴백 (항상 최신, 오프라인에서도 동작)
   vendor/ 는 불변 대용량이라 캐시 우선 */

const CACHE = "petale-v47";
const PRECACHE = [
  "./",
  "index.html",
  "manifest.json",
  "fonts/fonts.css",
  "css/style.css",
  "js/i18n.js",
  "js/srs.js",
  "js/store.js",
  "js/occlusion.js",
  "js/apkg.js",
  "js/social.js",
  "js/practice.js",
  "js/app.js",
  "vendor/jszip.min.js",
  "vendor/fzstd.min.js",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm",
  "vendor/supabase.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // vendor·fonts는 캐시 우선 (내용이 바뀌지 않는 큰 파일)
  if (url.pathname.includes("/vendor/") || url.pathname.includes("/fonts/files/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
    return;
  }

  // 나머지는 네트워크 우선, 실패 시 캐시
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});

/* ═══════════ 학습 알림 ═══════════ */

// 알림을 누르면 앱으로 이동(이미 열려 있으면 그 창으로 포커스)
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("./");
  })());
});

// 주기적 백그라운드 동기화(지원 브라우저·설치형 PWA): 복습이 밀리면 알림
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "petale-review-check") e.waitUntil(reviewCheck());
});

// IndexedDB에서 저장된 카드 상태를 읽는다 (앱과 동일한 저장소)
function idbGet(dbName, store, key) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(dbName, 1); } catch { return resolve(null); }
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); return resolve(null); }
      try {
        const g = db.transaction(store, "readonly").objectStore(store).get(key);
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch {} resolve(null); };
  });
}

async function reviewCheck() {
  // 앱 창이 열려 있으면 앱이 직접 알림을 처리하므로 건너뛴다
  const open = await self.clients.matchAll({ type: "window" });
  if (open.length) return;
  const state = await idbGet("petale", "kv", "petale.v1");
  if (!state || !Array.isArray(state.cards)) return;
  const now = Date.now();
  const due = state.cards.filter(c =>
    !c.suspended && c.due <= now && !(c.reps === 0 && c.lapses === 0 && c.interval === 0)
  ).length;
  if (due <= 0) return;
  const ko = (state.settings && state.settings.lang) !== "en";
  await self.registration.showNotification(ko ? "Petale 복습 시간 🌸" : "Time to review 🌸", {
    body: ko ? `복습할 카드 ${due}장이 기다리고 있어요` : `${due} cards are ready to review`,
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: "petale-review", renotify: true,
  });
}
