/** Roles that represent the end-user / operator message in chat history (gateway variants). */
const USER_FACING_ROLES = new Set(['user', 'human', 'client', 'end_user', 'person', 'customer'])

export function normalizeEndUserRole(role: string | undefined | null): string {
  if (role == null || role === '') return 'assistant'
  const r = String(role).trim().toLowerCase()
  if (USER_FACING_ROLES.has(r)) return 'user'
  return String(role).trim()
}

export function isUserFacingRole(role: string | undefined | null, kind?: string | undefined | null): boolean {
  if (kind === 'user') return true
  return normalizeEndUserRole(role) === 'user'
}
