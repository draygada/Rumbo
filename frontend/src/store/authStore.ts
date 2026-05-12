import { create } from 'zustand'
import type { Session } from '@supabase/supabase-js'
import { Store } from '@tauri-apps/plugin-store'

import { assertSupabaseConfigured, supabase } from '../lib/supabase'
import type { User } from '../types'

async function emitAuthSession(loggedIn: boolean) {
  if (!isTauriRuntime()) return
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit('rumbo:auth-session', loggedIn)
  } catch {
    // fail silently
  }
}

type AuthState = {
  user: User | null
  session: Session | null
  initializing: boolean
  error: string | null

  initialize: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  resendSignupConfirmation: (email: string) => Promise<void>
  signOut: () => Promise<void>
}

const AUTH_STORE_FILE = 'rumbo.auth.json'
const SESSION_KEY = 'supabase.session'

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w
}

function toRumboUser(session: Session | null): User | null {
  const u = session?.user
  if (!u?.id || !u.email) return null

  return {
    id: u.id,
    email: u.email,
    name: (u.user_metadata?.name as string | undefined) ?? null,
    tier: 'free',
    stripe_customer_id: null,
    stripe_sub_id: null,
    onboarding_step: '1',
    onboarding_q1: null,
    onboarding_q2_before: null,
    onboarding_q2_after: null,
    onboarding_q3: null,
    onboarding_q4: null,
    created_at: u.created_at ?? new Date().toISOString(),
  }
}

async function persistSession(session: Session | null) {
  if (!isTauriRuntime()) return
  const store = await Store.load(AUTH_STORE_FILE)
  if (!session) {
    await store.delete(SESSION_KEY)
    await store.save()
    return
  }

  await store.set(SESSION_KEY, {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  await store.save()
}

async function restoreSession(): Promise<Session | null> {
  assertSupabaseConfigured()
  if (!isTauriRuntime()) {
    const { data } = await supabase!.auth.getSession()
    return data.session
  }

  const store = await Store.load(AUTH_STORE_FILE)
  const saved = (await store.get(SESSION_KEY)) as
    | { access_token?: string; refresh_token?: string }
    | null
    | undefined

  const access_token = saved?.access_token
  const refresh_token = saved?.refresh_token
  if (!access_token || !refresh_token) return null

  const { data, error } = await supabase!.auth.setSession({
    access_token,
    refresh_token,
  })
  if (error) return null
  return data.session
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  initializing: true,
  error: null,

  initialize: async () => {
    set({ initializing: true, error: null })
    try {
      assertSupabaseConfigured()
      let restored: Session | null = null
      try {
        restored = await restoreSession()
      } catch {
        const { data } = await supabase!.auth.getSession()
        restored = data.session
      }
      set({ session: restored, user: toRumboUser(restored) })
      void emitAuthSession(!!restored)

      supabase!.auth.onAuthStateChange(async (_event, session) => {
        set({ session, user: toRumboUser(session) })
        void emitAuthSession(!!session)
        try {
          await persistSession(session)
        } catch {
          // If Tauri store fails for any reason, don't block auth.
        }
      })
    } catch (e) {
      set({ session: null, user: null, error: (e as Error).message ?? 'Auth init failed' })
      void emitAuthSession(false)
    } finally {
      set({ initializing: false })
    }
  },

  signIn: async (email, password) => {
    set({ error: null })
    assertSupabaseConfigured()
    const { data, error } = await supabase!.auth.signInWithPassword({ email, password })
    if (error) {
      set({ error: error.message })
      return
    }
    set({ session: data.session, user: toRumboUser(data.session) })
    void emitAuthSession(!!data.session)
    try {
      await persistSession(data.session)
    } catch {
      // fail silently; tray + rest of app should still work
    }
  },

  signUp: async (email, password, name) => {
    set({ error: null })
    assertSupabaseConfigured()
    // No email verification at MVP — Supabase project must have email confirmation disabled.
    // Name is passed in user_metadata so the DB trigger can write it to users.name.
    const { data, error } = await supabase!.auth.signUp({
      email,
      password,
      options: { data: { name } },
    })
    if (error) {
      set({ error: error.message })
      return
    }
    // session may be null if Supabase email confirmation is enabled —
    // the form detects this and shows the "check your email" screen.
    set({ session: data.session, user: toRumboUser(data.session) })
    void emitAuthSession(!!data.session)
    try {
      await persistSession(data.session)
    } catch {
      // fail silently
    }
  },

  resendSignupConfirmation: async (email) => {
    set({ error: null })
    assertSupabaseConfigured()
    const { error } = await supabase!.auth.resend({ type: 'signup', email })
    if (error) set({ error: error.message })
  },

  signOut: async () => {
    set({ error: null })
    if (supabase) await supabase.auth.signOut()
    set({ session: null, user: null })
    void emitAuthSession(false)
    try {
      await persistSession(null)
    } catch {
      // fail silently
    }
  },
}))
