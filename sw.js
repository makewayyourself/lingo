/* Lingo Service Worker — 오프라인 설치형 웹앱 */
const CACHE = 'lingo-v2-2026-05-28';
const ASSETS = [
  './',
  './index.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API/실시간 호출은 절대 캐시하지 않음
  if (
    url.hostname.includes('anthropic.com') ||
    url.hostname.includes('dictionaryapi.dev') ||
    url.hostname.includes('gutendex.com') ||
    url.hostname.includes('gutenberg.org') ||
    url.hostname.includes('bible-api.com')
  ) return;

  // 캐시 우선, 실패 시 네트워크, 그 응답을 캐시에 저장 (폰트, 본 앱 파일 위주)
  e.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(res => {
        if (res && res.ok && (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com'))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
