import type { DbClient, DbPool } from '../../db/pool.js'

type NotesDb = DbPool | DbClient

export interface NoteCategory {
  id: string
  tenant_id: string
  user_id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

export interface Note {
  id: number
  tenant_id: string
  user_id: string
  title: string
  body: string
  color: string
  category_id: string | null
  category_name?: string | null
  category_color?: string | null
  images: string[]
  position_x: number
  position_y: number
  width: number
  height: number
  is_pinned: boolean
  created_at: string
  updated_at: string
}

const VALID_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange', 'gray']

export async function listNotes(db: NotesDb, tenantId: string, userId: string): Promise<Note[]> {
  const result = await db.query(
    `SELECT n.id, n.tenant_id, n.user_id, n.title, n.body, n.color,
            n.category_id, c.name AS category_name, c.color AS category_color,
            COALESCE(n.images, '[]'::jsonb) AS images,
            n.position_x, n.position_y, n.width, n.height,
            n.is_pinned, n.created_at, n.updated_at
       FROM notes n
       LEFT JOIN note_categories c ON c.id = n.category_id
      WHERE n.tenant_id = $1 AND n.user_id = $2
      ORDER BY n.is_pinned DESC, n.updated_at DESC`,
    [tenantId, userId],
  )
  return result.rows
}

export async function listCategories(db: NotesDb, tenantId: string, userId: string): Promise<NoteCategory[]> {
  const result = await db.query(
    `SELECT * FROM note_categories WHERE tenant_id = $1 AND user_id = $2 ORDER BY lower(name) ASC`,
    [tenantId, userId],
  )
  return result.rows
}

export async function createCategory(db: NotesDb, tenantId: string, userId: string, name: string, color: string): Promise<NoteCategory> {
  const safeColor = VALID_COLORS.includes(color) ? color : 'gray'
  const result = await db.query(
    `INSERT INTO note_categories (tenant_id, user_id, name, color) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, userId, name.trim(), safeColor],
  )
  return result.rows[0]
}

export async function deleteCategory(db: NotesDb, tenantId: string, userId: string, categoryId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM note_categories WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [categoryId, tenantId, userId],
  )
  return (result.rowCount ?? 0) > 0
}

export async function createNote(
  db: NotesDb,
  tenantId: string,
  userId: string,
  data: Partial<Pick<Note, 'title' | 'body' | 'color' | 'category_id' | 'images' | 'position_x' | 'position_y' | 'width' | 'height'>>,
): Promise<Note> {
  const color = VALID_COLORS.includes(data.color || '') ? data.color! : 'yellow'
  const result = await db.query(
    `INSERT INTO notes (tenant_id, user_id, title, body, color, category_id, images, position_x, position_y, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [tenantId, userId, data.title || '', data.body || '', color, data.category_id ?? null, JSON.stringify(data.images ?? []),
      data.position_x ?? 40, data.position_y ?? 40, data.width ?? 220, data.height ?? 220],
  )
  return result.rows[0]
}

export async function updateNote(
  db: NotesDb,
  tenantId: string,
  userId: string,
  noteId: number,
  data: Partial<Pick<Note, 'title' | 'body' | 'color' | 'category_id' | 'images' | 'position_x' | 'position_y' | 'width' | 'height' | 'is_pinned'>>,
): Promise<Note | null> {
  const fields: string[] = []
  const values: unknown[] = []
  const allowedFields = ['title', 'body', 'color', 'category_id', 'images', 'position_x', 'position_y', 'width', 'height', 'is_pinned'] as const
  for (const key of allowedFields) {
    const val = data[key]
    if (val === undefined) continue
    if (key === 'color' && !VALID_COLORS.includes(val as string)) continue
    if (key === 'images') {
      fields.push(`images = $${values.length + 4}::jsonb`)
      values.push(JSON.stringify(val))
    } else {
      fields.push(`${key} = $${values.length + 4}`)
      values.push(val)
    }
  }
  if (fields.length === 0) return null
  fields.push('updated_at = now()')
  const result = await db.query(
    `UPDATE notes SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING *`,
    [noteId, tenantId, userId, ...values],
  )
  return result.rows[0] ?? null
}

export async function deleteNote(db: NotesDb, tenantId: string, userId: string, noteId: number): Promise<boolean> {
  const result = await db.query('DELETE FROM notes WHERE id = $1 AND tenant_id = $2 AND user_id = $3', [noteId, tenantId, userId])
  return (result.rowCount ?? 0) > 0
}
