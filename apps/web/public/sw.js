/* ReyDesk Web Push service worker. */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = { title: 'ReyDesk', body: '', url: '/' }
  try {
    const parsed = event.data ? event.data.json() : {}
    data = { title: 'ReyDesk', body: '', url: '/', ...parsed }
  } catch {
    // Some push providers deliver a plain-text payload. Do not show a blank
    // notification in that case.
    data.body = event.data ? event.data.text() : ''
  }
  const title = data.title || 'ReyDesk'
  const options = {
    body: data.body || '',
    data: { url: data.url || '/' },
    tag: data.tag || 'reydesk',
    renotify: Boolean(data.tag),
    icon: '/reydesk-icon.svg',
    badge: '/reydesk-icon.svg',
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
