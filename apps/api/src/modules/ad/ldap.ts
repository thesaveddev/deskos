import * as ldap from 'ldapjs'
import { AppError } from '../../core/errors.js'

export interface AdUser {
  objectId: string
  upn: string
  displayName: string
  mail?: string
  department?: string
  employeeId?: string
  accountEnabled: boolean
  lockedOut?: boolean
}

/** A computer object discovered from on-prem AD (inventory only; no agent). */
export interface AdComputer {
  objectId: string
  name: string
  dnsHostName: string
  os: string
  osVersion: string
  serialNumber?: string
}

export interface AdConnectionSecrets {
  host: string
  port: number
  useSsl: boolean
  baseDn: string
  bindDn: string
  bindPassword: string
}

export type AdAction = 'resetPassword' | 'unlockAccount' | 'enableAccount' | 'disableAccount'

/**
 * Injectable seam around the on-prem directory so the control plane can be
 * tested without a domain controller. The production implementation is the
 * ldapjs transport below.
 */
export interface AdClient {
  listUsers(connection: AdConnectionSecrets): Promise<AdUser[]>
  listComputers(connection: AdConnectionSecrets): Promise<AdComputer[]>
  runAccountAction(connection: AdConnectionSecrets, action: AdAction, upn: string, newPassword?: string): Promise<string>
}

function escapeFilter(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00')
}

function first(entry: ldap.SearchEntry, name: string): string | undefined {
  const attr = entry.attributes.find((a) => a.type.toLowerCase() === name.toLowerCase())
  if (!attr) return undefined
  return Array.isArray(attr.values) ? attr.values[0] : attr.values
}

function mapEntry(entry: ldap.SearchEntry): AdUser {
  const uac = Number.parseInt(first(entry, 'userAccountControl') ?? '512', 10)
  const lockoutTime = first(entry, 'lockoutTime')
  const guid = first(entry, 'objectGUID') ?? first(entry, 'objectSid')
  const upn = first(entry, 'userPrincipalName') ?? ''
  return {
    objectId: guid ?? entry.objectName ?? entry.dn,
    upn,
    displayName: first(entry, 'displayName') ?? upn,
    mail: first(entry, 'mail'),
    department: first(entry, 'department'),
    employeeId: first(entry, 'employeeID') ?? first(entry, 'employeeNumber'),
    accountEnabled: (uac & 0x0002) === 0,
    lockedOut: lockoutTime !== undefined && lockoutTime !== '0',
  }
}

function mapComputerEntry(entry: ldap.SearchEntry): AdComputer {
  const guid = first(entry, 'objectGUID') ?? first(entry, 'objectSid')
  const cn = first(entry, 'cn') ?? first(entry, 'name') ?? ''
  return {
    objectId: guid ?? entry.objectName ?? entry.dn,
    name: cn,
    dnsHostName: first(entry, 'dnsHostName') ?? cn,
    os: first(entry, 'operatingSystem') ?? '',
    osVersion: first(entry, 'operatingSystemVersion') ?? '',
    serialNumber: first(entry, 'serialNumber'),
  }
}

function connect(conn: AdConnectionSecrets): Promise<ldap.Client> {
  const scheme = conn.useSsl ? 'ldaps' : 'ldap'
  const client = ldap.createClient({
    url: `${scheme}://${conn.host}:${conn.port}`,
    reconnect: false,
    timeout: 15000,
    connectTimeout: 15000,
  })
  return new Promise((resolve, reject) => {
    client.bind(conn.bindDn, conn.bindPassword, (err) => {
      if (err) {
        client.destroy?.()
        reject(new AppError(502, 'ad_bind_failed', `LDAP bind failed: ${err.message}`))
        return
      }
      resolve(client)
    })
  })
}

interface AdEntryRef {
  dn: string
  userAccountControl: number
}

