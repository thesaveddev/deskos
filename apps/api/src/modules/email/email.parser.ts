import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'

const TICKET_NUMBER_RE = /(?:\[#?(\d{1,8})\s*\]|#(\d{1,8})\b)|^(\d{1,8})\b/

/**
 * Extract a ticket number from a subject line, or null if none.
 * Supports the conventional markers `[#1234]`, `[1234]`, `#1234` anywhere, or a
 * bare number only when it leads the subject (e.g. "Re: 42 still broken").
 * Bare digits embedded in text (prices, version numbers) are ignored.
 */
export function extractTicketNumber(subject: string): number | null {
  const trimmed = subject.trim()
  // Skip common prefixes like "Re:", "Fwd:" to get to the actual subject
  const clean = trimmed.replace(/^(?:(?:re|fwd|fw|aw)\s*:\s*)+/gi, '').trim()
  const match = clean.match(TICKET_NUMBER_RE)
  if (!match) return null
  const num = Number(match[1] ?? match[2] ?? match[3])
  return Number.isFinite(num) && num > 0 ? num : null
}

/** Strip HTML to plain text (simple — production would use a sanitizer). */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface ParsedEmail {
  messageId: string
  fromAddress: string
  fromName: string
  toAddress: string
  subject: string
  body: string
}

/** Parse a raw RFC822 email string into structured fields. */
export async function parseRawEmail(raw: string): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(raw)
  const fromValue = firstAddress(parsed.from)
  const toValue = firstAddress(parsed.to)
  const text = parsed.text?.trim()
  const html = parsed.html?.toString().trim()

  return {
    messageId: parsed.messageId ?? '',
    fromAddress: fromValue?.address ?? '',
    fromName: fromValue?.name || fromValue?.address?.split('@')[0] || 'Unknown',
    toAddress: toValue?.address ?? '',
    subject: parsed.subject?.trim() || '(No subject)',
    body: text || (html ? stripHtml(html) : ''),
  }
}

interface AddressFields {
  address?: string
  name?: string
}

/** Normalise mailparser's AddressObject/AddressObject[] union to a plain address. */
function firstAddress(value: AddressObject | AddressObject[] | undefined): AddressFields | undefined {
  if (!value) return undefined
  return (Array.isArray(value) ? value[0] : value.value?.[0]) as AddressFields | undefined
}