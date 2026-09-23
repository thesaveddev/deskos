import { AppError } from '../../core/errors.js'
import type { DbClient } from '../../db/pool.js'

export const TEAM_CHAT_ADMIN_ROLES = new Set(['owner', 'it_manager', 'service_desk_manager'])

export type ChatRoomRow = { id: string; name: string; team_id: string | null; created_by: string | null }

/**
 * Room-level access gate shared by REST routes and the WebSocket path.
 * Managers and the room creator always have access. Team rooms are limited to
 * the team roster; standalone rooms are organization-wide until the first
 * explicit member is added, after which only listed members (plus creator and
 * managers) may enter.
 */
export async function assertRoomAccess(client: DbClient, roomId: string, userId: string, orgRole: string): Promise<ChatRoomRow> {
  const room = (await client.query('SELECT id, name, team_id, created_by FROM chat_rooms WHERE id = $1', [roomId])).rows[0] as ChatRoomRow | undefined
  if (!room) throw AppError.notFound('Room not found')
  if (TEAM_CHAT_ADMIN_ROLES.has(orgRole) || room.created_by === userId) return room
  if (room.team_id) {
    const member = (await client.query(
      'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
      [room.team_id, userId],
    )).rows[0]
    if (!member) throw AppError.forbidden('You are not a member of this team chat', 'team_chat_membership_required')
    return room
  }
  const explicitMembers = await client.query('SELECT 1 FROM chat_room_members WHERE room_id = $1 AND ($2::uuid IS NULL OR user_id <> $2) LIMIT 1', [roomId, room.created_by])
  if (explicitMembers.rows.length === 0) return room
  const member = (await client.query(
    'SELECT 1 FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  )).rows[0]
  if (!member) throw AppError.forbidden('You are not a member of this chat room', 'chat_room_membership_required')
  return room
}
