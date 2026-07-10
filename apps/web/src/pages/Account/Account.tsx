import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, signOut } from '../../hooks/useAuth'
import { getInitials } from '../../lib/initials'
import { supabase } from '../../lib/supabase'
import styles from './Account.module.css'

export default function Account() {
  const { session, profile } = useAuth()
  const navigate = useNavigate()

  const composedName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim()
  const meta = session?.user?.user_metadata ?? {}
  const metaComposed = [meta.first_name, meta.last_name].filter((p): p is string => typeof p === 'string' && Boolean(p.trim())).join(' ').trim()
  const displayName =
    composedName ||
    profile?.name?.trim() ||
    metaComposed ||
    (typeof meta.name === 'string' ? meta.name : '') ||
    (typeof meta.full_name === 'string' ? meta.full_name : '') ||
    ''
  const initials = getInitials(displayName, profile?.email ?? session?.user?.email ?? null)

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
    if (!session) return
    setSavingField(true)
    setFieldMessage(null)
    try {
      const { error } = await supabase
        .from('users')
        .update({ field_of_study: fieldOfStudy.trim() || null })
        .eq('id', session.user.id)
      if (error) throw error
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
            <div className={styles.avatar}>{initials}</div>
            <div>
              <p className={styles.username}>{displayName || profile?.email || session?.user?.email}</p>
              <p className={styles.email}>{profile?.email ?? session?.user?.email}</p>
            </div>
          </div>
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
          <button className={styles.signOutButton} onClick={handleSignOut}>
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}
