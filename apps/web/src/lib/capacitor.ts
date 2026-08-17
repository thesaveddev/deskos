import { Capacitor } from '@capacitor/core'

/** Check if running inside a Capacitor native shell */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

/** Get the current platform ('ios', 'android', 'web') */
export function getPlatform(): string {
  return Capacitor.getPlatform()
}

/** Check if running on iOS */
export function isIOS(): boolean {
  return Capacitor.getPlatform() === 'ios'
}

/** Check if running on Android */
export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android'
}
