import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useTasks, getNextBlock, TaskWithBlocks } from '../../hooks/useTasks'
import RumboMark from '../../components/RumboMark/RumboMark'
import { SendIcon } from '../../components/icons/Icons'
import styles from './Home.module.css'

interface Message {
  id: string
  role: 'user' | 'rumbo'
  text: string
  sources?: string[]
  pending?: boolean
}

function greeting(date = new Date()): string {
  const h = date.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function firstName(name?: string | null, email?: string | null): string {
  const fromName = name?.trim().split(/\s+/)[0]
  if (fromName) return fromName
  const fromEmail = email?.split('@')[0]
  return fromEmail ? fromEmail.charAt(0).toUpperCase() + fromEmail.slice(1) : 'there'
}

/*
 * Front-end shell. `askRumbo` is the single seam to a real backend — swap the
 * stubbed body for a fetch to the tutor endpoint (returns text + grounded
 * sources) and the rest of the UI keeps working unchanged.
 */
async function askRumbo(prompt: string): Promise<{ text: string; sources: string[] }> {
  await new Promise(r => setTimeout(r, 900))
  return {
    text: `Here's how I'd approach "${prompt.trim()}". I'll ground my answer in your course material and walk through it step by step — this is a preview response while the tutor backend is being connected.`,
    sources: ['CS 107 · lecture-08.pdf', 'CS 107 · assignment-4.md'],
  }
}

interface Suggestion {
  label: string
  prompt: string
  meta?: string
}

// Generic fallbacks — only shown when there's nothing scheduled to suggest.
const GENERIC_SUGGESTIONS: Suggestion[] = [
  { label: "What's due this week?", prompt: "What's due this week?", meta: 'Get an overview' },
  { label: 'Plan my study week', prompt: 'Help me plan my study week.', meta: 'Build a schedule' },
  { label: 'Start an assignment', prompt: 'Help me get started on an assignment.', meta: 'Break it down' },
]

/** "CS 107 — Assignment 4: heap allocator" → { course: "CS 107", rest: "Assignment 4: heap allocator" } */
function splitTitle(title: string): { course: string | null; rest: string } {
  const parts = title.split(/\s+[—–-]\s+/)
  if (parts.length >= 2) return { course: parts[0].trim(), rest: parts.slice(1).join(' — ').trim() }
  return { course: null, rest: title.trim() }
}

function verbFor(title: string): string {
  const t = title.toLowerCase()
  if (/\b(midterm|final|exam|quiz|test)\b/.test(t)) return 'Study for'
  if (/\b(read|reading|notes|case study|chapter)\b/.test(t)) return 'Review'
  if (/\b(essay|paper|memo|reflection|write|draft)\b/.test(t)) return 'Draft'
  return 'Start'
}

/** Short, chip-sized descriptor: drop sub-clauses and any leading verb we'd duplicate. */
function shortDesc(rest: string): string {
  let s = rest.split(/[:+·]/)[0].trim()
  s = s.replace(/^(read|reading|write|writing|study for|studying|review|start|finish|draft|complete|do)\s+/i, '')
  return s.split(/\s+/).slice(0, 3).join(' ')
}

function relativeDue(iso: string, now = new Date()): string {
  const due = new Date(iso)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(due) - day(now)) / 86400000)
  if (days < 0) return 'overdue'
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days <= 7) return `due ${due.toLocaleDateString('en-US', { weekday: 'long' })}`
  return `due ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/** When the task is next in play — its next scheduled block, else its due date. */
function effectiveTime(task: TaskWithBlocks): number {
  return new Date(getNextBlock(task)?.starts_at ?? task.due_at).getTime()
}

function deriveSuggestions(tasks: TaskWithBlocks[], limit = 3): Suggestion[] {
  const sorted = [...tasks].sort((a, b) => effectiveTime(a) - effectiveTime(b))
  return sorted.slice(0, limit).map(task => {
    const { course, rest } = splitTitle(task.title)
    const verb = verbFor(task.title)
    const desc = shortDesc(rest)
    const label = [verb, course, desc].filter(Boolean).join(' ')
    const prompt = `Help me ${verb.toLowerCase()} ${task.title} (${relativeDue(task.due_at)}).`
    return { label, prompt, meta: relativeDue(task.due_at) }
  })
}

export default function Home() {
  const { profile, session } = useAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: tasks } = useTasks()
  const active = messages.length > 0
  const name = firstName(profile?.name, session?.user?.email ?? profile?.email)

  const suggestions = useMemo(() => {
    const derived = deriveSuggestions(tasks ?? [])
    return derived.length > 0 ? derived : GENERIC_SUGGESTIONS
  }, [tasks])

  useEffect(() => {
    if (active) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, active])

  async function send(text: string) {
    const prompt = text.trim()
    if (!prompt || busy) return
    setDraft('')
    setBusy(true)
    const userMsg: Message = { id: `u-${messages.length}`, role: 'user', text: prompt }
    const pending: Message = { id: `r-${messages.length}`, role: 'rumbo', text: '', pending: true }
    setMessages(prev => [...prev, userMsg, pending])
    const reply = await askRumbo(prompt)
    setMessages(prev =>
      prev.map(m => (m.id === pending.id ? { ...m, text: reply.text, sources: reply.sources, pending: false } : m)),
    )
    setBusy(false)
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    send(draft)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(draft)
    }
  }

  const composer = (
    <form className={styles.composer} onSubmit={onSubmit}>
      <textarea
        ref={inputRef}
        className={styles.input}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask Rumbo anything about your courses…"
        aria-label="Message Rumbo"
      />
      <button
        type="submit"
        className={styles.send}
        disabled={!draft.trim() || busy}
        aria-label="Send message"
      >
        <SendIcon size={18} />
      </button>
    </form>
  )

  if (!active) {
    return (
      <div className={styles.hero}>
        <div className={styles.heroInner}>
          <RumboMark size={92} variant="radiate" hubR={6} className={styles.heroMark} />
          <h1 className={styles.greeting}>
            {greeting()}, {name}.
          </h1>
          <p className={styles.subtitle}>What are you working on today?</p>
          {composer}
          <div className={styles.quick}>
            {suggestions.map(s => (
              <button key={s.label} className={styles.tile} onClick={() => send(s.prompt)} type="button">
                <span className={styles.tileLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.chat}>
      <div className={styles.thread} ref={scrollRef}>
        <div className={styles.threadInner}>
          {messages.map(m =>
            m.role === 'user' ? (
              <div key={m.id} className={styles.userRow}>
                <div className={styles.userBubble}>{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className={styles.rumboRow}>
                <div className={styles.rumboMark}>
                  <RumboMark size={30} variant={m.pending ? 'pulse' : 'static'} hubR={6} minimal />
                </div>
                <div className={styles.rumboBody}>
                  <span className={styles.rumboLabel}>Rumbo</span>
                  {m.pending ? (
                    <span className={styles.thinking}>Thinking…</span>
                  ) : (
                    <>
                      <p className={styles.rumboText}>{m.text}</p>
                      {m.sources && m.sources.length > 0 && (
                        <div className={styles.sources}>
                          {m.sources.map(s => (
                            <span key={s} className={styles.sourceChip}>
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      </div>
      <div className={styles.dock}>
        <div className={styles.dockInner}>{composer}</div>
      </div>
    </div>
  )
}
