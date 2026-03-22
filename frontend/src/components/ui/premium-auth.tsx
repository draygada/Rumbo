'use client'

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
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
}

interface FormErrors {
  email?: string
  password?: string
  confirmPassword?: string
  general?: string
}

function validateEmail(email: string) {
  if (!email.trim()) return 'Email is required'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Please enter a valid email address'
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

  const storeError = useAuthStore((s) => s.error)
  const initializing = useAuthStore((s) => s.initializing)

  const [authMode, setAuthMode] = useState<AuthMode>(initialMode)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const [formData, setFormData] = useState<FormData>({
    email: '',
    password: '',
    confirmPassword: '',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const passwordDebounceRef = useRef<number | null>(null)
  const confirmDebounceRef = useRef<number | null>(null)

  useEffect(() => {
    // Clear form errors when switching modes
    setErrors({})
    setTouched({})
    setIsLoading(false)
    setShowPassword(false)
    setShowConfirmPassword(false)
  }, [authMode])

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
      }
    },
    [authMode, formData.password],
  )

  const setField = useCallback(
    (field: keyof FormData, value: string) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      // Password validation is debounced (see effect below).
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
      if (!value) {
        setErrors((prev) => ({ ...prev, password: undefined }))
        return
      }
      const err = validatePassword(value)
      setErrors((prev) => ({ ...prev, password: err || undefined }))
    }, 150)

    return () => {
      if (passwordDebounceRef.current) window.clearTimeout(passwordDebounceRef.current)
    }
  }, [authMode, formData.password])

  useEffect(() => {
    if (authMode !== 'signup') return

    if (confirmDebounceRef.current) window.clearTimeout(confirmDebounceRef.current)
    confirmDebounceRef.current = window.setTimeout(() => {
      const value = formData.confirmPassword
      if (!value) {
        setErrors((prev) => ({ ...prev, confirmPassword: undefined }))
        return
      }
      const err = value !== formData.password ? 'Passwords do not match' : ''
      setErrors((prev) => ({ ...prev, confirmPassword: err || undefined }))
    }, 150)

    return () => {
      if (confirmDebounceRef.current) window.clearTimeout(confirmDebounceRef.current)
    }
  }, [authMode, formData.confirmPassword, formData.password])

  const canSubmit = useMemo(() => {
    if (initializing || isLoading) return false
    if (authMode === 'login') {
      return !!formData.email.trim() && !!formData.password
    }
    return (
      !!formData.email.trim() &&
      !!formData.password &&
      !!formData.confirmPassword
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
      if (authMode === 'login') {
        await signIn(formData.email.trim(), formData.password)
      } else {
        await signUp(formData.email.trim(), formData.password)
      }
    } catch (err) {
      setErrors({ general: (err as Error).message ?? 'Authentication failed. Please try again.' })
    } finally {
      setIsLoading(false)
    }
  }

  const generalError = errors.general || storeError || undefined
  const isSignup = authMode === 'signup'

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

      <form onSubmit={onSubmit} className="space-y-4">
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

        <div
          className={cn(
            'transition-all duration-500 ease-in-out overflow-hidden',
            isSignup ? 'max-h-40 opacity-100 translate-y-0' : 'max-h-0 opacity-0 -translate-y-1 pointer-events-none',
          )}
          aria-hidden={!isSignup}
        >
          <div className={cn('pt-0', isSignup ? 'mt-0' : 'mt-0')}>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40" />
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="Confirm Password"
                value={formData.confirmPassword}
                onChange={(e) => setField('confirmPassword', e.target.value)}
                onBlur={() => blurField('confirmPassword')}
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
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className={cn(
            'w-full relative bg-rumbo-primary text-white font-semibold py-3 px-6 rounded-xl transition-all',
            'hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-rumbo-primary/20 disabled:opacity-50',
          )}
        >
          <span className="flex items-center justify-center gap-2">
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
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

