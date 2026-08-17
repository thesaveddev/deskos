import type { UpdateConfig } from '../config.js'

/** Compare two dotted numeric versions. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Deterministic FNV-1a bucket (0..99) so rollout rings are stable per device. */
export function rolloutRing(deviceId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < deviceId.length; index += 1) {
    hash ^= deviceId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return Math.abs(hash) % 100
}

export interface UpdateOffer {
  version: string
  minVersion: string
  url: string
  sha256: string
  signature: string
  rolloutPercent: number
}

export type UpdateCheck =
  | { update: null; status: 'not_configured' | 'up_to_date' | 'rollout_deferred' }
  | { update: UpdateOffer; status: 'available' }

/** Decide whether this device is offered the configured update. */
export function checkUpdate(config: UpdateConfig, deviceId: string, currentVersion: string): UpdateCheck {
  if (!config.version || !config.url || !config.sha256) {
    return { update: null, status: 'not_configured' }
  }
  if (compareVersions(currentVersion, config.version) >= 0) {
    return { update: null, status: 'up_to_date' }
  }
  if (rolloutRing(deviceId) >= config.rolloutPercent) {
    return { update: null, status: 'rollout_deferred' }
  }
  return {
    status: 'available',
    update: {
      version: config.version,
      minVersion: config.minVersion || config.version,
      url: config.url,
      sha256: config.sha256,
      signature: config.signature,
      rolloutPercent: config.rolloutPercent,
    },
  }
}
