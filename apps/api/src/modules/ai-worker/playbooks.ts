import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface Playbook {
  id: string
  tenant_id: string
  name: string
  description: string
  category: string
  trigger_keywords: string[]
  system_prompt: string
  max_steps: number
  auto_approve_low_risk: boolean
  enabled: boolean
  usage_count: number
  success_rate: number
  created_at: string
  updated_at: string
}

export interface PlaybookPatch {
  name?: string
  description?: string
  category?: string
  trigger_keywords?: string[]
  system_prompt?: string
  max_steps?: number
  auto_approve_low_risk?: boolean
  enabled?: boolean
}

/** Pre-built L1 playbooks that are seeded for every tenant on creation. */
export const BUILT_IN_PLAYBOOKS: Array<Omit<Playbook, 'id' | 'tenant_id' | 'usage_count' | 'success_rate' | 'created_at' | 'updated_at'>> = [
  {
    name: 'Password Reset',
    description: 'Guide the user through a password reset for their account or connected directory.',
    category: 'password_reset',
    trigger_keywords: ['password', 'reset', 'forgot', 'locked out', 'cannot login', 'credentials'],
    system_prompt: 'You are an L1 support agent helping with a password reset. First read the ticket to understand which account needs resetting. Check if there is a linked device and whether it has directory integration (Entra/AD). If the device has directory tools, propose a script to reset the password. Otherwise, guide the user through the self-service reset process. Always verify the user identity before making changes.',
    max_steps: 4,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Software Installation',
    description: 'Install approved software on the user device via scripted deployment.',
    category: 'software_install',
    trigger_keywords: ['install', 'software', 'application', 'app', 'program', 'download'],
    system_prompt: 'You are an L1 support agent helping with software installation. Read the ticket to identify what software the user needs. Check the device inventory for what is already installed. Look for an approved script in the script library that can install the requested software. If an approved script exists, dispatch it. If not, hand off to a technician who can create the deployment script.',
    max_steps: 5,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Printer Troubleshooting',
    description: 'Diagnose and fix common printer connectivity and print queue issues.',
    category: 'printer',
    trigger_keywords: ['printer', 'print', 'printing', 'paper jam', 'queue', 'toner', 'ink'],
    system_prompt: 'You are an L1 support agent troubleshooting a printer issue. Read the ticket to understand the specific problem. Check the device inventory for connected printers. Common fixes include: restarting the print spooler, clearing the print queue, reconnecting the printer. Use available scripts to restart the print spooler or reset the printer connection. If the issue is physical (paper jam, low toner), hand off with clear instructions.',
    max_steps: 5,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Network Connectivity',
    description: 'Diagnose and resolve basic network connectivity issues.',
    category: 'network',
    trigger_keywords: ['network', 'internet', 'wifi', 'connection', 'dns', 'ip', 'connectivity', 'offline'],
    system_prompt: 'You are an L1 support agent diagnosing a network issue. Read the ticket and check the device metrics (online status, IP configuration). Run diagnostic scripts to check DNS resolution, ping gateways, and verify network adapter status. Common fixes: renew DHCP lease, flush DNS cache, restart network adapter. If the issue is infrastructure-related (switch, router, ISP), hand off with diagnostic evidence.',
    max_steps: 6,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Account Unlock',
    description: 'Unlock a locked user account after identity verification.',
    category: 'account_unlock',
    trigger_keywords: ['locked', 'account', 'unlock', 'too many attempts', 'disabled'],
    system_prompt: 'You are an L1 support agent helping unlock a user account. Read the ticket to identify the affected account. Check if the device has directory integration. If an unlock script is available and approved, dispatch it after confirming the lockout reason. If no automated unlock is available, hand off to a technician with the account details.',
    max_steps: 3,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Email Troubleshooting',
    description: 'Diagnose email client connectivity and configuration issues.',
    category: 'email',
    trigger_keywords: ['email', 'outlook', 'mail', 'inbox', 'exchange', 'sync', 'calendar'],
    system_prompt: 'You are an L1 support agent troubleshooting email issues. Read the ticket to identify the email client and specific problem. Common issues include: profile corruption, cache problems, connectivity to Exchange/M365. Check device inventory for the email client version. Propose scripts to reset the email profile or clear the cache if available. For authentication or server-side issues, hand off with diagnostic details.',
    max_steps: 5,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'Blue Screen / Crash',
    description: 'Collect diagnostics from a device experiencing blue screens or crashes.',
    category: 'hardware',
    trigger_keywords: ['blue screen', 'bsod', 'crash', 'freeze', 'hang', 'restart', 'unexpected'],
    system_prompt: 'You are an L1 support agent handling a crash or blue screen report. Read the ticket for details about the crash (error code, frequency, recent changes). Check device metrics for recent uptime and any open alerts. Collect inventory to identify recent software or driver changes. If the device is online, run a diagnostic script to collect crash dumps or event logs. Add an internal note with findings and hand off to a senior technician for root cause analysis.',
    max_steps: 5,
    auto_approve_low_risk: true,
    enabled: true,
  },
  {
    name: 'VPN Connection',
    description: 'Troubleshoot VPN connectivity and configuration issues.',
    category: 'network',
    trigger_keywords: ['vpn', 'remote access', 'tunnel', 'connect', 'disconnect', 'split tunnel'],
    system_prompt: 'You are an L1 support agent troubleshooting VPN connectivity. Read the ticket to identify the VPN client and specific issue. Check device inventory for the VPN client version and configuration. Common fixes: restart the VPN service, flush DNS, check firewall rules. Propose scripts to restart the VPN service or reset the connection. For certificate or authentication issues, hand off with diagnostic details.',
    max_steps: 5,
    auto_approve_low_risk: true,
    enabled: true,
  },
]

