import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import styles from './Tutor.module.css'

// Tutor — chat surface backed by the `tutor-v4` Edge Function.
// See Rumbo-Design-Docs/Features/ai-tutor.md for product constraints:
//   - No copy affordance on assistant messages (§9)
//   - No export/download
//   - Warn banner when a response drifts toward doing the work for the student
// Streaming is deliberately deferred (V0.1) — spinner during request, full
// answer rendered at once.

// -----------------------------------------------------------------------------
// Types (mirror services/edge-functions/tutor-v4/index.ts)
// -----------------------------------------------------------------------------

// v4 learning_mode set is broader than v3 — collapse for UI display.
type TutorMode = 'within_course' | 'cross_course' | 'small_talk'
type V4LearningMode = 'tutoring' | 'exploration' | 'lookup' | 'cross_course' | 'small_talk'

interface TutorSource {
  title: string
  url: string | null
  course: string | null
  term: string | null
  slide_number: number | null
}

interface V4Source {
  source_type: string
  title: string
  course_code: string | null
  slide_or_section: string | null
  rerank_score: number | null
}

interface TutorV4Response {
  ok: boolean
  session_id: string | null
  answer: string
  learning_mode: V4LearningMode
  template: string | null
  model_used: string
  is_clarifying: boolean
  sources: V4Source[]
  timing_ms: Record<string, number>
}

// v3 mode enum kept for UI code; mapped from v4 learning_mode.
function mapV4ModeToUI(m: V4LearningMode): TutorMode {
  if (m === 'cross_course') return 'cross_course'
  if (m === 'small_talk') return 'small_talk'
  return 'within_course'  // tutoring / exploration / lookup all collapse
}

function mapV4Source(v: V4Source): TutorSource {
  // v4 doesn't return URLs yet (need to enrich retrieval query later); leave null.
  let slide: number | null = null
  if (v.slide_or_section) {
    const m = v.slide_or_section.match(/(\d+)/)
    if (m) slide = Number(m[1])
  }
  return {
    title: v.title || '(untitled)',
    url: null,
    course: v.course_code,
    term: null,
    slide_number: slide,
  }
}

function confidenceFromV4(sources: V4Source[], mode: V4LearningMode): number {
  if (mode === 'small_talk') return 1
  if (mode === 'lookup') return 0.9
  const topRerank = sources
    .map(s => s.rerank_score ?? 0)
    .reduce((a, b) => Math.max(a, b), 0)
  return topRerank > 0 ? Math.min(0.95, topRerank + 0.4) : 0.6
}

interface UserMessage {
  role: 'user'
  id: string
  text: string
}

interface AssistantMessage {
  role: 'assistant'
  id: string
  text: string
  mode: TutorMode
  confidence: number
  sources: TutorSource[]
  turnId: string | null
}

interface ErrorMessage {
  role: 'error'
  id: string
  text: string
}

type ChatMessage = UserMessage | AssistantMessage | ErrorMessage

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const MODE_LABEL: Record<TutorMode, string> = {
  within_course: 'within course',
  cross_course: 'cross course',
  small_talk: 'small talk',
}

// Product constraint: warn when a response is long enough or code-heavy enough
// to blur the "context not submittable work" line.
const WORD_WARN_THRESHOLD = 250
const CODE_LINE_WARN_THRESHOLD = 8

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function longestCodeBlockLines(text: string): number {
  const matches = text.match(/```[\s\S]*?```/g)
  if (!matches) return 0
  let longest = 0
  for (const block of matches) {
    // Strip the fences; count interior newlines.
    const inner = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
    const lines = inner.split('\n').length
    if (lines > longest) longest = lines
  }
  return longest
}

function shouldShowSubmittableWorkWarning(text: string): boolean {
  return countWords(text) > WORD_WARN_THRESHOLD || longestCodeBlockLines(text) > CODE_LINE_WARN_THRESHOLD
}

function confidenceBucket(c: number): { label: string; className: string } {
  if (c >= 0.8) return { label: 'Confident', className: styles.confidenceHigh }
  if (c >= 0.5) return { label: 'Uncertain', className: styles.confidenceMid }
  return { label: 'Low confidence', className: styles.confidenceLow }
}

