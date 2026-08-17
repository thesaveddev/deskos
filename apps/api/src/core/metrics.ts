const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx'

/**
 * Minimal dependency-free Prometheus text-format registry, matching the
 * hand-rolled exporter already used by the relay. Counters and histograms are
 * kept in-process; a single API instance is the assumed deployment for now, so
 * cross-instance aggregation is out of scope until a second API replica exists.
 */
export class MetricsRegistry {
  private requestCounts = new Map<string, number>()
  private latencyBucketCounts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0)
  private latencySumMs = 0
  private latencyCount = 0
  private sessionCreations = 0
  private activeSessions = 0
  private syntheticProbeCounts = new Map<string, number>()

  observeRequest(method: string, statusClass: StatusClass, durationMs: number): void {
    const key = `${method} ${statusClass}`
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1)
    this.latencySumMs += durationMs
    this.latencyCount += 1
    for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
      if (durationMs <= LATENCY_BUCKETS_MS[index]) this.latencyBucketCounts[index] += 1
    }
    // +Inf bucket always counts every observation.
    this.latencyBucketCounts[LATENCY_BUCKETS_MS.length] += 1
  }

  sessionCreated(): void {
    this.sessionCreations += 1
    this.activeSessions += 1
  }

  sessionTerminated(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1)
  }

  observeSyntheticProbe(check: string, ok: boolean): void {
    const key = `${check} ${ok ? 'ok' : 'fail'}`
    this.syntheticProbeCounts.set(key, (this.syntheticProbeCounts.get(key) ?? 0) + 1)
  }

  render(poolStats: { total: number; idle: number; waiting: number }): string {
    const lines: string[] = []

    lines.push('# HELP deskos_api_requests_total Total HTTP requests handled by the API.')
    lines.push('# TYPE deskos_api_requests_total counter')
    for (const [key, count] of [...this.requestCounts.entries()].sort()) {
      const [method, statusClass] = key.split(' ')
      lines.push(`deskos_api_requests_total{method="${method}",status_class="${statusClass}"} ${count}`)
    }

    lines.push('# HELP deskos_api_request_duration_seconds API request latency.')
    lines.push('# TYPE deskos_api_request_duration_seconds histogram')
    for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
      lines.push(
        `deskos_api_request_duration_seconds_bucket{le="${LATENCY_BUCKETS_MS[index] / 1000}"} ${this.latencyBucketCounts[index]}`,
      )
    }
    lines.push(`deskos_api_request_duration_seconds_bucket{le="+Inf"} ${this.latencyBucketCounts[LATENCY_BUCKETS_MS.length]}`)
    lines.push(`deskos_api_request_duration_seconds_sum ${this.latencySumMs / 1000}`)
    lines.push(`deskos_api_request_duration_seconds_count ${this.latencyCount}`)

    lines.push('# HELP deskos_active_remote_sessions Remote sessions currently in a live state.')
    lines.push('# TYPE deskos_active_remote_sessions gauge')
    lines.push(`deskos_active_remote_sessions ${this.activeSessions}`)

    lines.push('# HELP deskos_session_creations_total Remote sessions created since process start.')
    lines.push('# TYPE deskos_session_creations_total counter')
    lines.push(`deskos_session_creations_total ${this.sessionCreations}`)

    lines.push('# HELP deskos_postgres_pool_connections Postgres connection pool usage.')
    lines.push('# TYPE deskos_postgres_pool_connections gauge')
    lines.push(`deskos_postgres_pool_connections{state="total"} ${poolStats.total}`)
    lines.push(`deskos_postgres_pool_connections{state="idle"} ${poolStats.idle}`)
    lines.push(`deskos_postgres_pool_connections{state="waiting"} ${poolStats.waiting}`)

    lines.push('# HELP deskos_synthetic_probe_checks_total Synthetic control-plane health checks.')
    lines.push('# TYPE deskos_synthetic_probe_checks_total counter')
    for (const [key, count] of [...this.syntheticProbeCounts.entries()].sort()) {
      const [check, outcome] = key.split(' ')
      lines.push(`deskos_synthetic_probe_checks_total{check="${check}",outcome="${outcome}"} ${count}`)
    }

    return `${lines.join('\n')}\n`
  }
}
