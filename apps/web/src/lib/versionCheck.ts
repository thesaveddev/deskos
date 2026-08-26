/**
 * Proactive stale-bundle detection.
 *
 * After the app is deployed, old chunks no longer exist on the server.
 * React.lazy() only discovers this when the user navigates, which produces
 * the scary "Failed to fetch dynamically imported module" error.
 *
 * This module periodically fetches a lightweight fingerprint and compares it
 * to the one captured at page load. When a mismatch is detected it
 * automatically reloads the page so the user always gets the latest build.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_RETRY_DELAY_MS = 60_000

let buildFingerprint: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Compute a fingerprint for the current build by fetching the root HTML
 * and hashing the `<script>` src path. Vite content-hashes chunk filenames,
 * so a changed hash means a new build.
 */
async function fetchFingerprint(): Promise<string | null> {
  try {
    const res = await fetch(`/?_v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    // Extract the main script src — Vite embeds something like:
    //   <script type="module" src="/assets/index-abc123.js"></script>
    const match = html.match(/src="(\/assets\/[^"]+)"/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function check() {
  const latest = await fetchFingerprint()

  if (buildFingerprint === null) {
    // First run — just capture the baseline
    buildFingerprint = latest
  } else if (latest && latest !== buildFingerprint) {
    console.warn(
      `[version-check] Build changed: ${buildFingerprint} → ${latest}. Reloading…`,
    )
    // Clear any pending timer so we don't double-reload
    if (timer) clearTimeout(timer)
    window.location.reload()
    return // stop the loop
  }

  // Schedule next check
  timer = setTimeout(check, CHECK_INTERVAL_MS)
}

/** Start the proactive check. Safe to call multiple times. */
export function startVersionCheck(): void {
  if (timer) return // already running
  // Delay the first check so it doesn't compete with initial page load
  timer = setTimeout(check, CHECK_INTERVAL_MS)
}

/** Stop the proactive check (for cleanup in tests or SPAs that unmount). */
export function stopVersionCheck(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
