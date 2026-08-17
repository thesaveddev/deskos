import bcrypt from 'bcryptjs'

export async function hashPassword(plain: string, rounds: number): Promise<string> {
  return bcrypt.hash(plain, rounds)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false
  return bcrypt.compare(plain, hash)
}
