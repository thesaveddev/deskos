/* DeskOS Web Push service worker. */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = { title: 'DeskOS', body: '', url: '/' }
  try {
    const parsed = event.data ? event.data.json() : {}
    data = { title: 'DeskOS', body: '', url: '/', ...parsed }
  } catch {
    /* non-JSON payload — show the raw body */
  }
  const title = data.title || 'DeskOS'
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
    tag: data.tag || 'deskos',
    renotify: Boolean(data.tag),
    icon: '/deskos-icon.svg',
    badge: '/deskos-icon.svg',
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
