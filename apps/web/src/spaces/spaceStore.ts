// -----------------------------------------------------------------------------
// spaceStore — which space you're standing in, and what each space remembers.
//
// A "space" is a workspace bound to one class (Arc-style). It owns the scope
// every surface reads — chat retrieval, the Brain graph, Tasks, Courses — plus
// its own accent colour and its own last-open conversation.
//
// Spaces are DERIVED, not authored: Home plus one per currently-active Canvas
// course (see useSpaces.ts). This store holds only the two things that can't be
// derived — the spaces the student created by hand, and per-space memory.
//
// Cross-store note: entering a space imperatively swaps chatStore's active
// chat. That's deliberate — doing it in a React effect instead would race the
// render that reads `pendingCourseId`, and could start a turn under the old
// scope. See enterSpace().
// -----------------------------------------------------------------------------

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useChatStore } from '../chat/chatStore'

export const HOME_SPACE_ID = 'home'

export interface CustomSpace {
  /** 'custom:<uuid>' — namespaced so it can never collide with a course_id. */
  id: string
  name: string
  /** course_id this space scopes to, or null for all classes. */
  courseId: string | null
}

interface SpaceStoreState {
  custom: CustomSpace[]
  activeSpaceId: string
  /** space id → the chat that was open there, so swiping back resumes it. */
  lastChatIdBySpace: Record<string, string | null>

  enterSpace: (spaceId: string, courseId: string | null) => void
  createSpace: (name: string, courseId: string | null) => string
  deleteSpace: (id: string) => void
  /** Snapshot the active chat into the active space (called as chats change). */
  rememberActiveChat: () => void
}

function newId(): string {
  return `custom:${crypto.randomUUID()}`
}

export const useSpaceStore = create<SpaceStoreState>()(
  persist(
    (set, get) => ({
      custom: [],
      activeSpaceId: HOME_SPACE_ID,
      lastChatIdBySpace: {},

      enterSpace: (spaceId, courseId) => {
        const state = get()
        if (state.activeSpaceId === spaceId) return

        const chat = useChatStore.getState()

        // Hand the space we're leaving its current conversation back.
        const remembered = {
          ...state.lastChatIdBySpace,
          [state.activeSpaceId]: chat.activeChatId,
        }
        set({ activeSpaceId: spaceId, lastChatIdBySpace: remembered })

        // Restore the target space's conversation. A remembered id can be stale
        // (the chat was deleted), so verify before loading it.
        const target = remembered[spaceId] ?? null
        if (target && chat.chats.some(c => c.id === target)) {
          chat.loadChat(target)
        } else {
          chat.newChat()
        }
        // Scope for the next chat started here. An existing chat keeps the
        // courseId it was born with — see SavedChat.courseId.
        chat.setPendingCourseId(courseId)
      },

      createSpace: (name, courseId) => {
        const id = newId()
        set(state => ({ custom: [...state.custom, { id, name: name.trim(), courseId }] }))
        get().enterSpace(id, courseId)
        return id
      },

      deleteSpace: (id) =>
        set(state => {
          const rest = { ...state.lastChatIdBySpace }
          delete rest[id]
          return {
            custom: state.custom.filter(s => s.id !== id),
            // Deleting the space you're in drops you Home rather than nowhere.
            activeSpaceId: state.activeSpaceId === id ? HOME_SPACE_ID : state.activeSpaceId,
            lastChatIdBySpace: rest,
          }
        }),

      rememberActiveChat: () =>
        set(state => ({
          lastChatIdBySpace: {
            ...state.lastChatIdBySpace,
            [state.activeSpaceId]: useChatStore.getState().activeChatId,
          },
        })),
    }),
    { name: 'rumbo-spaces' },
  ),
)
