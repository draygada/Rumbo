import { supabase } from './supabase'

/*
 * Writes to the signed-in user's own profile.
 *
 * Every function here does the same two things, and the second is not
 * optional: it writes public.users AND mirrors the change into the auth
 * user's metadata.
 *
 *  - public.users is the source of truth. `name` is a GENERATED column, so
 *    only first_name / last_name are ever written; Postgres computes the rest.
 *  - supabase.auth.updateUser fires an onAuthStateChange('USER_UPDATED') event.
 *    useAuth is a per-component useState hook, so Home, the rail and the
 *    account page each hold their own copy of the profile — without that event
 *    a save would update the page you're on and leave the greeting stale until
 *    a reload. The metadata write is also what lib/displayName falls back to
 *    when the users row is empty, so the two must not drift.
 */

const AVATAR_BUCKET = 'avatars'
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const ALLOWED_AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface NamePatch {
  first_name: string | null
  last_name: string | null
}

export async function updateName(userId: string, patch: NamePatch): Promise<void> {
  const first_name = patch.first_name?.trim() || null
  const last_name = patch.last_name?.trim() || null

  const { error } = await supabase
    .from('users')
    .update({ first_name, last_name })
    .eq('id', userId)
  if (error) throw error

  const { error: metaError } = await supabase.auth.updateUser({
    data: { first_name, last_name },
  })
  if (metaError) throw metaError
}

export async function updateFieldOfStudy(userId: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ field_of_study: value.trim() || null })
    .eq('id', userId)
  if (error) throw error
}

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase()
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName
  return file.type.split('/')[1] ?? 'png'
}

/**
 * Upload a new avatar and point the profile at it.
 *
 * Uploads under a fresh uuid rather than a fixed filename: a stable path would
 * be cached by the browser and the CDN, so a replaced picture would keep
 * showing the old one. The previous object is deleted afterwards, and a
 * failure to delete is swallowed — an orphaned file is not worth failing the
 * save the user actually asked for.
 */
export async function uploadAvatar(userId: string, file: File, previousUrl: string | null): Promise<string> {
  if (!ALLOWED_AVATAR_MIME.has(file.type)) {
    throw new Error('Pick a PNG, JPEG, WebP or GIF image.')
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error('That image is over 5 MB. Pick a smaller one.')
  }

  const path = `${userId}/${crypto.randomUUID()}.${extensionFor(file)}`
  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) throw uploadError

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
  const avatar_url = data.publicUrl

  const { error } = await supabase.from('users').update({ avatar_url }).eq('id', userId)
  if (error) throw error

  await supabase.auth.updateUser({ data: { avatar_url } })
  await removeAvatarObject(previousUrl)

  return avatar_url
}

export async function removeAvatar(userId: string, previousUrl: string | null): Promise<void> {
  const { error } = await supabase.from('users').update({ avatar_url: null }).eq('id', userId)
  if (error) throw error
  await supabase.auth.updateUser({ data: { avatar_url: null } })
  await removeAvatarObject(previousUrl)
}

/** Best-effort cleanup of the storage object behind a public avatar URL. */
async function removeAvatarObject(publicUrl: string | null): Promise<void> {
  if (!publicUrl) return
  const marker = `/${AVATAR_BUCKET}/`
  const at = publicUrl.indexOf(marker)
  if (at === -1) return
  const path = publicUrl.slice(at + marker.length)
  if (!path) return
  try {
    await supabase.storage.from(AVATAR_BUCKET).remove([path])
  } catch {
    // Orphaned object; not worth surfacing.
  }
}
