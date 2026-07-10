import { useEffect, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { User } from '../types'

interface AuthState {
  session: Session | null
  profile: User | null
  loading: boolean
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    session: null,
    profile: null,
    loading: true,
  })

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        fetchProfile(session.user.id).then((profile) => {
          setState({ session, profile, loading: false })
        })
      } else {
        setState({ session: null, profile: null, loading: false })
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session) {
          fetchProfile(session.user.id).then((profile) => {
            setState({ session, profile, loading: false })
          })
        } else {
          setState({ session: null, profile: null, loading: false })
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  return state
}

async function fetchProfile(userId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) return null
  return data as User
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
}

export async function signUp(email: string, password: string, firstName: string, lastName: string) {
  const first = firstName.trim()
  const last = lastName.trim()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Stored on auth.users.raw_user_meta_data; handle_new_auth_user() reads
      // these when creating the public.users row.
      data: { first_name: first, last_name: last },
    },
  })
  if (error) {
    console.error('[auth.signUp] Supabase signUp failed', {
      email,
      message: error.message,
      status: error.status,
      name: error.name,
      code: (error as { code?: string }).code,
      fullError: error,
    })
    throw error
  }
  if (!data.user) {
    console.error('[auth.signUp] No user returned from Supabase', {
      email,
      data,
    })
    throw new Error('Sign up failed')
  }

  // Upsert so we tolerate the case where the auth trigger already inserted the
  // row via handle_new_auth_user (hosted Supabase). The generated `name` column
  // is not inserted — Postgres computes it from first_name + last_name.
  const { error: profileError } = await supabase.from('users').upsert(
    { id: data.user.id, email, first_name: first, last_name: last },
    { onConflict: 'id' },
  )
  if (profileError) {
    console.error('[auth.signUp] Failed upserting profile row', {
      userId: data.user.id,
      email,
      first,
      last,
      message: profileError.message,
      code: profileError.code,
      details: profileError.details,
      hint: profileError.hint,
      fullError: profileError,
    })
    throw profileError
  }

  console.log('[auth.signUp] Signup + profile upsert succeeded', {
    userId: data.user.id,
    email,
  })
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
