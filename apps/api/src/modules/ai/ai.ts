import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import type { AiProvider } from './gateway.js'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'have', 'has', 'was', 'are', 'will',
  'from', 'not', 'but', 'our', 'your', 'you', 'his', 'her', 'its', 'can', 'all', 'any',
  'who', 'what', 'when', 'where', 'why', 'how', 'into', 'out', 'over', 'under', 'about',
  'then', 'than', 'them', 'they', 'there', 'been', 'would', 'could', 'should', 'being',
  'also', 'just', 'very', 'some', 'such', 'more', 'most', 'does', 'did', 'doing', 'dont',
])

/** Lowercase, split on non-alphanumerics, drop stopwords and short tokens. */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  return new Set(words)
}

interface TicketText {
  id: string
  number: number
  subject: string
  type: string
  status: string
  priority: string
  category_id: string | null
  text: string
}

/** Load a ticket's subject + message bodies for prompts and similarity. */
async function loadTicketText(pool: DbPool, tenantId: string, ticketId: string): Promise<TicketText> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.number, t.subject, t.type, t.status, t.priority, t.category_id,
              COALESCE(
                string_agg(th.body, ' ' ORDER BY th.created_at)
                  FILTER (WHERE th.kind IN ('message', 'internal_note')),
                ''
              ) AS body_text
         FROM tickets t
         LEFT JOIN ticket_threads th ON th.ticket_id = t.id
        WHERE t.id = $1
        GROUP BY t.id`,
      [ticketId],
    )
    if (!rows[0]) throw AppError.notFound('Ticket not found')
    const r = rows[0]
    return {
      id: r.id,
      number: r.number,
      subject: r.subject,
      type: r.type,
      status: r.status,
      priority: r.priority,
      category_id: r.category_id,
      text: `${r.subject}\n${r.body_text}`,
    }
  })
}

/** Jaccard coefficient between two token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Generate and persist an internal `ai_summary` thread entry for a ticket.
 * The summary is always human-reviewable (an internal timeline entry, never a
 * public reply) and the action is audited by the caller.
 */
export async function summarizeTicket(
  pool: DbPool,
  tenantId: string,
  ticketId: string,
  actorId: string,
  provider: AiProvider,
  model: string,
): Promise<{ id: string; summary: string }> {
  const t = await loadTicketText(pool, tenantId, ticketId)
  const prompt = [
    'You are an IT helpdesk assistant. Summarise the following support ticket for a technician.',
    'Focus on the user\u2019s problem, what has already been tried, and the most likely next steps.',
    'Be concise and factual; never invent details that are not present.',
    '',
    `Subject: ${t.subject}`,
    `Type: ${t.type} · Status: ${t.status} · Priority: ${t.priority}`,
    'Timeline:',
    t.text,
    '',
    'Summary:',
  ].join('\n')
  const summary = await provider.generate(prompt, { maxTokens: 500 })
  const id = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
       VALUES ($1, $2, $3, 'ai_summary', 'internal', $4, $5::jsonb)
       RETURNING id`,
      [tenantId, ticketId, actorId, summary, JSON.stringify({ source: 'ai', model })],
    )
    return rows[0].id as string
  })
  return { id, summary }
}

export interface SimilarTicket {
  id: string
  number: number
  subject: string
  type: string
  status: string
  priority: string
  similarity: number
}

/**
 * Rank other tickets in the tenant by token-overlap with the source ticket.
 * Runs without the AI provider, so it works even when the provider is off.
 */
export async function findSimilarTickets(
  pool: DbPool,
  tenantId: string,
  ticketId: string,
  limit = 5,
): Promise<SimilarTicket[]> {
  const source = await loadTicketText(pool, tenantId, ticketId)
  const sourceTokens = tokenize(source.text)
  const candidates = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.number, t.subject, t.type, t.status, t.priority, t.category_id,
              COALESCE(
                string_agg(th.body, ' ' ORDER BY th.created_at)
                  FILTER (WHERE th.kind IN ('message', 'internal_note')),
                ''
              ) AS body_text
         FROM tickets t
         LEFT JOIN ticket_threads th ON th.ticket_id = t.id
        WHERE t.id <> $1
        GROUP BY t.id
        ORDER BY t.created_at DESC
        LIMIT 500`,
      [ticketId],
    )
    return rows
  })
  const ranked: SimilarTicket[] = []
  for (const r of candidates) {
    const candTokens = tokenize(`${r.subject}\n${r.body_text}`)
    const base = jaccard(sourceTokens, candTokens)
    if (base === 0) continue
    let score = base
    if (r.type === source.type) score += 0.05
    if (r.priority === source.priority) score += 0.05
    if (r.category_id && r.category_id === source.category_id) score += 0.05
    ranked.push({
      id: r.id,
      number: r.number,
      subject: r.subject,
      type: r.type,
      status: r.status,
      priority: r.priority,
      similarity: Math.min(1, Math.round(score * 100) / 100),
    })
  }
  return ranked.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
}

/** Leniently parse a `{title, body}` object from a model response. */
function parseDraftJson(raw: string): { title?: string; body?: string } {
  const trimmed = raw.trim()
  const candidates: string[] = []
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  candidates.push(trimmed)
  const brace = trimmed.match(/\{[\s\S]*\}/)
  if (brace) candidates.push(brace[0])
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { title: typeof parsed.title === 'string' ? parsed.title : undefined, body: typeof parsed.body === 'string' ? parsed.body : undefined }
      }
    } catch {
      // try the next candidate
    }
  }
  return {}
}

/**
 * Draft a knowledge-base article from a ticket's conversation and save it as a
 * `draft` article (internal visibility, tagged `ai-drafted`) for human review.
 */
export async function draftKbArticle(
  pool: DbPool,
  tenantId: string,
  ticketId: string,
  actorId: string,
  provider: AiProvider,
  model: string,
): Promise<Record<string, unknown>> {
  const t = await loadTicketText(pool, tenantId, ticketId)
  const prompt = [
    'You are an IT helpdesk assistant. Draft a concise internal knowledge-base article from this resolved support ticket.',
    'Write the article for other technicians so they can solve the same issue faster.',
    'Do not include customer names or personally identifiable information.',
    'Respond with ONLY a JSON object with exactly two keys: "title" (a short how-to title) and "body" (markdown steps: symptom, cause, resolution).',
    '',
    `Ticket subject: ${t.subject}`,
    'Conversation:',
    t.text,
  ].join('\n')
  const raw = await provider.generate(prompt, { maxTokens: 800 })
  const parsed = parseDraftJson(raw)
  const title = parsed.title?.trim() || `Draft: ${t.subject}`
  const body = parsed.body?.trim() || raw

  return withTenant(pool, tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO kb_articles
         (tenant_id, folder_id, title, body, visibility, status, author_id, version, tags)
       VALUES ($1, NULL, $2, $3, 'internal', 'draft', $4, 1, $5)
       RETURNING id, title, body, visibility, status, version, tags, created_at, updated_at`,
      [tenantId, title, body, actorId, ['ai-drafted']],
    )
    const row = res.rows[0]
    await client.query(
      `INSERT INTO kb_article_versions (tenant_id, article_id, version, title, body, author_id)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [tenantId, row.id, title, body, actorId],
    )
    return { ...row, source: 'ai', model }
  })
}
