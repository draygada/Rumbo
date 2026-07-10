// Gemini adapter — single provider used across all V0 LLM calls.
//
// Covers three call shapes:
//   1. JSON classification — one-shot, schema-constrained JSON out
//   2. Tool-use extraction — Gemini function calling, one tool declared
//   3. Multimodal PDF read — inline base64 document
//   4. Embeddings — gemini-embedding-001 with outputDimensionality=1536
//      (matches the vector(1536) column shape without a schema migration).
//
// Env: GEMINI_API_KEY. All calls fail-soft — the caller decides what to do
// (usually: mark 'pending' and try later), so the API never surfaces a
// half-baked result.

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta'

// -----------------------------------------------------------------------------
// Model choices — see https://ai.google.dev/gemini-api/docs/models
// -----------------------------------------------------------------------------
export const GEMINI_FAST_MODEL = 'gemini-2.5-flash'
export const GEMINI_STRONG_MODEL = 'gemini-2.5-pro'
export const GEMINI_EMBED_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIM = 1536

function apiKey(): string | null {
  return Deno.env.get('GEMINI_API_KEY') ?? null
}

// -----------------------------------------------------------------------------
// JSON classification — response_mime_type + response_schema
// -----------------------------------------------------------------------------

export interface GeminiJsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  properties?: Record<string, GeminiJsonSchema>
  items?: GeminiJsonSchema
  enum?: string[]
  required?: string[]
  description?: string
  minimum?: number
  maximum?: number
}

export async function geminiClassifyJson<T>(args: {
  system: string
  userText: string
  schema: GeminiJsonSchema
  model?: string
  maxTokens?: number
}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? GEMINI_FAST_MODEL
  try {
    const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: 'user', parts: [{ text: args.userText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: args.schema,
          maxOutputTokens: args.maxTokens ?? 512,
          temperature: 0,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`[gemini] classify ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    return JSON.parse(text) as T
  } catch (err) {
    console.warn('[gemini] classify error:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Function/tool calling — one tool per call, forced (any) tool_config
// -----------------------------------------------------------------------------

export interface GeminiTool {
  name: string
  description: string
  parameters: GeminiJsonSchema
}

export async function geminiCallTool<T>(args: {
  system: string
  userText: string
  tool: GeminiTool
  model?: string
  maxTokens?: number
}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? GEMINI_STRONG_MODEL
  try {
    const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.system }] },
        contents: [{ role: 'user', parts: [{ text: args.userText }] }],
        tools: [{ functionDeclarations: [args.tool] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [args.tool.name] } },
        generationConfig: {
          maxOutputTokens: args.maxTokens ?? 2048,
          temperature: 0,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`[gemini] tool ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const parts = data?.candidates?.[0]?.content?.parts ?? []
    for (const p of parts) {
      if (p.functionCall?.name === args.tool.name) {
        return (p.functionCall.args ?? {}) as T
      }
    }
    return null
  } catch (err) {
    console.warn('[gemini] tool error:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Multimodal PDF read — extract or classify document content
// -----------------------------------------------------------------------------

export async function geminiReadPdfJson<T>(args: {
  base64Pdf: string
  prompt: string
  schema: GeminiJsonSchema
  model?: string
  maxTokens?: number
}): Promise<T | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? GEMINI_STRONG_MODEL
  try {
    const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: args.base64Pdf } },
              { text: args.prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: args.schema,
          maxOutputTokens: args.maxTokens ?? 8000,
          temperature: 0,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`[gemini] pdfJson ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch (parseErr) {
      console.warn('[gemini] pdfJson parse error:', parseErr)
      return null
    }
  } catch (err) {
    console.warn('[gemini] pdfJson error:', err)
    return null
  }
}

export async function geminiReadPdf(args: {
  base64Pdf: string
  prompt: string
  model?: string
  maxTokens?: number
}): Promise<string | null> {
  const key = apiKey()
  if (!key) return null
  const model = args.model ?? GEMINI_STRONG_MODEL
  try {
    const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: args.base64Pdf } },
              { text: args.prompt },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: args.maxTokens ?? 8000,
          temperature: 0,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`[gemini] pdf ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    const parts = data?.candidates?.[0]?.content?.parts ?? []
    return parts.map((p: { text?: string }) => p.text ?? '').join('\n').trim() || null
  } catch (err) {
    console.warn('[gemini] pdf error:', err)
    return null
  }
}

// -----------------------------------------------------------------------------
// Embeddings — gemini-embedding-001 with outputDimensionality=1536
// -----------------------------------------------------------------------------

// Single embedding.
export async function geminiEmbed(text: string): Promise<number[] | null> {
  const key = apiKey()
  if (!key) return null
  try {
    const res = await fetch(`${GEMINI_API}/models/${GEMINI_EMBED_MODEL}:embedContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIM,
        taskType: 'SEMANTIC_SIMILARITY',
      }),
    })
    if (!res.ok) {
      console.warn(`[gemini] embed ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    return (data?.embedding?.values ?? null) as number[] | null
  } catch (err) {
    console.warn('[gemini] embed error:', err)
    return null
  }
}

// Batch embed — chunks into requests of 100 to stay under the API limit.
export async function geminiEmbedBatch(texts: string[]): Promise<Array<number[] | null>> {
  const key = apiKey()
  if (!key) return texts.map(() => null)
  const results: Array<number[] | null> = []
  const BATCH = 100
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH)
    try {
      const res = await fetch(`${GEMINI_API}/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: chunk.map(text => ({
            model: `models/${GEMINI_EMBED_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIM,
            taskType: 'SEMANTIC_SIMILARITY',
          })),
        }),
      })
      if (!res.ok) {
        console.warn(`[gemini] batch embed ${res.status}: ${(await res.text()).slice(0, 200)}`)
        for (const _ of chunk) results.push(null)
        continue
      }
      const data = await res.json()
      const emb = (data?.embeddings ?? []) as Array<{ values?: number[] }>
      for (let j = 0; j < chunk.length; j += 1) {
        results.push(emb[j]?.values ?? null)
      }
    } catch (err) {
      console.warn('[gemini] batch embed error:', err)
      for (const _ of chunk) results.push(null)
    }
  }
  return results
}