function makeId(): string {
  // Cheap unique-ish id for keys — turnId (from the server) is used when we need
  // a stable identity across renders.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function Tutor() {
  const { session } = useAuth()
  const userId = session?.user?.id ?? null

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-scroll on new message / busy change.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, busy])

  const send = useCallback(async () => {
    const question = input.trim()
    if (!question || busy) return

    const userMsg: UserMessage = { role: 'user', id: makeId(), text: question }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setBusy(true)

    try {
      if (!userId) throw new Error('Not signed in')
      const { data, error } = await supabase.functions.invoke<TutorV4Response>('tutor-v4', {
        body: {
          user_id: userId,
          message: question,
          session_id: conversationId ?? undefined,
        },
      })
      if (error) throw error
      if (!data) throw new Error('Empty response from tutor')

      const uiSources = (data.sources ?? []).map(mapV4Source)
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        id: makeId(),
        text: data.answer,
        mode: mapV4ModeToUI(data.learning_mode),
        confidence: confidenceFromV4(data.sources ?? [], data.learning_mode),
        sources: uiSources,
        turnId: null,
      }
      setMessages(prev => [...prev, assistantMsg])
      if (!conversationId && data.session_id) setConversationId(data.session_id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      setMessages(prev => [...prev, { role: 'error', id: makeId(), text: msg }])
    } finally {
      setBusy(false)
      // Restore focus so the student can keep typing.
      textareaRef.current?.focus()
    }
  }, [input, busy, conversationId, userId])

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline (matches multi-line
    // intent — students often paste multi-line questions).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }

  function newChat() {
    if (busy) return
    setMessages([])
    setConversationId(null)
    setInput('')
    textareaRef.current?.focus()
  }

  const isEmpty = messages.length === 0

  const disableSend = busy || input.trim().length === 0

  const disableNewChat = busy || (messages.length === 0 && conversationId === null)

  // Memoized derived flags per assistant message — small enough to be inline
  // but the warning check touches every character so we keep it out of render.
  const warningFlags = useMemo(() => {
    const flags = new Map<string, boolean>()
    for (const m of messages) {
      if (m.role === 'assistant') flags.set(m.id, shouldShowSubmittableWorkWarning(m.text))
    }
    return flags
  }, [messages])

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <h1 className={styles.title}>Tutor</h1>
          <p className={styles.subtitle}>
            Ask about anything you've covered. Rumbo answers from your own coursework and cites where.
          </p>
        </div>
        <button
          type="button"
          className={styles.newChatButton}
          onClick={newChat}
          disabled={disableNewChat}
        >
          New chat
        </button>
      </header>

      <div ref={listRef} className={styles.messageList}>
        {isEmpty && (
          <div className={styles.emptyState}>
            <h2 className={styles.emptyTitle}>Ask about your coursework.</h2>
            <p className={styles.emptyBody}>
              Try: <em>“Where did we cover REST APIs in CS 146J?”</em>
            </p>
            <p className={styles.emptyBody}>
              Or: <em>“Remind me what a Jacobian is and where I've seen it.”</em>
            </p>
          </div>
        )}

        {messages.map(m => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className={styles.userRow}>
                <div className={styles.userBubble}>{m.text}</div>
              </div>
            )
          }
          if (m.role === 'error') {
            return (
              <div key={m.id} className={styles.assistantRow}>
                <div className={styles.errorBubble}>Couldn't reach the tutor: {m.text}</div>
              </div>
            )
          }
          const bucket = confidenceBucket(m.confidence)
          const showWarn = warningFlags.get(m.id) === true
          return (
            <div key={m.id} className={styles.assistantRow}>
              {showWarn && (
                <div className={styles.workWarning}>
                  Rumbo won't write your assignment. Here's how to think about it instead.
                </div>
              )}
              <div className={styles.assistantBubble}>
                <AssistantText text={m.text} />
              </div>
              <div className={styles.assistantMeta}>
                <span className={[styles.confidencePill, bucket.className].join(' ')}>
                  {bucket.label}
                </span>
                <span className={styles.modeLabel}>{MODE_LABEL[m.mode]}</span>
              </div>
              {m.sources.length > 0 && (
                <div className={styles.sources}>
                  <div className={styles.sourcesHeader}>Sources</div>
                  <ul className={styles.sourceList}>
                    {m.sources.map((s, i) => (
                      <li key={`${m.id}-src-${i}`} className={styles.sourceRow}>
                        {s.course && <span className={styles.courseChip}>{s.course}</span>}
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={styles.sourceTitle}
                          >
                            {s.title}
                          </a>
                        ) : (
                          <span className={styles.sourceTitle}>{s.title}</span>
                        )}
                        {s.slide_number !== null && (
                          <span className={styles.slideNumber}>slide {s.slide_number}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        })}

        {busy && (
          <div className={styles.assistantRow}>
            <div className={styles.spinnerBubble} aria-live="polite" aria-label="Thinking">
              <span className={styles.spinner} />
              <span className={styles.spinnerText}>Thinking…</span>
            </div>
          </div>
        )}
      </div>

      <form
        className={styles.inputBar}
        onSubmit={e => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your coursework…"
          rows={2}
          disabled={busy}
          aria-label="Ask the tutor"
        />
        <div className={styles.inputFooter}>
          <span className={styles.hint}>Cmd/Ctrl + Enter to send</span>
          <button
            type="submit"
            className={styles.sendButton}
            disabled={disableSend}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Assistant text renderer — minimal markdown-ish handling so fenced code blocks
// don't render as raw backticks. Full markdown is out of scope for V0.1; we
// only split on ``` fences and preserve line breaks.
// -----------------------------------------------------------------------------

function AssistantText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ type: 'text' | 'code'; content: string }> = []
    const regex = /```([\s\S]*?)```/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) out.push({ type: 'text', content: text.slice(last, match.index) })
      const inner = match[1].replace(/^[a-zA-Z0-9_-]*\n/, '')
      out.push({ type: 'code', content: inner })
      last = regex.lastIndex
    }
    if (last < text.length) out.push({ type: 'text', content: text.slice(last) })
    return out
  }, [text])

  return (
    <>
      {parts.map((p, i) =>
        p.type === 'code' ? (
          <pre key={i} className={styles.codeBlock}>
            <code>{p.content}</code>
          </pre>
        ) : (
          <div key={i} className={styles.textBlock}>
            {p.content}
          </div>
        ),
      )}
    </>
  )
}
