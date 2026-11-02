/* 오프라인에서도 앱 화면이 열리도록 기본 파일을 저장해 둡니다. (서버 요청은 저장하지 않음) */
const CACHE = 'finance-claim-v2';
const SHELL = [
  './', './index.html', './style.css', './common.js', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './admin/', './admin/index.html', './admin/admin.css', './admin/admin.js', './admin/manifest.webmanifest',
  './icons/admin-192.png', './icons/admin-512.png', './icons/admin-apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Apps Script 등 외부 요청은 그대로 통과

  // 네트워크 우선 → 실패하면 저장본 (업데이트가 바로 반영되도록)
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match(url.pathname.includes('/admin/') ? './admin/index.html' : './index.html')))
  );
});
