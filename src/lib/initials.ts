/** First letter of each word in a display name (e.g. "Diego Raygada" → "DR"). */
function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

/** Derive up to two initials from the local part of an email when name is missing. */
function initialsFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim()
  if (!local) return ''

  const parts = local.split(/[._-]+/).filter(p => /[a-zA-Z]/.test(p))
  if (parts.length >= 2) {
    return parts
      .slice(0, 2)
      .map(p => p.match(/[a-zA-Z]/)?.[0] ?? '')
      .join('')
      .toUpperCase()
  }

  const letters = local.replace(/[^a-zA-Z]/g, '')
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase()
  if (letters.length === 1) return letters.toUpperCase()
  return local.slice(0, 2).toUpperCase()
}

export function getInitials(
  name: string | null | undefined,
  email?: string | null | undefined,
): string {
  const trimmedName = name?.trim()
  if (trimmedName) return initialsFromName(trimmedName)

  const trimmedEmail = email?.trim()
  if (trimmedEmail) {
    const fromEmail = initialsFromEmail(trimmedEmail)
    if (fromEmail) return fromEmail
  }

  return '?'
}
