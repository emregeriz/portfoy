/*
 * Portföy Takip — service worker
 *
 * Amaç ana ekrandan uygulama gibi açılmak; çevrimdışı tam çalışma değil.
 * Portföy verisi canlı olmak zorunda, o yüzden Supabase'e giden hiçbir
 * istek önbelleğe alınmaz — bayat bakiye göstermektense hata vermek iyidir.
 *
 * Strateji:
 *   gezinme (HTML)   → önce ağ, olmazsa önbellekteki kabuk
 *   hash'li varlıklar → önce önbellek (dosya adı değişmeden içerik değişmez)
 *   diğer her şey     → dokunma
 */
const CACHE = 'portfoy-v1'
const SHELL = ['/', '/manifest.webmanifest', '/pwa-192.png', '/pwa-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // Kendi kaynağımız dışındaki her şey (Supabase, fiyat API'leri, fontlar)
  // doğrudan ağa gider
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/').then((r) => r ?? Response.error()))
    )
    return
  }

  // Vite çıktısındaki dosya adları içerik hash'i taşır: aynı ad = aynı içerik
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
            }
            return res
          })
      )
    )
  }
})
