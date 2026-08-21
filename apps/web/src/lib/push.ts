import { api } from './api.js'

export interface PushSubscriptionRecord {
  id: string
  endpoint: string
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

export function getPushStatus(): Promise<{ enabled: boolean; subscriptions: number }> {
  return api('/push/status')
}

export function getVapidPublicKey(): Promise<{ publicKey: string }> {
  return api('/push/vapid-public-key')
}

export function listPushSubscriptions(): Promise<{ subscriptions: PushSubscriptionRecord[] }> {
  return api('/push/subscriptions')
}

export function savePushSubscription(sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string }): Promise<{ subscription: PushSubscriptionRecord }> {
  return api('/push/subscriptions', { method: 'POST', body: sub })
}

export function deletePushSubscription(id: string): Promise<{ ok: boolean }> {
  return api(`/push/subscriptions/${id}`, { method: 'DELETE' })
}

export function testPush(): Promise<{ delivered: number; removed: number }> {
  return api('/push/subscriptions/test', { method: 'POST' })
}

/** Register the push service worker (idempotent). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

/** Current browser push subscription, if any. */
async function currentBrowserSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

/**
 * Enable push for this browser: request permission, subscribe with the server's
 * VAPID key, and register the subscription with the API.
 */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  const localDevelopmentHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  if (!window.isSecureContext && !localDevelopmentHost) {
    return { ok: false, error: 'Browser push requires HTTPS. Open ReyDesk through its secure public URL (localhost is allowed for development).' }
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, error: 'Push is not supported by this browser.' }
  }
  if (Notification.permission === 'denied') {
    return { ok: false, error: 'Notifications are blocked for this site. Allow them in your browser settings.' }
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, error: 'Notification permission was not granted.' }
  }
  try {
    const { publicKey } = await getVapidPublicKey()
    const registration = await registerServiceWorker()
    if (!registration) return { ok: false, error: 'Could not register the service worker.' }
    // Reuse a browser subscription when it already exists. Calling subscribe()
    // again can fail with InvalidStateError even though the browser is already
    // correctly subscribed; re-saving it also repairs a missing server row.
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    })
    await savePushSubscription({
      endpoint: subscription.endpoint,
      p256dh: bufferToBase64Url(subscription.getKey('p256dh') as ArrayBuffer),
      auth: bufferToBase64Url(subscription.getKey('auth') as ArrayBuffer),
      userAgent: navigator.userAgent,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not enable push.' }
  }
}

/** Disable push: unsubscribe the browser and clear stored subscriptions. */
export async function disablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const browserSub = await currentBrowserSubscription()
    if (browserSub) await browserSub.unsubscribe()
    const { subscriptions } = await listPushSubscriptions()
    await Promise.all(subscriptions.map((s) => deletePushSubscription(s.id).catch(() => undefined)))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not disable push.' }
  }
}

function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
