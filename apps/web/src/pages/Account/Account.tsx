import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, signOut } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import { resolveDisplayName } from '../../lib/displayName'
import { updateName, updateFieldOfStudy, uploadAvatar, removeAvatar } from '../../lib/profile'
import { supabase } from '../../lib/supabase'
import styles from './Account.module.css'

function memberSince(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export default function Account() {
  const { session, profile } = useAuth()
  const navigate = useNavigate()
  const userId = session?.user?.id ?? null

  const displayName = resolveDisplayName(profile, session?.user?.user_metadata)
  const email = profile?.email ?? session?.user?.email ?? ''
  const initials = getInitials(displayName, email || null)
  const avatarUrl =
    profile?.avatar_url ??
    (typeof session?.user?.user_metadata?.avatar_url === 'string'
      ? session.user.user_metadata.avatar_url
      : null)

  // ─── Name ──────────────────────────────────────────────────────────────
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [nameMessage, setNameMessage] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)
  // Tracks whether the user has started editing, so a profile refetch (which
  // fires on every save via USER_UPDATED) can't clobber what they're typing.
  const nameTouched = useRef(false)

  useEffect(() => {
    if (nameTouched.current) return
    setFirstName(profile?.first_name ?? '')
    setLastName(profile?.last_name ?? '')
  }, [profile?.first_name, profile?.last_name])

  async function handleNameSave() {
    if (!userId) return
    setSavingName(true)
    setNameMessage(null)
    try {
      await updateName(userId, { first_name: firstName, last_name: lastName })
      nameTouched.current = false
      setNameMessage('Saved.')
    } catch (err) {
      setNameMessage(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingName(false)
    }
  }

  // ─── Avatar ────────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null)

  async function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Clear immediately so picking the same file twice still fires onChange.
    e.target.value = ''
    if (!file || !userId) return
    setAvatarBusy(true)
    setAvatarMessage(null)
    try {
      await uploadAvatar(userId, file, avatarUrl)
    } catch (err) {
      setAvatarMessage(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleAvatarRemove() {
    if (!userId) return
    setAvatarBusy(true)
    setAvatarMessage(null)
    try {
      await removeAvatar(userId, avatarUrl)
    } catch (err) {
      setAvatarMessage(err instanceof Error ? err.message : 'Failed to remove')
    } finally {
      setAvatarBusy(false)
    }
  }

  // ─── Field of study ────────────────────────────────────────────────────
  const [fieldOfStudy, setFieldOfStudy] = useState('')
  const [fieldMessage, setFieldMessage] = useState<string | null>(null)
  const [savingField, setSavingField] = useState(false)

  useEffect(() => {
    if (!session) return
    let ignore = false
    ;(async () => {
      try {
        const { data } = await supabase
          .from('users')
          .select('field_of_study')
          .eq('id', session.user.id)
          .maybeSingle()
        if (ignore) return
        setFieldOfStudy(current => current ? current : (data?.field_of_study as string | undefined) ?? '')
      } catch {
        // leave empty — user can type it in.
      }
    })()
    return () => { ignore = true }
  }, [session])

  async function handleFieldSave() {
    if (!userId) return
    setSavingField(true)
    setFieldMessage(null)
    try {
      await updateFieldOfStudy(userId, fieldOfStudy)
      setFieldMessage('Saved.')
    } catch (err) {
      setFieldMessage(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingField(false)
    }
  }

  async function handleSignOut() {
    await signOut()
    navigate('/signin')
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Account</h1>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.userRow}>
            {avatarUrl ? (
              <img className={styles.avatarImage} src={avatarUrl} alt="" />
            ) : (
              <div className={styles.avatar}>{initials}</div>
            )}
            <div className={styles.userMeta}>
              <p className={styles.username}>{displayName || email}</p>
              <p className={styles.email}>{email}</p>
              <div className={styles.avatarActions}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => fileRef.current?.click()}
                  disabled={avatarBusy}
                >
                  {avatarBusy ? 'Working…' : avatarUrl ? 'Change photo' : 'Upload photo'}
                </button>
                {avatarUrl && !avatarBusy && (
                  <button type="button" className={styles.linkButtonMuted} onClick={handleAvatarRemove}>
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                className={styles.srOnly}
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarPick}
              />
            </div>
          </div>
          {avatarMessage && (
            <p className={styles.fieldMessage} role="status" aria-live="polite">{avatarMessage}</p>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Name</h2>
          <p className={styles.sectionDesc}>
            How Rumbo greets you and signs your work.
          </p>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="first-name">First name</label>
              <input
                id="first-name"
                type="text"
                className={styles.input}
                placeholder="Diego"
                value={firstName}
                onChange={e => { nameTouched.current = true; setFirstName(e.target.value) }}
                disabled={savingName}
                autoComplete="given-name"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="last-name">Last name</label>
              <input
                id="last-name"
                type="text"
                className={styles.input}
                placeholder="Raygada"
                value={lastName}
                onChange={e => { nameTouched.current = true; setLastName(e.target.value) }}
                disabled={savingName}
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleNameSave}
              disabled={savingName}
            >
              {savingName ? 'Saving…' : 'Save'}
            </button>
          </div>
          {nameMessage && <p className={styles.fieldMessage} role="status" aria-live="polite">{nameMessage}</p>}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Field of study</h2>
          <p className={styles.sectionDesc}>
            Used to personalize copy. Doesn't affect what Rumbo ingests.
          </p>
          <div className={styles.fieldRow}>
            <label className={styles.srOnly} htmlFor="field-of-study">Field of study</label>
            <input
              id="field-of-study"
              type="text"
              className={styles.input}
              placeholder="e.g. Computer Science"
              value={fieldOfStudy}
              onChange={e => setFieldOfStudy(e.target.value)}
              disabled={savingField}
            />
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleFieldSave}
              disabled={savingField}
            >
              {savingField ? 'Saving…' : 'Save'}
            </button>
          </div>
          {fieldMessage && <p className={styles.fieldMessage} role="status" aria-live="polite">{fieldMessage}</p>}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Details</h2>
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt className={styles.detailKey}>Email</dt>
              <dd className={styles.detailValue}>{email || '—'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailKey}>Plan</dt>
              <dd className={styles.detailValue}>{profile?.tier === 'premium' ? 'Premium' : 'Free'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt className={styles.detailKey}>Member since</dt>
              <dd className={styles.detailValue}>{memberSince(profile?.created_at)}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.section}>
          <button className={styles.signOutButton} onClick={handleSignOut}>
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
