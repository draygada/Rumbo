import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import Markdown from '../../components/Markdown/Markdown'
import ChatHistory from './ChatHistory'
import RumboMark from '../../components/RumboMark/RumboMark'
import { useSmoothStream } from './useSmoothStream'
import { streamTutor } from './streamTutor'
import {
  useChatStore,
  useActiveChat,
  useActiveStreamText,
  type ChatMessage,
  type TutorMode,
  type TutorSource,
} from './chatStore'
import styles from './Tutor.module.css'

// Tutor — chat surface backed by the streaming `tutor-v4-stream` Edge Function.
// See Rumbo-Design-Docs/Features/ai-tutor.md for product constraints:
//   - No copy affordance on assistant messages (§9)
//   - No export/download
//   - Warn banner when a response drifts toward doing the work for the student
// Chat state lives in a persisted store (chatStore.ts) so it survives tab
// navigation and reload; only "New chat" clears the active conversation.
// Answers stream token-by-token and render as Markdown.

// -----------------------------------------------------------------------------
// Types (ChatMessage / TutorMode / TutorSource come from chatStore)
// -----------------------------------------------------------------------------

// v4 learning_mode set is broader than v3 — collapse for UI display.
type V4LearningMode = 'tutoring' | 'exploration' | 'lookup' | 'cross_course' | 'small_talk'

interface V4Source {
  source_type: string
  title: string
  course_code: string | null
  slide_or_section: string | null
  rerank_score: number | null
}

