import type { OtelConfig } from '../config.js'

export interface SpanAttribute {
  key: string
  value: { stringValue?: string; intValue?: string }
}

export interface SpanRecord {
  name: string
  traceId: string
  spanId: string
  parentSpanId: string
  startTimeNs: bigint
  endTimeNs: bigint
  statusCode: 0 | 1 | 2
  attributes: SpanAttribute[]
}

/** Unix epoch time in nanoseconds (OTLP's `start_time_unix_nano`). */
export function unixNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n)
}

/**
 * Build an OTLP/HTTP JSON trace payload (`resourceSpans`) following the
 * OpenTelemetry Protocol JSON encoding: trace/span ids are lowercase hex
 * strings, timestamps are unsigned-nanosecond strings, and attributes use the
 * typed `{ stringValue | intValue }` value envelope.
 */
export function buildOtlpJson(
  spans: SpanRecord[],
  serviceName: string,
  serviceVersion: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            { key: 'service.version', value: { stringValue: serviceVersion } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: serviceName, version: serviceVersion },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: 2, // SPAN_KIND_SERVER
              startTimeUnixNano: span.startTimeNs.toString(),
              endTimeUnixNano: span.endTimeNs.toString(),
              status: { code: span.statusCode },
              attributes: span.attributes,
            })),
          },
        ],
      },
    ],
  }
}

/**
 * Batched, fire-and-forget OTLP/HTTP trace exporter. When disabled (no
 * endpoint configured) every method is a no-op so the API never depends on a
 * collector being present. Exports never throw into the request path.
 */
export class OtelTraceExporter {
  private spans: SpanRecord[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly config: OtelConfig) {
    if (config.enabled) {
      this.timer = setInterval(() => {
        void this.flush()
      }, 5000)
      this.timer.unref()
    }
  }

  record(span: SpanRecord): void {
    if (!this.config.enabled) return
    this.spans.push(span)
    // Export eagerly past a threshold so a burst cannot grow the buffer without bound.
    if (this.spans.length >= 512) void this.flush()
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.spans.length === 0) return
    const payload = buildOtlpJson(this.spans.splice(0), this.config.serviceName, this.config.serviceVersion)
    try {
      await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      // The collector being down must never affect request handling; spans are dropped.
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.flush()
  }
}
