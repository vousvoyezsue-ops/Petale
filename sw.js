/* Petale Service Worker — 오프라인 지원
   전략: 네트워크 우선 + 캐시 폴백 (항상 최신, 오프라인에서도 동작)
   vendor/ 는 불변 대용량이라 캐시 우선 */

const CACHE = "petale-v42";
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