function findUser(client: ldap.Client, conn: AdConnectionSecrets, upn: string): Promise<AdEntryRef> {
  return new Promise((resolve, reject) => {
    client.search(
      conn.baseDn,
      { scope: 'sub', filter: `(userPrincipalName=${escapeFilter(upn)})`, attributes: ['userAccountControl'] },
      (err, res) => {
        if (err) {
          reject(new AppError(502, 'ad_search_failed', `LDAP search failed: ${err.message}`))
          return
        }
        let found: AdEntryRef | null = null
        res.on('searchEntry', (entry) => {
          if (!found) {
            const uac = Number.parseInt(first(entry, 'userAccountControl') ?? '512', 10)
            found = { dn: entry.objectName ?? entry.dn, userAccountControl: uac }
          }
        })
        res.on('error', (e: Error) => reject(new AppError(502, 'ad_search_failed', e.message)))
        res.on('end', () => {
          if (found) resolve(found)
          else reject(new AppError(404, 'ad_user_not_found', `No AD user with UPN ${upn}`))
        })
      },
    )
  })
}

function modify(client: ldap.Client, dn: string, change: ldap.Change): Promise<void> {
  return new Promise((resolve, reject) => {
    client.modify(dn, change, (err) => {
      if (err) reject(new AppError(502, 'ad_modify_failed', `LDAP modify failed: ${err.message}`))
      else resolve()
    })
  })
}

function quotedUnicodePwd(password: string): Buffer {
  const quoted = `"${password}"`
  const buf = Buffer.alloc(quoted.length * 2)
  for (let i = 0; i < quoted.length; i += 1) buf.writeUInt16LE(quoted.charCodeAt(i), i * 2)
  return buf
}

export const adClient: AdClient = {
  async listUsers(connection) {
    const client = await connect(connection)
    try {
      return await new Promise<AdUser[]>((resolve, reject) => {
        client.search(
          connection.baseDn,
          {
            scope: 'sub',
            filter: '(objectCategory=person)',
            attributes: ['objectGUID', 'objectSid', 'userPrincipalName', 'displayName', 'mail', 'department', 'employeeID', 'employeeNumber', 'userAccountControl', 'lockoutTime'],
          },
          (err, res) => {
            if (err) {
              reject(new AppError(502, 'ad_search_failed', `LDAP search failed: ${err.message}`))
              return
            }
            const users: AdUser[] = []
            res.on('searchEntry', (entry) => users.push(mapEntry(entry)))
            res.on('error', (e: Error) => reject(new AppError(502, 'ad_search_failed', e.message)))
            res.on('end', () => resolve(users))
          },
        )
      })
    } finally {
      client.unbind()
    }
  },

  async listComputers(connection) {
    const client = await connect(connection)
    try {
      return await new Promise<AdComputer[]>((resolve, reject) => {
        client.search(
          connection.baseDn,
          {
            scope: 'sub',
            filter: '(objectCategory=computer)',
            attributes: ['objectGUID', 'objectSid', 'cn', 'name', 'dnsHostName', 'operatingSystem', 'operatingSystemVersion', 'serialNumber'],
          },
          (err, res) => {
            if (err) {
              reject(new AppError(502, 'ad_search_failed', `LDAP search failed: ${err.message}`))
              return
            }
            const computers: AdComputer[] = []
            res.on('searchEntry', (entry) => computers.push(mapComputerEntry(entry)))
            res.on('error', (e: Error) => reject(new AppError(502, 'ad_search_failed', e.message)))
            res.on('end', () => resolve(computers))
          },
        )
      })
    } finally {
      client.unbind()
    }
  },

  async runAccountAction(connection, action, upn, newPassword) {
    if (action === 'resetPassword') {
      if (!newPassword) throw new AppError(400, 'new_password_required', 'A new password is required')
      if (!connection.useSsl) throw new AppError(400, 'ad_ldaps_required', 'Password reset requires an LDAPS (SSL) connection')
    }
    const client = await connect(connection)
    try {
      const user = await findUser(client, connection, upn)
      switch (action) {
        case 'resetPassword':
          await modify(client, user.dn, { operation: 'replace', modification: { unicodePwd: quotedUnicodePwd(newPassword!) } })
          return 'Password reset requested'
        case 'unlockAccount':
          await modify(client, user.dn, { operation: 'replace', modification: { lockoutTime: '0' } })
          return 'Account unlocked'
        case 'disableAccount':
          await modify(client, user.dn, { operation: 'replace', modification: { userAccountControl: String(user.userAccountControl | 0x0002) } })
          return 'Account disabled'
        case 'enableAccount':
          await modify(client, user.dn, { operation: 'replace', modification: { userAccountControl: String(user.userAccountControl & ~0x0002) } })
          return 'Account enabled'
      }
    } finally {
      client.unbind()
    }
  },
}
