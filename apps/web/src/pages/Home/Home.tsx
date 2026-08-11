import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useTasks, getNextBlock, TaskWithBlocks } from '../../hooks/useTasks'
import { useCourses } from '../../hooks/useCourses'
import RumboMark from '../../components/RumboMark/RumboMark'
import { SendIcon } from '../../components/icons/Icons'
import Markdown from '../../components/Markdown/Markdown'
import ChatHistory from '../../chat/ChatHistory'
import { streamTutor } from '../../chat/streamTutor'
import { useSmoothStream } from '../../chat/useSmoothStream'
import {
  useChatStore,
  useActiveChat,
  useActiveStreamText,
  type ChatMessage,
  type TutorSource,
} from '../../chat/chatStore'
import styles from './Home.module.css'

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

interface RawSource {
  source_type: string
  title: string
  course_code: string | null
  slide_or_section: string | null
  rerank_score: number | null
}

function toTutorSource(v: RawSource): TutorSource {
  let slide: number | null = null
  if (v.slide_or_section) {
    const m = v.slide_or_section.match(/(\d+)/)
    if (m) slide = Number(m[1])
  }
  return { title: v.title || '(untitled)', url: null, course: v.course_code, term: null, slide_number: slide }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export default function Home() {
  const { profile, session } = useAuth()
  const userId = session?.user?.id ?? null

  // Chat lives in the shared persisted store, so a conversation survives
  // navigation and reload, and the same history powers "Past chats".
  const activeChat = useActiveChat()
  const messages: ChatMessage[] = activeChat?.messages ?? []
  const streamText = useActiveStreamText()
  const appendMessage = useChatStore(s => s.appendMessage)
  const appendMessageToChat = useChatStore(s => s.appendMessageToChat)
  const newChatStore = useChatStore(s => s.newChat)
  const startStreaming = useChatStore(s => s.startStreaming)
  const appendStreamDelta = useChatStore(s => s.appendStreamDelta)
  const endStreaming = useChatStore(s => s.endStreaming)
  const stopStreaming = useChatStore(s => s.stopStreaming)

  const setCourseId = useChatStore(s => s.setCourseId)
  const pendingCourseId = useChatStore(s => s.pendingCourseId)
  const { data: courses } = useCourses()
  // Scope belongs to the conversation; before one exists it's the pending choice.
  const courseId = (activeChat ? activeChat.courseId : pendingCourseId) ?? 'all'

  const [draft, setDraft] = useState('')
  const [chatsOpen, setChatsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Steady reveal instead of bursty network chunks.
  const smoothed = useSmoothStream(streamText, false)
  const busy = streamText !== null

  const { data: tasks } = useTasks()
  const active = messages.length > 0 || streamText !== null
  const name = firstName(profile?.name, session?.user?.email ?? profile?.email)

  const suggestions = useMemo(() => {
    const derived = deriveSuggestions(tasks ?? [])
    return derived.length > 0 ? derived : GENERIC_SUGGESTIONS
  }, [tasks])

  useEffect(() => {
    if (active) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, smoothed, active])

  const send = useCallback(async (text: string) => {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (!userId) {
      appendMessage({ role: 'error', id: makeId(), text: 'Not signed in' })
      return
    }
    setDraft('')
    appendMessage({ role: 'user', id: makeId(), text: prompt })

    // Capture the chat that owns this turn so the answer commits to it even if
    // the student navigates away or starts a new chat mid-stream.
    const st = useChatStore.getState()
    const chat = st.chats.find(c => c.id === st.activeChatId) ?? null
    const chatId = chat?.id
    if (!chatId) return
    const conversationId = chat?.conversationId ?? null

    const controller = new AbortController()
    startStreaming(chatId, controller)
    let meta: { learning_mode: string; sources: RawSource[]; session_id: string | null } | null = null
    let settled = false

    try {
      await streamTutor({
        userId,
        message: prompt,
        conversationId,
        courseId: chat?.courseId ?? 'all',
        signal: controller.signal,
        onMeta: m => {
          meta = m as typeof meta
          if (!conversationId && m.session_id) useChatStore.getState().setConversationId(m.session_id)
        },
        onToken: delta => appendStreamDelta(delta),
        onDone: ({ answer }) => {
          if (settled) return
          settled = true
          appendMessageToChat(chatId, {
            role: 'assistant',
            id: makeId(),
            text: answer,
            mode: 'within_course',
            confidence: 0.8,
            sources: (meta?.sources ?? []).map(toTutorSource),
            turnId: null,
          })
          endStreaming(chatId)
        },
        onError: e => {
          if (settled) return
          settled = true
          appendMessageToChat(chatId, { role: 'error', id: makeId(), text: e })
          endStreaming(chatId)
        },
      })
    } catch (err) {
      if (!settled) {
        settled = true
        const aborted = err instanceof DOMException && err.name === 'AbortError'
        if (!aborted) {
          appendMessageToChat(chatId, {
            role: 'error', id: makeId(),
            text: err instanceof Error ? err.message : 'Something went wrong.',
          })
        }
        endStreaming(chatId)
      }
    } finally {
      inputRef.current?.focus()
    }
  }, [busy, userId, appendMessage, appendMessageToChat, startStreaming, appendStreamDelta, endStreaming])

  function newChat() {
    stopStreaming()
    newChatStore()
    setDraft('')
    setChatsOpen(false)
    inputRef.current?.focus()
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

  const topBar = chatsOpen ? null : (
    <div className={styles.topBar}>
      <button
        type="button"
        className={styles.iconTextButton}
        onClick={() => setChatsOpen(true)}
        aria-label="Past chats"
        title="Past chats"
      >
        <span className={styles.iconTextLabel}>Past chats</span>
      </button>
      {active && (
        <button type="button" className={styles.barButton} onClick={newChat} disabled={busy}>
          New chat
        </button>
      )}
    </div>
  )

  const coursePicker = (
    <label className={styles.scopePicker}>
      <span className={styles.scopeLabel}>Class</span>
      <select
        className={styles.scopeSelect}
        value={courseId}
        onChange={e => setCourseId(e.target.value === 'all' ? 'all' : e.target.value)}
        // Scope is fixed once a conversation starts — otherwise earlier answers
        // in the thread would have come from a different class.
        disabled={busy || messages.length > 0}
        title={
          messages.length > 0
            ? 'Start a new chat to ask about a different class'
            : 'Which class this chat is about'
        }
      >
        <option value="all">All classes</option>
        {(courses ?? []).map(c => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
      </select>
    </label>
  )

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
      <div className={styles.shell}>
        <div className={styles.hero}>
        {topBar}
        <div className={styles.heroInner}>
          <RumboMark size={92} variant="radiate" hubR={6} className={styles.heroMark} />
          <h1 className={styles.greeting}>
            {greeting()}, {name}.
          </h1>
          <p className={styles.subtitle}>What are you working on today?</p>
          {composer}
          {coursePicker}
          <div className={styles.quick}>
            {suggestions.map(s => (
              <button key={s.label} className={styles.tile} onClick={() => send(s.prompt)} type="button">
                <span className={styles.tileLabel}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        </div>
        <ChatHistory open={chatsOpen} onClose={() => setChatsOpen(false)} />
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <div className={styles.chat}>
      {topBar}

      <div className={styles.thread} ref={scrollRef}>
        <div className={styles.threadInner}>
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
                <div key={m.id} className={styles.rumboRow}>
                  <div className={styles.rumboMark}>
                    <RumboMark size={30} variant="static" hubR={6} minimal />
                  </div>
                  <div className={styles.rumboBody}>
                    <span className={styles.rumboLabel}>Rumbo</span>
                    <p className={styles.errorText}>Couldn't reach the tutor: {m.text}</p>
                  </div>
                </div>
              )
            }
            return (
              <div key={m.id} className={styles.rumboRow}>
                <div className={styles.rumboMark}>
                  <RumboMark size={30} variant="static" hubR={6} minimal />
                </div>
                <div className={styles.rumboBody}>
                  <span className={styles.rumboLabel}>Rumbo</span>
                  <div className={styles.rumboText}>
                    <Markdown>{m.text}</Markdown>
                  </div>
                  {m.sources.length > 0 && (
                    <details className={styles.sources}>
                      <summary className={styles.sourcesSummary}>
                        <span className={styles.sourcesChevron} aria-hidden="true" />
                        {m.sources.length} {m.sources.length === 1 ? 'source' : 'sources'}
                      </summary>
                      <div className={styles.sourceChips}>
                        {m.sources.map((s, i) => (
                          <span key={`${m.id}-s-${i}`} className={styles.sourceChip}>
                            {s.course ? `${s.course} · ${s.title}` : s.title}
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            )
          })}

          {/* Live turn: the mark animates while Rumbo works, then the answer
              reveals at a steady rate. */}
          {streamText !== null && (
            <div className={styles.rumboRow}>
              <div className={styles.rumboMark}>
                <RumboMark size={30} variant="pulse" hubR={6} minimal />
              </div>
              <div className={styles.rumboBody}>
                <span className={styles.rumboLabel}>Rumbo</span>
                {smoothed.length === 0 ? (
                  <span className={styles.thinking}>Thinking…</span>
                ) : (
                  <div className={[styles.rumboText, styles.streamingBody].join(' ')}>
                    <Markdown>{smoothed}</Markdown>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.dock}>
        <div className={styles.dockInner}>
          {composer}
          <div className={styles.dockMeta}>{coursePicker}</div>
        </div>
      </div>
      </div>

      <ChatHistory open={chatsOpen} onClose={() => setChatsOpen(false)} />
    </div>
  )
}
