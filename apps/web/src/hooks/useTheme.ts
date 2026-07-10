import { useEffect, useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'rumbo:theme'

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return pref
}

/** Apply the theme to <html>. Called once on load and on every change. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement
  root.dataset.theme = resolve(pref)
}

const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    if (readStoredPreference() === 'system') {
      applyTheme('system')
      cb()
    }
  }
  mql?.addEventListener?.('change', onSystemChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(readStoredPreference())
      cb()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    mql?.removeEventListener?.('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

function getSnapshot(): ThemePreference {
  return readStoredPreference()
}

function getServerSnapshot(): ThemePreference {
  return 'system'
}

export function setThemePreference(pref: ThemePreference): void {
  window.localStorage.setItem(STORAGE_KEY, pref)
  applyTheme(pref)
  for (const cb of listeners) cb()
}

/** Subscribe to the current theme preference and its resolved value. */
export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference: (p: ThemePreference) => void } {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const resolved: ResolvedTheme = resolve(preference)
  useEffect(() => { applyTheme(preference) }, [preference])
  return { preference, resolved, setPreference: setThemePreference }
}
