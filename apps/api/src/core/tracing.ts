import { randomBytes } from 'node:crypto'

/**
 * W3C trace-context propagation (https://www.w3.org/TR/trace-context/).
 * The API honours an inbound `traceparent` and always emits its own so the
 * web app, relay, and any OpenTelemetry collector can stitch a request into
 * one distributed trace. This is the vendor-neutral foundation for the
 * OpenTelemetry tracing milestone; an OTLP exporter can be added later without
 * changing this contract.
 */

export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex')
}

export function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

/**
 * Parse an inbound `traceparent` header. Returns the lowercase trace id when
 * the header is well-formed, otherwise `null` (callers then mint a fresh one).
 */
export function parseTraceparent(header: string | undefined): string | null {
  return parseTraceparentContext(header)?.traceId ?? null
}

/** Parse both the trace id and the parent span id from an inbound traceparent. */
export function parseTraceparentContext(
  header: string | undefined,
): { traceId: string; spanId: string } | null {
  if (!header) return null
  const parts = header.split('-')
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flags] = parts
  if (version !== '00') return null
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return null
  if (!/^[0-9a-f]{16}$/i.test(spanId)) return null
  if (!/^[0-9a-f]{2}$/i.test(flags)) return null
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() }
}
