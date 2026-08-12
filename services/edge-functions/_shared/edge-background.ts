/*
 * Keep post-response work alive until it finishes.
 *
 * WHY THIS EXISTS — this is the bug that made learner_signals stay empty.
 *
 * `void somePromise()` is not a background job. It is a promise nobody holds.
 * Supabase Edge Functions run on Deno Deploy: once the Response body is fully
 * delivered, the isolate is eligible for immediate teardown, and any promise
 * still in flight is dropped without running, without throwing, and without a
 * log line. The code looks correct, deploys correctly, and does nothing.
 *
 * Short work sneaks through (a single insert can land before teardown wins the
 * race). Long work never does. captureLearnerSignals is a full Gemini
 * round-trip plus an insert — one to three seconds — issued *after* the answer
 * was sent. It lost that race every single time.
 *
 * `EdgeRuntime.waitUntil` is the supported way to say "the request is done but
 * I am not". It extends the isolate's life until the promise settles.
 *
 * The fallback matters for local `supabase functions serve` and for the eval
 * harness, where the global is absent and a bare promise does run to completion
 * because nothing is tearing the process down.
 */

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined

/**
 * Run `promise` to completion after the response has been sent.
 *
 * Never throws and never returns the promise — callers must not await it, or
 * they reintroduce the latency this exists to avoid.
 */
export function runInBackground(promise: Promise<unknown>, label: string): void {
  const settled = promise.catch(err => {
    console.warn(`[background] ${label} failed:`, err)
  })
  try {
    if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime?.waitUntil === 'function') {
      EdgeRuntime.waitUntil(settled)
      return
    }
  } catch {
    // Global missing or not callable — the bare promise below is the fallback.
  }
  void settled
}
