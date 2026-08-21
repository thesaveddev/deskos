import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('sticky notes', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Notes UX Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates a category and note inside the tenant transaction', async () => {
    const category = await app.inject({
      method: 'POST',
      url: '/api/v1/notes/categories',
      headers: authHeaders(owner),
      payload: { name: 'Important', color: 'blue' },
    })
    expect(category.statusCode).toBe(201)
    expect(category.json().category.name).toBe('Important')

    const note = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: authHeaders(owner),
      payload: { body: 'Remember this', color: 'yellow', category_id: category.json().category.id },
    })
    expect(note.statusCode).toBe(200)
    expect(note.json().note.body).toBe('Remember this')

    const listed = await app.inject({ method: 'GET', url: '/api/v1/notes', headers: authHeaders(owner) })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().notes[0].category_name).toBe('Important')
  })

  it('updates and deletes personal notes and categories', async () => {
    const category = await app.inject({
      method: 'POST',
      url: '/api/v1/notes/categories',
      headers: authHeaders(owner),
      payload: { name: 'Temporary', color: 'gray' },
    })
    const note = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: authHeaders(owner),
      payload: { body: '', category_id: category.json().category.id },
    })
    const noteId = note.json().note.id as number
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: authHeaders(owner),
      payload: { body: 'Updated automatically', is_pinned: true },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().note.is_pinned).toBe(true)

    const deletedNote = await app.inject({ method: 'DELETE', url: `/api/v1/notes/${noteId}`, headers: authHeaders(owner) })
    expect(deletedNote.statusCode).toBe(200)
    const deletedCategory = await app.inject({ method: 'DELETE', url: `/api/v1/notes/categories/${category.json().category.id}`, headers: authHeaders(owner) })
    expect(deletedCategory.statusCode).toBe(200)
  })

  it('stores and updates multiple inline images on a note', async () => {
    const img = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`
    const note = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: authHeaders(owner),
      payload: { body: 'With pictures', color: 'green', images: [img(10), img(20)] },
    })
    expect(note.statusCode).toBe(200)
    expect(note.json().note.images).toEqual([img(10), img(20)])

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${note.json().note.id}`,
      headers: authHeaders(owner),
      payload: { images: [img(30)] },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().note.images).toEqual([img(30)])

    const listed = await app.inject({ method: 'GET', url: '/api/v1/notes', headers: authHeaders(owner) })
    const match = listed.json().notes.find((item: { id: number }) => item.id === note.json().note.id)
    expect(match.images).toEqual([img(30)])
  })

  it('rejects note images that are not valid data URLs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: authHeaders(owner),
      payload: { body: '', images: ['not-an-image'] },
    })
    expect(res.statusCode).toBe(400)
  })
})
