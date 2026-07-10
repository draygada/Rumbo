import { FormEvent, useMemo, useState } from 'react'
import { extractCanvasDomain, verifyCanvas } from '../../lib/canvas'
import styles from './CanvasConnect.module.css'

interface Props {
  /** Called after canvas-verify saves credentials successfully. */
  onConnected: (domain: string) => void
  /** Optional cancel/back action (Settings shows a Cancel; Onboarding uses stage nav). */
  onCancel?: () => void
  cancelLabel?: string
}

// Two-step guided Canvas connect. Instead of asking the student to know their
// Canvas subdomain, we ask them to paste any Canvas URL and extract the
// hostname client-side. Same for the token — one-screen instructions per step.
export default function CanvasConnect({ onConnected, onCancel, cancelLabel = 'Cancel' }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [urlInput, setUrlInput] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const extracted = useMemo(() => extractCanvasDomain(urlInput), [urlInput])
  const looksLikeCanvasHost = useMemo(() => {
    if (!extracted) return false
    return extracted.includes('.') && !extracted.startsWith('.')
  }, [extracted])

  function handleContinue(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!extracted || !looksLikeCanvasHost) {
      setError("That doesn't look like a valid Canvas URL — try copying the address bar again.")
      return
    }
    setStep(2)
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault()
    if (!extracted) return
    if (!token.trim()) {
      setError('Paste the access token you generated in Canvas.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await verifyCanvas(token.trim(), extracted, true)
      if (!result.ok) {
        setError(
          result.kind === 'auth'
            ? 'Canvas rejected that token. Double-check it and try again.'
            : result.message ?? 'Could not verify Canvas credentials.',
        )
        return
      }
      onConnected(extracted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Canvas verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrapper} aria-live="polite">
      <ol className={styles.steps} aria-label="Canvas connect steps">
        <li className={step === 1 ? styles.stepActive : styles.stepDone} aria-current={step === 1 ? 'step' : undefined}>
          <span className={styles.stepNum}>1</span>
          <span className={styles.stepLabel}>Canvas URL</span>
        </li>
        <li className={step === 2 ? styles.stepActive : styles.stepPending} aria-current={step === 2 ? 'step' : undefined}>
          <span className={styles.stepNum}>2</span>
          <span className={styles.stepLabel}>Access token</span>
        </li>
      </ol>

      {step === 1 && (
        <form onSubmit={handleContinue} className={styles.form}>
          <h3 className={styles.stepTitle}>Paste your Canvas link</h3>
          <ol className={styles.instructions}>
            <li>Open Canvas and log in.</li>
            <li>Copy the full link from your browser's address bar.</li>
            <li>Paste it below — we'll figure out the rest.</li>
          </ol>
          <label className={styles.label} htmlFor="canvas-url">Canvas link</label>
          <input
            id="canvas-url"
            type="text"
            className={styles.input}
            placeholder="e.g. https://stanford.instructure.com/courses/12345"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          {extracted && looksLikeCanvasHost && (
            <p className={styles.detected}>
              We'll connect to <strong>{extracted}</strong>
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            {onCancel && (
              <button type="button" className={styles.buttonSecondary} onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </button>
            )}
            <button
              type="submit"
              className={styles.buttonPrimary}
              disabled={!urlInput.trim()}
            >
              Continue
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={handleConnect} className={styles.form}>
          <h3 className={styles.stepTitle}>Generate an access token</h3>
          <ol className={styles.instructions}>
            <li>In Canvas, click your profile picture → <strong>Account</strong> → <strong>Settings</strong>.</li>
            <li>Scroll to <strong>Approved Integrations</strong> → <strong>+ New Access Token</strong>.</li>
            <li>Purpose: "Rumbo". Leave the expiry blank. Click <strong>Generate Token</strong>.</li>
            <li>Copy the token and paste it below.</li>
          </ol>
          <label className={styles.label} htmlFor="canvas-token">Access token</label>
          <input
            id="canvas-token"
            type="password"
            className={styles.input}
            placeholder="Paste the token from Canvas"
            value={token}
            onChange={e => setToken(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          <p className={styles.detected}>
            We'll connect to <strong>{extracted}</strong>.{' '}
            <button type="button" className={styles.linkButton} onClick={() => setStep(1)}>
              Not right?
            </button>
          </p>
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.buttonSecondary} onClick={() => setStep(1)} disabled={busy}>
              Back
            </button>
            <button type="submit" className={styles.buttonPrimary} disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect Canvas'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