/** List playbooks for a tenant, optionally filtered by category or enabled status. */
export async function listPlaybooks(
  pool: DbPool,
  tenantId: string,
  filters: { category?: string; enabled?: boolean; search?: string } = {},
): Promise<Playbook[]> {
  return withTenant(pool, tenantId, async (client) => {
    const conditions: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    if (filters.category) {
      params.push(filters.category)
      conditions.push(`category = $${params.length}`)
    }
    if (filters.enabled !== undefined) {
      params.push(filters.enabled)
      conditions.push(`enabled = $${params.length}`)
    }
    if (filters.search) {
      params.push(`%${filters.search}%`)
      conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`)
    }
    const { rows } = await client.query(
      `SELECT * FROM ai_playbooks WHERE ${conditions.join(' AND ')} ORDER BY name ASC`,
      params,
    )
    return rows
  })
}

/** Get a single playbook by ID. */
export async function getPlaybook(pool: DbPool, tenantId: string, playbookId: string): Promise<Playbook> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM ai_playbooks WHERE id = $1', [playbookId])
    if (!rows[0]) throw AppError.notFound('Playbook not found')
    return rows[0]
  })
}

/** Create a custom playbook. */
export async function createPlaybook(
  pool: DbPool,
  tenantId: string,
  data: { name: string; description: string; category: string; trigger_keywords: string[]; system_prompt: string; max_steps: number; auto_approve_low_risk: boolean },
): Promise<Playbook> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ai_playbooks (tenant_id, name, description, category, trigger_keywords, system_prompt, max_steps, auto_approve_low_risk)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, data.name, data.description, data.category, data.trigger_keywords, data.system_prompt, data.max_steps, data.auto_approve_low_risk],
    )
    return rows[0]
  })
}

/** Update a playbook. */
export async function updatePlaybook(
  pool: DbPool,
  tenantId: string,
  playbookId: string,
  patch: PlaybookPatch,
): Promise<Playbook> {
  return withTenant(pool, tenantId, async (client) => {
    const current = (await client.query('SELECT * FROM ai_playbooks WHERE id = $1', [playbookId])).rows[0]
    if (!current) throw AppError.notFound('Playbook not found')
    const updates: string[] = []
    const params: unknown[] = [playbookId]
    if (patch.name !== undefined) { params.push(patch.name); updates.push(`name = $${params.length}`) }
    if (patch.description !== undefined) { params.push(patch.description); updates.push(`description = $${params.length}`) }
    if (patch.category !== undefined) { params.push(patch.category); updates.push(`category = $${params.length}`) }
    if (patch.trigger_keywords !== undefined) { params.push(patch.trigger_keywords); updates.push(`trigger_keywords = $${params.length}`) }
    if (patch.system_prompt !== undefined) { params.push(patch.system_prompt); updates.push(`system_prompt = $${params.length}`) }
    if (patch.max_steps !== undefined) { params.push(patch.max_steps); updates.push(`max_steps = $${params.length}`) }
    if (patch.auto_approve_low_risk !== undefined) { params.push(patch.auto_approve_low_risk); updates.push(`auto_approve_low_risk = $${params.length}`) }
    if (patch.enabled !== undefined) { params.push(patch.enabled); updates.push(`enabled = $${params.length}`) }
    if (updates.length === 0) return current
    updates.push('updated_at = now()')
    const { rows } = await client.query(
      `UPDATE ai_playbooks SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    )
    return rows[0]
  })
}

