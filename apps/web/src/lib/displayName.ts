import type { User } from '../types'

/*
 * One answer to "what do we call this person".
 *
 * There are two independent places a name can live and they don't always
 * agree: public.users (first_name / last_name, with `name` as a generated
 * column) and the auth user's metadata, written at sign-up. If the users-row
 * upsert fails but auth succeeds — which is exactly what the error logging in
 * useAuth.signUp exists to catch — the profile row has no name at all while
 * the metadata does.
 *
 * Account.tsx already walked the full chain. The greeting on Home and the
 * label in the rail only read the generated `name` column, so for a profile
 * in that state they both fell through to the email local part and greeted
 * the user as "Draygada2006". Same derivation, three copies, two of them
 * wrong — hence this module.
 */

/** Shape of supabase auth `user_metadata`; every field is untrusted. */
export interface AuthMetadata {
  first_name?: unknown
  last_name?: unknown
  name?: unknown
  full_name?: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Full name, best available. Empty string when nothing usable exists. */
export function resolveDisplayName(
  profile: User | null | undefined,
  meta: AuthMetadata = {},
): string {
  const fromProfile = [profile?.first_name, profile?.last_name].map(str).filter(Boolean).join(' ')
  const fromMeta = [meta.first_name, meta.last_name].map(str).filter(Boolean).join(' ')
  return (
    fromProfile ||
    str(profile?.name) ||
    fromMeta ||
    str(meta.name) ||
    str(meta.full_name) ||
    ''
  )
}

/**
 * Just the given name, for greetings. Prefers a real first_name over splitting
 * a full name, so "Diego Andres Raygada" greets as "Diego" either way.
 *
 * The email local part is deliberately NOT a fallback: "draygada2006" is an
 * account handle, not a name, and greeting someone by it reads worse than not
 * using a name at all. `fallback` covers that case.
 */
export function resolveFirstName(
  profile: User | null | undefined,
  meta: AuthMetadata = {},
  fallback = 'there',
): string {
  const explicit = str(profile?.first_name) || str(meta.first_name)
  if (explicit) return explicit

  const full = resolveDisplayName(profile, meta)
  const firstWord = full.split(/\s+/).filter(Boolean)[0]
  return firstWord || fallback
}
