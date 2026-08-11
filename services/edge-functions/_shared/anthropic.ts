// Anthropic adapter — Haiku for classification/extraction, Opus for reasoning.
//
// Call shapes:
//   1. JSON via tool_use (schema-constrained one-shot)
//   2. JSON via tool_use with extended thinking (Opus reasoning layer)
//
// Env: ANTHROPIC_API_KEY. All calls fail-soft (return null + warn) so the
// caller can mark the record 'pending' and retry — never surface partial state.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
export const OPUS_MODEL = 'claude-opus-4-5'
export const SONNET_MODEL = 'claude-sonnet-4-6'

function apiKey(): string | null {
  return Deno.env.get('ANTHROPIC_API_KEY') ?? null
}

export interface AnthropicJsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  properties?: Record<string, AnthropicJsonSchema>
  items?: AnthropicJsonSchema
  enum?: string[]
  required?: string[]
  description?: string
  minimum?: number
  maximum?: number
}

// -----------------------------------------------------------------------------
// One-shot JSON extraction via a single tool_use. Forces the model to invoke
// the tool by setting tool_choice to that specific tool name.
// -----------------------------------------------------------------------------

export async function anthropicToolJson<T>(args: {
  system: string
  userText: string
  toolName: string
  toolDescription: string
  schema: AnthropicJsonSchema
  model?: string
  maxTokens?: number
  temperature?: number
}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? HAIKU_MODEL
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: args.maxTokens ?? 1024,
        temperature: args.temperature ?? 0,
        system: args.system,
        tools: [{
          name: args.toolName,
          description: args.toolDescription,
          input_schema: args.schema,
        }],
        tool_choice: { type: 'tool', name: args.toolName },
        messages: [{ role: 'user', content: args.userText }],
      }),
    })
    if (!res.ok) {
      console.warn(`[anthropic] tool ${res.status}: ${(await res.text()).slice(0, 240)}`)
      return null
    }
    const data = await res.json()
    const content = data?.content ?? []
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === args.toolName) {
        return (block.input ?? {}) as T
      }
    }
    return null
  } catch (err) {
    console.warn('[anthropic] tool error:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Plain text generation (no tools). Used by answer generation for tutoring,
// exploration, lookup, and cross_course modes.
// -----------------------------------------------------------------------------

export async function anthropicText(args: {
  system: string
  userText: string
  model?: string
  maxTokens?: number
  temperature?: number
}): Promise<string | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? SONNET_MODEL
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: args.maxTokens ?? 1500,
        temperature: args.temperature ?? 0.4,
        system: args.system,
        messages: [{ role: 'user', content: args.userText }],
      }),
    })
    if (!res.ok) {
      console.warn(`[anthropic] text ${res.status} (${model}): ${(await res.text()).slice(0, 240)}`)
      return null
    }
    const data = await res.json()
    const content = data?.content ?? []
    const text = content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('')
    return text.trim() || null
  } catch (err) {
    console.warn('[anthropic] text error:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Opus with extended thinking (min-budget). Same tool_use shape, but wraps the
// call with a thinking budget so the model can reason before emitting. Used
// for the pedagogical-tier reasoning layer in extraction.
//
// Anthropic API requires temperature=1 when thinking is enabled.
// -----------------------------------------------------------------------------

export async function reasonWithThinkingJson<T>(args: {
  system: string
  userText: string
  toolName: string
  toolDescription: string
  schema: AnthropicJsonSchema
  model?: string          // defaults to Sonnet 4.6 (cost/quality sweet spot for V0)
  thinkingBudget?: number
  maxTokens?: number
}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  const thinkingBudget = args.thinkingBudget ?? 1024
  const maxTokens = args.maxTokens ?? 4096
  const model = args.model ?? SONNET_MODEL
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 1,
        thinking: { type: 'enabled', budget_tokens: thinkingBudget },
        system: args.system,
        tools: [{
          name: args.toolName,
          description: args.toolDescription,
          input_schema: args.schema,
        }],
        // Extended thinking requires `auto` — Anthropic treats both `tool` and
        // `any` as "forcing tool use" and rejects the request. With one tool
        // in the array + a system prompt that directs the model to invoke it,
        // `auto` reliably picks the tool.
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: args.userText }],
      }),
    })
    if (!res.ok) {
      console.warn(`[anthropic] reason ${res.status}: ${(await res.text()).slice(0, 240)}`)
      return null
    }
    const data = await res.json()
    const content = data?.content ?? []
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === args.toolName) {
        return (block.input ?? {}) as T
      }
    }
    return null
  } catch (err) {
    console.warn('[anthropic] reason error:', err)
    return null
  }
}

// Back-compat alias — existing callers referenced `opusReasonJson`.
export const opusReasonJson = reasonWithThinkingJson