/** Delete a playbook. Built-in playbooks cannot be deleted. */
export async function deletePlaybook(pool: DbPool, tenantId: string, playbookId: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rowCount } = await client.query('DELETE FROM ai_playbooks WHERE id = $1', [playbookId])
    if (!rowCount) throw AppError.notFound('Playbook not found')
  })
}

/**
 * Match a ticket subject/conversation against playbook trigger keywords
 * and return the best matching playbook (highest keyword match count).
 */
export async function matchPlaybook(
  pool: DbPool,
  tenantId: string,
  ticketSubject: string,
  ticketBody: string,
): Promise<Playbook | null> {
  const playbooks = await listPlaybooks(pool, tenantId, { enabled: true })
  if (playbooks.length === 0) return null
  const text = `${ticketSubject} ${ticketBody}`.toLowerCase()
  let best: Playbook | null = null
  let bestScore = 0
  for (const pb of playbooks) {
    const score = pb.trigger_keywords.filter((kw) => text.includes(kw.toLowerCase())).length
    if (score > bestScore) {
      bestScore = score
      best = pb
    }
  }
  return bestScore >= 1 ? best : null
}

/** Increment usage count and update success rate for a playbook. */
export async function recordPlaybookUsage(
  pool: DbPool,
  tenantId: string,
  playbookId: string,
  success: boolean,
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE ai_playbooks
       SET usage_count = usage_count + 1,
           success_rate = CASE
             WHEN success THEN (success_rate * usage_count + 1) / (usage_count + 1)
             ELSE (success_rate * usage_count) / (usage_count + 1)
           END,
           updated_at = now()
       WHERE id = $1`,
      [playbookId],
    )
  })
}

/**
 * Seed built-in playbooks for a tenant. Called during tenant creation
 * or can be run manually to backfill.
 */
export async function seedBuiltInPlaybooks(pool: DbPool, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    let seeded = 0
    for (const pb of BUILT_IN_PLAYBOOKS) {
      const exists = await client.query(
        'SELECT 1 FROM ai_playbooks WHERE tenant_id = $1 AND name = $2',
        [tenantId, pb.name],
      )
      if (exists.rows[0]) continue
      await client.query(
        `INSERT INTO ai_playbooks (tenant_id, name, description, category, trigger_keywords, system_prompt, max_steps, auto_approve_low_risk)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, pb.name, pb.description, pb.category, pb.trigger_keywords, pb.system_prompt, pb.max_steps, pb.auto_approve_low_risk],
      )
      seeded++
    }
    return seeded
  })
}
