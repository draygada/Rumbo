import { useChatStore } from '../chatStore'

// stopGenerating is the user-facing "Stop generating" button. The thing that
// makes it different from stopStreaming (New chat) is that it must KEEP the
// partial answer, so that's what these cover.

function reset() {
  useChatStore.setState({ chats: [], activeChatId: null, streaming: null })
}

function startTurn(prompt = 'hi') {
  reset()
  // appendMessage auto-creates the chat when there isn't one.
  useChatStore.getState().appendMessage({ role: 'user', id: 'u1', text: prompt })
  const chatId = useChatStore.getState().activeChatId as string
  useChatStore.getState().startStreaming(chatId, new AbortController())
  return chatId
}

test('stopGenerating commits the partial answer to the chat', () => {
  const chatId = startTurn()
  useChatStore.getState().appendStreamDelta('Spaced repetition is')
  useChatStore.getState().appendStreamDelta(' a study technique')

  useChatStore.getState().stopGenerating()

  const chat = useChatStore.getState().chats.find(c => c.id === chatId)!
  const last = chat.messages[chat.messages.length - 1]
  expect(last.role).toBe('assistant')
  expect(last.text).toBe('Spaced repetition is a study technique')
  expect(useChatStore.getState().streaming).toBeNull()
})

test('stopGenerating aborts the in-flight request', () => {
  reset()
  useChatStore.getState().appendMessage({ role: 'user', id: 'u1', text: 'hi' })
  const chatId = useChatStore.getState().activeChatId as string
  const controller = new AbortController()
  useChatStore.getState().startStreaming(chatId, controller)
  useChatStore.getState().appendStreamDelta('partial')

  useChatStore.getState().stopGenerating()

  expect(controller.signal.aborted).toBe(true)
})

test('stopGenerating drops the turn when nothing streamed yet', () => {
  const chatId = startTurn()

  useChatStore.getState().stopGenerating()

  const chat = useChatStore.getState().chats.find(c => c.id === chatId)!
  // Just the user message — no empty assistant bubble.
  expect(chat.messages).toHaveLength(1)
  expect(chat.messages[0].role).toBe('user')
  expect(useChatStore.getState().streaming).toBeNull()
})

test('stopStreaming still discards the partial (New chat behaviour)', () => {
  const chatId = startTurn()
  useChatStore.getState().appendStreamDelta('half an answer')

  useChatStore.getState().stopStreaming()

  const chat = useChatStore.getState().chats.find(c => c.id === chatId)!
  expect(chat.messages).toHaveLength(1)
  expect(useChatStore.getState().streaming).toBeNull()
})

test('a stopped turn commits to its own chat, not whichever is active later', () => {
  const chatId = startTurn()
  useChatStore.getState().appendStreamDelta('answer for the first chat')

  // Student starts a second chat while the first is still streaming.
  useChatStore.setState({ activeChatId: null })
  useChatStore.getState().appendMessage({ role: 'user', id: 'u2', text: 'different question' })
  const otherId = useChatStore.getState().activeChatId as string

  useChatStore.getState().stopGenerating()

  const origin = useChatStore.getState().chats.find(c => c.id === chatId)!
  const other = useChatStore.getState().chats.find(c => c.id === otherId)!
  expect(origin.messages[origin.messages.length - 1].text).toBe('answer for the first chat')
  expect(other.messages).toHaveLength(1)
})
