// Anthropic streaming adapter — mirrors anthropicText() in anthropic.ts but
// requests a token-by-token SSE stream (`"stream": true`) and invokes an
// onDelta callback for each text delta as it arrives.
//
// Same API endpoint, headers, version, and API key as anthropic.ts. Fail-soft:
// on a non-OK response or a parse error it console.warns and returns "" so the
// caller can emit an error event to its own client rather than throwing.

import { HAIKU_MODEL, SONNET_MODEL } from './anthropic.ts'

// Re-export so callers can pick a model without also importing anthropic.ts.
export { HAIKU_MODEL, SONNET_MODEL }

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

function apiKey(): string | null {
  return Deno.env.get('ANTHROPIC_API_KEY') ?? null
}

export async function anthropicTextStream(args: {
  system: string
  userText: string
  model?: string
  maxTokens?: number
  temperature?: number
  onDelta: (chunk: string) => void
}): Promise<string> {
  const key = apiKey()
  if (!key) {
    console.warn('[anthropic-stream] missing ANTHROPIC_API_KEY')
    return ''
  }
  const model = args.model ?? SONNET_MODEL

  let res: Response
  try {
    res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: args.maxTokens ?? 1400,
        temperature: args.temperature ?? 0.4,
        stream: true,
        system: args.system,
        messages: [{ role: 'user', content: args.userText }],
      }),
    })
  } catch (err) {
    console.warn('[anthropic-stream] fetch error:', err)
    return ''
  }

  if (!res.ok || !res.body) {
    console.warn(
      `[anthropic-stream] ${res.status} (${model}): ${(await res.text().catch(() => '')).slice(0, 240)}`,
    )
    return ''
  }

  let full = ''
  try {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by blank lines; process complete lines and
      // keep the trailing partial line in the buffer.
      let nlIdx: number
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nlIdx)
        buffer = buffer.slice(nlIdx + 1)
        const line = rawLine.replace(/\r$/, '').trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const evt = JSON.parse(payload)
          if (
            evt?.type === 'content_block_delta' &&
            evt?.delta?.type === 'text_delta' &&
            typeof evt.delta.text === 'string'
          ) {
            full += evt.delta.text
            args.onDelta(evt.delta.text)
          }
          // Ignore all other event types (message_start, content_block_start,
          // content_block_stop, message_delta, ping, message_stop, etc.).
        } catch (err) {
          console.warn('[anthropic-stream] parse error:', err)
          // Skip the malformed frame but keep streaming.
        }
      }
    }
  } catch (err) {
    console.warn('[anthropic-stream] read error:', err)
    return full // return whatever we accumulated before the failure
  }

  return full
}