// v3 mode enum kept for UI code; mapped from v4 learning_mode.
function mapV4ModeToUI(m: V4LearningMode): TutorMode {
  if (m === 'cross_course') return 'cross_course'
  if (m === 'small_talk') return 'small_talk'
  return 'within_course' // tutoring / exploration / lookup all collapse
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
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function Tutor() {
  const { session } = useAuth()
  const userId = session?.user?.id ?? null

  // Chat history lives in the persisted store; the active chat's messages drive
  // the render. `streamText` holds the in-progress assistant answer (not yet
  // committed to the store) so we don't write to localStorage on every token.
  const activeChat = useActiveChat()
  const messages: ChatMessage[] = activeChat?.messages ?? []
  // Streaming state lives in the store, so an answer keeps streaming and
  // commits even if this page unmounts (student tabs to Brain and back).
  const streamText = useActiveStreamText()
  const appendMessage = useChatStore(s => s.appendMessage)
  const appendMessageToChat = useChatStore(s => s.appendMessageToChat)
  const newChatStore = useChatStore(s => s.newChat)
  const startStreaming = useChatStore(s => s.startStreaming)
  const appendStreamDelta = useChatStore(s => s.appendStreamDelta)
  const endStreaming = useChatStore(s => s.endStreaming)
  const stopStreaming = useChatStore(s => s.stopStreaming)

  const [input, setInput] = useState('')
  const [chatsOpen, setChatsOpen] = useState(false)

  // Reveal the streamed answer at a steady rate rather than in network bursts.
  const smoothed = useSmoothStream(streamText, false)

  const busy = streamText !== null
  const listRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-scroll on new message / streaming token.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  const send = useCallback(async () => {
    const question = input.trim()
    if (!question || busy) return
    if (!userId) {
      appendMessage({ role: 'error', id: makeId(), text: 'Not signed in' })
      return
    }

    // Append the user message (creates a fresh active chat if needed).
    appendMessage({ role: 'user', id: makeId(), text: question })
    setInput('')

    // Capture the chat that OWNS this turn, plus its conversation id, AFTER
    // appending. The streamed answer commits to this chat even if the student
    // starts a new chat (or navigates away) before it finishes.
    const st = useChatStore.getState()
    const active = st.chats.find(c => c.id === st.activeChatId) ?? null
    const chatId = active?.id
    if (!chatId) return
    const conversationId = active?.conversationId ?? null

    const controller = new AbortController()
    startStreaming(chatId, controller)
    let meta: { learning_mode: string; sources: V4Source[]; session_id: string | null } | null = null
    let settled = false

    try {
      await streamTutor({
        userId,
        message: question,
        conversationId,
        signal: controller.signal,
        onMeta: m => {
          meta = m
          if (!conversationId && m.session_id) {
            useChatStore.getState().setConversationId(m.session_id)
          }
        },
        onToken: delta => appendStreamDelta(delta),
        onDone: ({ answer }) => {
          if (settled) return
          settled = true
          const mode = mapV4ModeToUI((meta?.learning_mode ?? 'tutoring') as V4LearningMode)
          const uiSources = (meta?.sources ?? []).map(mapV4Source)
          const confidence = confidenceFromV4(
            meta?.sources ?? [],
            (meta?.learning_mode ?? 'tutoring') as V4LearningMode,
          )
          appendMessageToChat(chatId, {
            role: 'assistant',
            id: makeId(),
            text: answer,
            mode,
            confidence,
            sources: uiSources,
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
      // AbortError is expected when the student presses New chat mid-answer.
      if (!settled) {
        settled = true
        const aborted = err instanceof DOMException && err.name === 'AbortError'
        if (!aborted) {
          const msg = err instanceof Error ? err.message : 'Something went wrong.'
          appendMessageToChat(chatId, { role: 'error', id: makeId(), text: msg })
        }
        endStreaming(chatId)
      }
    } finally {
      textareaRef.current?.focus()
    }
  }, [input, busy, userId, appendMessage, appendMessageToChat, startStreaming, appendStreamDelta, endStreaming])

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }

  function newChat() {
    // Explicit stop: abort any in-flight stream, then detach the active chat.
    stopStreaming()
    newChatStore()
    setInput('')
    setChatsOpen(false)
    textareaRef.current?.focus()
  }

  const isEmpty = messages.length === 0 && streamText === null

  const disableSend = busy || input.trim().length === 0
  const disableNewChat = busy

  // Memoized derived flags per committed assistant message.
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
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.newChatButton}
            onClick={() => setChatsOpen(true)}
          >
            View chats
          </button>
          <button
            type="button"
            className={styles.newChatButton}
            onClick={newChat}
            disabled={disableNewChat}
          >
            New chat
          </button>
        </div>
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
                <Markdown>{m.text}</Markdown>
              </div>
              <div className={styles.assistantMeta}>
                <span className={[styles.confidencePill, bucket.className].join(' ')}>
                  {bucket.label}
                </span>
                <span className={styles.modeLabel}>{MODE_LABEL[m.mode]}</span>
              </div>
              {/* Collapsed by default — the answer is the product; sources are
                  evidence the student can pull up when they want to verify. */}
              {m.sources.length > 0 && (
                <details className={styles.sources}>
                  <summary className={styles.sourcesSummary}>
                    <span className={styles.sourcesChevron} aria-hidden="true" />
                    {m.sources.length} {m.sources.length === 1 ? 'source' : 'sources'}
                  </summary>
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
                </details>
              )}
            </div>
          )
        })}

        {/* Streaming answer. Before the first token the mark itself animates
            (it's the brand's thinking state); once text arrives it reveals at a
            steady rate via useSmoothStream, with a caret while more is coming. */}
        {streamText !== null && smoothed.length === 0 && (
          <div className={styles.assistantRow}>
            <div className={styles.thinkingBubble} aria-live="polite" aria-label="Thinking">
              <RumboMark size={26} variant="pulse" hubR={5} title="" />
              <span className={styles.spinnerText}>Thinking…</span>
            </div>
          </div>
        )}
        {streamText !== null && smoothed.length > 0 && (
          <div className={styles.assistantRow}>
            <div className={styles.assistantBubble}>
              <div className={styles.streamingBody}>
                <Markdown>{smoothed}</Markdown>
              </div>
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
          <button type="submit" className={styles.sendButton} disabled={disableSend}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      <ChatHistory open={chatsOpen} onClose={() => setChatsOpen(false)} />
    </div>
  )
}
