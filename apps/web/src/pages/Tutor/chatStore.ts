// -----------------------------------------------------------------------------
// chatStore — persistent Tutor chat state (zustand + persist middleware).
//
// Purpose: Tutor.tsx currently keeps `messages`, `conversationId`, and `input`
// in component-local useState, so navigating away from the Tutor page (or
// reloading) drops the whole conversation. This store persists chat sessions to
// localStorage under the key 'rumbo-tutor-chats', so a conversation survives
// navigation and reload, and is only cleared per-session by "New chat".
//
// The store holds MULTIPLE saved chat sessions (`chats`) plus which one is
// active (`activeChatId`). `input` intentionally stays local to Tutor.tsx — it
// is ephemeral draft text, not conversation history.
//
// ---------------------------------------------------------------------------
// How Tutor.tsx should wire this (integration guide):
//
//   import {
//     useChatStore,
//     useActiveChat,
//     type ChatMessage,
//     type TutorMode,
//     type TutorSource,
//   } from './chatStore'
//
// 1. Remove the local message/conversation state:
//      - DELETE: const [messages, setMessages] = useState<ChatMessage[]>([])
//      - DELETE: const [conversationId, setConversationId] = useState<...>(null)
//    Keep the local `input` and `busy` useState — those stay component-local.
//    Also delete the local `ChatMessage` / `TutorMode` / `TutorSource` type
//    declarations and import them from this store instead (identical shapes).
//
// 2. Read from the store instead:
//      const activeChat = useActiveChat()
//      const messages = activeChat?.messages ?? []
//      const conversationId = activeChat?.conversationId ?? null
//      const appendMessage    = useChatStore(s => s.appendMessage)
//      const setConversationId = useChatStore(s => s.setConversationId)
//      const storeNewChat     = useChatStore(s => s.newChat)
//
// 3. In `send`, replace the setMessages(prev => [...prev, msg]) calls with
//    appendMessage(userMsg) / appendMessage(assistantMsg) / appendMessage(errMsg),
//    and replace `setConversationId(data.session_id)` with the store action
//    (guarded the same way: `if (!conversationId && data.session_id) ...`).
//    appendMessage auto-creates a fresh SavedChat when there is no active chat.
//
// 4. In the local `newChat()` handler, replace `setMessages([])` +
//    `setConversationId(null)` with `storeNewChat()` (keep clearing `input` and
//    refocusing the textarea). newChat does NOT delete history — it just
//    detaches the active pointer so the next appendMessage starts a new session.
//
// 5. (Optional) A chat-history sidebar can use `useChatList()` +
//    `loadChat(id)` / `deleteChat(id)`.
// -----------------------------------------------------------------------------

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'

// -----------------------------------------------------------------------------
// Shared message types — these MUST match Tutor.tsx exactly. Import them from
// here rather than redeclaring, so the store and the page never drift.
// -----------------------------------------------------------------------------

export type TutorMode = 'within_course' | 'cross_course' | 'small_talk'

export interface TutorSource {
  title: string
  url: string | null
  course: string | null
  term: string | null
  slide_number: number | null
}

export type ChatMessage =
  | { role: 'user'; id: string; text: string }
  | {
      role: 'assistant'
      id: string
      text: string
      mode: TutorMode
      confidence: number
      sources: TutorSource[]
      turnId: string | null
    }
  | { role: 'error'; id: string; text: string }

export interface SavedChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  conversationId: string | null
  messages: ChatMessage[]
}

// -----------------------------------------------------------------------------
// Store contract
// -----------------------------------------------------------------------------

interface ChatStoreState {
  chats: SavedChat[]
  activeChatId: string | null

  appendMessage: (msg: ChatMessage) => void
  setConversationId: (id: string) => void
  newChat: () => void
  loadChat: (id: string) => void
  deleteChat: (id: string) => void
}

// Placeholder used for a chat that has no meaningful title yet. A chat starts
// with this and gets a real title from its first user message.
const UNTITLED = 'New chat'
const TITLE_MAX = 48

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= TITLE_MAX) return trimmed
  return trimmed.slice(0, TITLE_MAX).trimEnd()
}

function newId(): string {
  return crypto.randomUUID()
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set) => ({
      chats: [],
      activeChatId: null,

      appendMessage: (msg) =>
        set((state) => {
          const now = Date.now()
          let chats = state.chats
          let activeChatId = state.activeChatId

          // No active chat → start a fresh session and make it active.
          if (activeChatId === null) {
            const fresh: SavedChat = {
              id: newId(),
              title: UNTITLED,
              createdAt: now,
              updatedAt: now,
              conversationId: null,
              messages: [],
            }
            chats = [...chats, fresh]
            activeChatId = fresh.id
          }

          const nextChats = chats.map((chat) => {
            if (chat.id !== activeChatId) return chat

            // Derive the title from the first user message if still untitled.
            const isFirstUserMessage =
              msg.role === 'user' &&
              !chat.messages.some((m) => m.role === 'user')
            const titleIsPlaceholder =
              chat.title.trim().length === 0 || chat.title === UNTITLED
            const title =
              isFirstUserMessage && titleIsPlaceholder
                ? deriveTitle(msg.text)
                : chat.title

            return {
              ...chat,
              title,
              updatedAt: now,
              messages: [...chat.messages, msg],
            }
          })

          return { chats: nextChats, activeChatId }
        }),

      setConversationId: (id) =>
        set((state) => {
          if (state.activeChatId === null) return state
          return {
            chats: state.chats.map((chat) =>
              chat.id === state.activeChatId
                ? { ...chat, conversationId: id, updatedAt: Date.now() }
                : chat,
            ),
          }
        }),

      // Detach the active pointer so the next appendMessage starts a new
      // session. Existing chats are preserved.
      newChat: () => set({ activeChatId: null }),

      loadChat: (id) => set({ activeChatId: id }),

      deleteChat: (id) =>
        set((state) => ({
          chats: state.chats.filter((chat) => chat.id !== id),
          activeChatId:
            state.activeChatId === id ? null : state.activeChatId,
        })),
    }),
    {
      name: 'rumbo-tutor-chats',
    },
  ),
)

// -----------------------------------------------------------------------------
// Selector hooks
// -----------------------------------------------------------------------------

// The active chat, or null when no chat is active (fresh "New chat" state).
export function useActiveChat(): SavedChat | null {
  return useChatStore(
    (state) =>
      state.chats.find((chat) => chat.id === state.activeChatId) ?? null,
  )
}

// All saved chats, most-recently-updated first.
// useShallow: the sort() produces a new array every call, which would make
// useSyncExternalStore see a "changed" snapshot on every render and loop
// forever. Shallow-comparing the elements lets zustand reuse the previous
// array reference when the underlying chats are unchanged.
export function useChatList(): SavedChat[] {
  return useChatStore(
    useShallow((state) =>
      [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt),
    ),
  )
}
