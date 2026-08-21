import { api } from './api.js'

export interface DirectoryPerson {
  id: string
  name: string
  email: string
  phone: string | null
  department: string | null
  site: string | null
  jobTitle: string | null
  staffId: string | null
  accountStatus: string
}

export function searchDirectory(q: string): Promise<{ contacts: DirectoryPerson[] }> {
  return api(`/directory/search?q=${encodeURIComponent(q)}`)
}
