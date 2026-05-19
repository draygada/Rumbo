/** First letter of the name, plus the first letter after each space (e.g. "Diego Raygada" → "DR"). */
export function getInitials(name: string | null | undefined): string {
  const trimmed = name?.trim()
  if (!trimmed) return '?'

  return trimmed
    .split(/\s+/)
    .map(part => part[0])
    .join('')
    .toUpperCase()
}
