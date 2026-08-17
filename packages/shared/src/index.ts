import { z } from 'zod'

export const ticketStatusSchema = z.enum([
  'new',
  'open',
  'in_progress',
  'pending_user',
  'pending_vendor',
  'escalated',
  'resolved',
  'closed',
])
export type TicketStatus = z.infer<typeof ticketStatusSchema>

export const ticketTypeSchema = z.enum([
  'incident',
  'service_request',
  'question',
  'problem',
  'change',
  'major_incident',
])
export type TicketType = z.infer<typeof ticketTypeSchema>

export const prioritySchema = z.enum(['p1', 'p2', 'p3', 'p4'])
export type Priority = z.infer<typeof prioritySchema>

export const sessionTypeSchema = z.enum(['attended', 'unattended', 'inspection'])
export type SessionType = z.infer<typeof sessionTypeSchema>

export const sessionStateSchema = z.enum([
  'requested',
  'consent_pending',
  'connecting',
  'active',
  'reconnecting',
  'ended',
  'denied',
  'expired',
])
export type SessionState = z.infer<typeof sessionStateSchema>

export const sessionPermissionSchema = z.enum([
  'view_screen',
  'control_input',
  'file_transfer',
  'clipboard',
  'elevation',
  'reboot_reconnect',
])
export type SessionPermission = z.infer<typeof sessionPermissionSchema>

export const createSessionSchema = z.object({
  deviceId: z.string().uuid().optional(),
  sessionCode: z.string().min(6).max(12).optional(),
  ticketId: z.string().uuid().optional(),
  permissions: z.array(sessionPermissionSchema).min(1),
  reason: z.string().max(500).optional(),
}).refine((v) => v.deviceId ?? v.sessionCode, {
  message: 'deviceId or sessionCode is required',
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>
