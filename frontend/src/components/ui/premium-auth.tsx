'use client'

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from 'lucide-react'

import { useAuthStore } from '@/store/authStore'
import rumboLogo from '@/assets/rumbo-logo.png'

type AuthMode = 'login' | 'signup'

interface AuthFormProps {
  initialMode?: AuthMode
  className?: string
}

interface FormData {
  email: string
  password: string
  confirmPassword: string
  name: string
}

interface FormErrors {
  email?: string
  password?: string
  confirmPassword?: string
  name?: string
  general?: string
}

const EMAIL_INVALID_MESSAGE = 'Email Invalid'
const ACCOUNT_EXISTS_MESSAGE = 'An Account with this email already exists'

function validateEmail(email: string) {
  if (!email.trim()) return EMAIL_INVALID_MESSAGE
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return EMAIL_INVALID_MESSAGE
  return ''
}

function validatePassword(password: string) {
  if (!password) return 'Password is required'
  if (password.length < 6) return 'Password must be at least 6 characters'
  if (!/[A-Za-z]/.test(password)) return 'Password must include at least one letter'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include at least one special character'
  return ''
}

export function AuthForm({ initialMode = 'login', className }: AuthFormProps) {
  const signIn = useAuthStore((s) => s.signIn)
  const signUp = useAuthStore((s) => s.signUp)
  const resendSignupConfirmation = useAuthStore((s) => s.resendSignupConfirmation)

  const storeError = useAuthStore((s) => s.error)
  const initializing = useAuthStore((s) => s.initializing)

  const [authMode, setAuthMode] = useState<AuthMode>(initialMode)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<string | null>(null)
  const [isResending, setIsResending] = useState(false)
  const [resendSent, setResendSent] = useState(false)

  const [formData, setFormData] = useState<FormData>({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const passwordDebounceRef = useRef<number | null>(null)
  const confirmDebounceRef = useRef<number | null>(null)

  useEffect(() => {
    setErrors({})
    setTouched({})
    setIsLoading(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setAwaitingConfirmation(null)
    setResendSent(false)
  }, [authMode])

  const mapSignupError = useCallback((message: string) => {
    const lower = message.toLowerCase()
    if (
      lower.includes('already registered') ||
      lower.includes('already exists') ||
      lower.includes('user already') ||
      lower.includes('email exists')
    ) {
      return ACCOUNT_EXISTS_MESSAGE
    }
    return EMAIL_INVALID_MESSAGE
  }, [])

  const validateField = useCallback(
    (field: keyof FormData, value: string) => {
      switch (field) {
        case 'email':
          return validateEmail(value)
        case 'password':
          return validatePassword(value)
        case 'confirmPassword':
          if (authMode !== 'signup') return ''
          if (!value) return 'Please confirm your password'
          if (value !== formData.password) return 'Passwords do not match'
          return ''
        case 'name':
          if (authMode !== 'signup') return ''
          if (!value.trim()) return 'Name is required'
          return ''
      }
    },
    [authMode, formData.password],
  )

  const setField = useCallback(
    (field: keyof FormData, value: string) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      if (field !== 'password' && field !== 'confirmPassword' && touched[field]) {
        const err = validateField(field, value)
        setErrors((prev) => ({ ...prev, [field]: err || undefined }))
      }
    },
    [touched, validateField],
  )

  const blurField = useCallback(
    (field: keyof FormData) => {
      setTouched((prev) => ({ ...prev, [field]: true }))
      const value = formData[field]
      const err = validateField(field, value)
      setErrors((prev) => ({ ...prev, [field]: err || undefined }))
    },
    [formData, validateField],
  )

  useEffect(() => {
    if (authMode !== 'signup') return
    if (passwordDebounceRef.current) window.clearTimeout(passwordDebounceRef.current)
    passwordDebounceRef.current = window.setTimeout(() => {
      const value = formData.password
      if (!value) { setErrors((prev) => ({ ...prev, password: undefined })); return }
      const err = validatePassword(value)
      setErrors((prev) => ({ ...prev, password: err || undefined }))
    }, 150)
    return () => { if (passwordDebounceRef.current) window.clearTimeout(passwordDebounceRef.current) }
  }, [authMode, formData.password])

  useEffect(() => {
    if (authMode !== 'signup') return
    if (confirmDebounceRef.current) window.clearTimeout(confirmDebounceRef.current)
    confirmDebounceRef.current = window.setTimeout(() => {
      const value = formData.confirmPassword
      if (!value) { setErrors((prev) => ({ ...prev, confirmPassword: undefined })); return }
      const err = value !== formData.password ? 'Passwords do not match' : ''
      setErrors((prev) => ({ ...prev, confirmPassword: err || undefined }))
    }, 150)
    return () => { if (confirmDebounceRef.current) window.clearTimeout(confirmDebounceRef.current) }
  }, [authMode, formData.confirmPassword, formData.password])

  const canSubmit = useMemo(() => {
    if (initializing || isLoading) return false
    if (authMode === 'login') {
      return !!formData.email.trim() && !!formData.password
    }
    return (
      !!formData.email.trim() &&
      !!formData.password &&
      !!formData.confirmPassword &&
      !!formData.name.trim()
    )
  }, [authMode, formData, initializing, isLoading])

  const validateForm = useCallback(() => {
    const next: FormErrors = {}
    const emailErr = validateEmail(formData.email)
    if (emailErr) next.email = emailErr
    const passErr = validatePassword(formData.password)
    if (passErr) next.password = passErr
    if (authMode === 'signup') {
      const confirmErr = validateField('confirmPassword', formData.confirmPassword)
      if (confirmErr) next.confirmPassword = confirmErr
      if (!formData.name.trim()) next.name = 'Name is required'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }, [authMode, formData, validateField])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return

    setIsLoading(true)
    setErrors({})

    try {
      const email = formData.email.trim()
      if (authMode === 'login') {
        await signIn(email, formData.password)
        const { error } = useAuthStore.getState()
        if (error) setErrors({ general: error })
      } else {
        await signUp(email, formData.password, formData.name.trim())
        const { error, session } = useAuthStore.getState()
        if (error) {
          setErrors({ general: mapSignupError(error) })
        } else if (!session) {
          // Supabase email confirmation is enabled — tell the user to check their inbox.
          setAwaitingConfirmation(email)
        }
        // If session exists, App.tsx picks it up automatically and routes to onboarding.
      }
    } catch (err) {
      const fallback = (err as Error).message ?? 'Authentication failed. Please try again.'
      setErrors({ general: authMode === 'signup' ? mapSignupError(fallback) : fallback })
    } finally {
      setIsLoading(false)
    }
  }

  const isSignup = authMode === 'signup'
  const generalError = errors.general || undefined

  return (
    <div className={cn('p-6', className)} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      {generalError ? (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          <span>{generalError}</span>
        </div>
      ) : null}

      <div className="text-center mb-8">
        <div className="flex justify-center mb-3">
          <img src={rumboLogo} alt="Rumbo" className="h-26 w-auto" />
        </div>
      </div>

      <div className="relative flex bg-black/5 rounded-xl p-1 mb-6">
        <div
          className={cn(
            'absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-lg bg-white shadow-sm',
            'transition-transform duration-500 ease-in-out',
            isSignup ? 'translate-x-full' : 'translate-x-0',
          )}
        />
        <button
          onClick={() => setAuthMode('login')}
          className={cn(
            'relative z-10 flex-1 py-2 px-4 rounded-lg text-sm font-semibold transition-colors duration-500',
            !isSignup ? 'text-rumbo-text' : 'text-black/60 hover:text-rumbo-text',
          )}
          type="button"
        >
          Login
        </button>
        <button
          onClick={() => setAuthMode('signup')}
          className={cn(
            'relative z-10 flex-1 py-2 px-4 rounded-lg text-sm font-semibold transition-colors duration-500',
            isSignup ? 'text-rumbo-text' : 'text-black/60 hover:text-rumbo-text',
          )}
          type="button"
        >
          Sign Up
        </button>
      </div>

      {awaitingConfirmation ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-[#6B7FBE]/20 bg-[#EEF0FA] px-4 py-4">
            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-[#6B7FBE]" />
              <div>
                <div className="text-sm font-semibold text-[#1A1A2E]">Check your email to confirm your account</div>
                <div className="mt-1 text-xs text-[#4A4A5A]">
                  We sent a confirmation link to <span className="font-medium">{awaitingConfirmation}</span>.
                  Open it to finish creating your account, then sign in.
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={isResending}
            onClick={async () => {
              setIsResending(true)
              setResendSent(false)
              await resendSignupConfirmation(awaitingConfirmation)
              setIsResending(false)
              setResendSent(true)
            }}
            className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-semibold text-[#1A1A2E] transition-colors hover:border-[#6B7FBE] disabled:opacity-50"
          >
            {isResending ? 'Sending…' : resendSent ? 'Email sent ✓' : 'Resend confirmation email'}
          </button>
          <button
            type="button"
            onClick={() => setAuthMode('login')}
            className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-semibold text-[#1A1A2E] transition-colors hover:border-[#6B7FBE]"
          >
            Back to Login
          </button>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className={cn('space-y-4', awaitingConfirmation ? 'hidden' : undefined)}>
        {/* Name — signup only */}
        <div
          className={cn(
            'transition-all duration-500 ease-in-out overflow-hidden',
            isSignup ? 'max-h-24 opacity-100' : 'max-h-0 opacity-0 pointer-events-none',
          )}
          aria-hidden={!isSignup}
        >
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40" />
            <input
              type="text"
              placeholder="Full Name"
              value={formData.name}
              onChange={(e) => setField('name', e.target.value)}
              onBlur={() => blurField('name')}
              tabIndex={isSignup ? 0 : -1}
              className={cn(
                'w-full pl-10 pr-4 py-3 bg-white border rounded-xl placeholder:text-black/40 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 transition-all',
                errors.name ? 'border-red-500/50' : 'border-black/10',
              )}
            />
          </div>
          {errors.name ? (
            <p className="text-red-700 text-xs mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {errors.name}
            </p>
          ) : null}
        </div>

        {/* Email */}
        <div>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40" />
            <input
              type="email"
              placeholder="Email Address"
              value={formData.email}
              onChange={(e) => setField('email', e.target.value)}
              onBlur={() => blurField('email')}
              className={cn(
                'w-full pl-10 pr-4 py-3 bg-white border rounded-xl placeholder:text-black/40 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 transition-all',
                errors.email ? 'border-red-500/50' : 'border-black/10',
              )}
            />
          </div>
          {errors.email ? (
            <p className="text-red-700 text-xs mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {errors.email}
            </p>
          ) : null}
        </div>

        {/* Password */}
        <div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40" />
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password"
              value={formData.password}
              onChange={(e) => setField('password', e.target.value)}
              onBlur={() => blurField('password')}
              className={cn(
                'w-full pl-10 pr-12 py-3 bg-white border rounded-xl placeholder:text-black/40 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 transition-all',
                errors.password ? 'border-red-500/50' : 'border-black/10',
              )}
            />
            {formData.password ? (
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-black/40 hover:text-rumbo-text transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            ) : null}
          </div>
          {errors.password ? (
            <p className="text-red-700 text-xs mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {errors.password}
            </p>
          ) : null}
        </div>

        {/* Confirm password — signup only */}
        <div
          className={cn(
            'transition-all duration-500 ease-in-out overflow-hidden',
            isSignup ? 'max-h-40 opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
          )}
          aria-hidden={!isSignup}
        >
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40" />
            <input
              type={showConfirmPassword ? 'text' : 'password'}
              placeholder="Confirm Password"
              value={formData.confirmPassword}
              onChange={(e) => setField('confirmPassword', e.target.value)}
              onBlur={() => blurField('confirmPassword')}
              tabIndex={isSignup ? 0 : -1}
              className={cn(
                'w-full pl-10 pr-12 py-3 bg-white border rounded-xl placeholder:text-black/40 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 transition-all',
                errors.confirmPassword ? 'border-red-500/50' : 'border-black/10',
              )}
            />
            {formData.confirmPassword ? (
              <button
                type="button"
                onClick={() => setShowConfirmPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-black/40 hover:text-rumbo-text transition-colors"
                aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                tabIndex={isSignup ? 0 : -1}
              >
                {showConfirmPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            ) : null}
          </div>
          {errors.confirmPassword ? (
            <p className="text-red-700 text-xs mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {errors.confirmPassword}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className={cn(
            'w-full relative bg-rumbo-primary text-white font-semibold py-3 px-6 rounded-xl transition-all',
            'hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 disabled:opacity-50',
          )}
        >
          <span className="flex items-center justify-center gap-2">
            {isLoading ? (
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : authMode === 'login' ? (
              'Sign In'
            ) : (
              'Create Account'
            )}
          </span>
        </button>
      </form>
    </div>
  )
}
