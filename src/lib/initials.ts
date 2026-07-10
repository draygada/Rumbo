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

/** Derive an initial from the local part of an email when name is missing.
 *  Multi-part locals ("first.last", "first_last") return two letters; a single
 *  undelimited local ("diegoray") returns just the first letter — guessing at a
 *  name boundary reads worse than a single clean letter. */
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

  const first = local.match(/[a-zA-Z]/)?.[0]
  return first ? first.toUpperCase() : ''
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
