import { describe, expect, it } from 'vitest'
import { buildOtlpJson, OtelTraceExporter, unixNano, type SpanRecord } from '../src/core/otel.js'
import { parseTraceparentContext } from '../src/core/tracing.js'

function span(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    name: 'GET /healthz',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: '',
    startTimeNs: 1_700_000_000_000_000_000n,
    endTimeNs: 1_700_000_000_000_005_000n,
    statusCode: 1,
    attributes: [
      { key: 'http.method', value: { stringValue: 'GET' } },
      { key: 'http.status_code', value: { intValue: '200' } },
    ],
    ...overrides,
  }
}

describe('OTLP/HTTP JSON trace exporter', () => {
  it('builds a spec-shaped resourceSpans payload', () => {
    const payload = buildOtlpJson([span()], 'reydesk-api', '0.0.1') as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string }> }; scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }> }>
    }

    const resourceSpan = payload.resourceSpans[0]
    expect(resourceSpan.resource.attributes.map((attribute) => attribute.key)).toContain('service.name')
    const emitted = resourceSpan.scopeSpans[0].spans[0]
    expect(emitted.traceId).toBe('a'.repeat(32))
    expect(emitted.spanId).toBe('b'.repeat(16))
    expect(emitted.kind).toBe(2)
    expect(emitted.startTimeUnixNano).toBe('1700000000000000000')
    expect(emitted.endTimeUnixNano).toBe('1700000000000005000')
    expect(emitted.status).toEqual({ code: 1 })
    expect(emitted.attributes).toHaveLength(2)
  })

  it('marks 5xx spans as errors', () => {
    const payload = buildOtlpJson([span({ statusCode: 2 })], 'reydesk-api', '0.0.1') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }>
    }
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 2 })
  })

  it('parses both trace and parent span ids from a traceparent', () => {
    const context = parseTraceparentContext('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01')
    expect(context).toEqual({ traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' })
    expect(parseTraceparentContext('invalid')).toBeNull()
  })

  it('no-ops cleanly when no endpoint is configured', async () => {
    const exporter = new OtelTraceExporter({ enabled: false, endpoint: '', serviceName: 'reydesk-api', serviceVersion: '0.0.1' })
    exporter.record(span())
    await exporter.flush()
    await exporter.stop()
  })

  it('reports monotonic epoch nanoseconds', () => {
    const first = unixNano()
    const second = unixNano()
    expect(second).toBeGreaterThanOrEqual(first)
    expect(first).toBeGreaterThan(1_600_000_000_000_000_000n)
  })
})
