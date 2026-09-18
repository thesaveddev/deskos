import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

/**
 * Knowledge-base review notices.
 *
 * Published articles can carry a review_due_at date; the overview counts
 * overdue articles but nothing told their authors. This sweep runs on the
 * device-alert scheduler tick and notifies each article's author when the
 * date passes. A per-(article, due-date) ledger guarantees each overdue
 * episode notifies once — pushing review_due_at forward starts a new episode.
 */

export interface KbReviewNoticeResult {
  /** Articles whose authors were notified this sweep. */
  notified: number
}

export async function checkKbReviewNotices(pool: DbPool): Promise<KbReviewNoticeResult> {
  const { rows: tenants } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of tenants) {
    try {
      await withTenant(pool, tenant.id, async (client) => {
        const due = (await client.query(
          `SELECT a.id, a.title, a.author_id, a.review_due_at
             FROM kb_articles a
            WHERE a.tenant_id = $1
              AND a.status = 'published'
              AND a.review_due_at IS NOT NULL
              AND a.review_due_at <= now()`,
          [tenant.id],
        )).rows as Array<{ id: string; title: string; author_id: string; review_due_at: string | Date }>

        for (const article of due) {
          const claimed = await client.query(
            `INSERT INTO kb_review_notices (tenant_id, article_id, due_date)
             VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, article_id, due_date) DO NOTHING
             RETURNING id`,
            [tenant.id, article.id, article.review_due_at],
          )
          if (!claimed.rows[0]) continue
          total += 1
          if (article.author_id) {
            const dueText = new Date(article.review_due_at).toISOString().slice(0, 10)
            await notify(client, tenant.id, {
              userId: article.author_id,
              kind: 'kb.review_due',
              subjectType: 'kb_article',
              subjectId: article.id,
              body: `Knowledge base article "${article.title}" is past its review date (${dueText}). Review and update it, or move the date forward.`,
            })
          }
        }
      })
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return { notified: total }
}
