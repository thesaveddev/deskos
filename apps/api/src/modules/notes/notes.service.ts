import type { PostgresClient } from '../../db/pool.js'

export interface Note {
  id: number
  tenant_id: string
  user_id: string
  title: string
  body: string
  color: string
  position_x: number
  position_y: number
  width: number
  height: number
  is_pinned: boolean
  created_at: string
  updated_at: string
}

const VALID_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange', 'gray']

export async function listNotes(db: PostgresClient, tenantId: string, userId: string): Promise<Note[]> {
  const result = await db.query(
    `SELECT id, tenant_id, user_id, title, body, color,
            position_x, position_y, width, height, is_pinned,
            created_at, updated_at
     FROM notes
     WHERE tenant_id = $1 AND user_id = $2
     ORDER BY is_pinned DESC, updated_at DESC`,
    [tenantId, userId],
  )
  return result.rows
}

export async function createNote(
  db: PostgresClient,
  tenantId: string,
  userId: string,
  data: Partial<Pick<Note, 'title' | 'body' | 'color' | 'position_x' | 'position_y' | 'width' | 'height'>>,
): Promise<Note> {
  const color = VALID_COLORS.includes(data.color || '') ? data.color! : 'yellow'
  const result = await db.query(
    `INSERT INTO notes (tenant_id, user_id, title, body, color, position_x, position_y, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      tenantId, userId,
      data.title || '',
      data.body || '',
      color,
      data.position_x ?? 40,
      data.position_y ?? 40,
      data.width ?? 260,
      data.height ?? 260,
    ],
  )
  return result.rows[0]
}

export async function updateNote(
  db: PostgresClient,
  tenantId: string,
  userId: string,
  noteId: number,
  data: Partial<Pick<Note, 'title' | 'body' | 'color' | 'position_x' | 'position_y' | 'width' | 'height' | 'is_pinned'>>,
): Promise<Note | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 3

  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue
    if (key === 'color' && !VALID_COLORS.includes(val as string)) continue
    fields.push(`${key} = $${idx}`)
    values.push(val)
    idx++
  }

  if (fields.length === 0) return null
  fields.push('updated_at = now()')

  const result = await db.query(
    `UPDATE notes SET ${fields.join(', ')}
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     RETURNING *`,
    [noteId, tenantId, userId, ...values],
  )
  return result.rows[0] ?? null
}

export async function deleteNote(
  db: PostgresClient,
  tenantId: string,
  userId: string,
  noteId: number,
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM notes WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
    [noteId, tenantId, userId],
  )
  return (result.rowCount ?? 0) > 0
}
