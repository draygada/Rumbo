// Cohere adapter — embed-v4 for all embeddings + Rerank 4 for retrieval reranking.
//
// input_type discipline (enforced by callers):
//   - 'search_document' — ingest-side body + chunk embeddings
//   - 'search_query'    — retrieval-side query embedding
//   - 'classification'  — classifier-side comparisons
//   - 'clustering'      — concept-name embedding for candidate lookup
//
// Env: COHERE_API_KEY. Fail-soft — returns null / empty arrays on any error.

const COHERE_EMBED_API = 'https://api.cohere.com/v2/embed'
const COHERE_RERANK_API = 'https://api.cohere.com/v2/rerank'

export const COHERE_EMBED_MODEL = 'embed-v4.0'
export const COHERE_RERANK_MODEL = 'rerank-v3.5'
export const COHERE_EMBED_DIM = 1536

// Cohere hard-caps at 96 texts per embed request.
const EMBED_BATCH = 96
// Max chars per text (approx; Cohere handles this internally but we cap to
// avoid one bad long input rejecting the whole batch).
const EMBED_TEXT_CAP = 8000

export type CohereInputType =
  | 'search_document'
  | 'search_query'
  | 'classification'
  | 'clustering'

function apiKey(): string | null {
  return Deno.env.get('COHERE_API_KEY') ?? null
}

// -----------------------------------------------------------------------------
// Embed — batch, input_type disciplined.
// -----------------------------------------------------------------------------

export async function cohereEmbedBatch(
  texts: string[],
  inputType: CohereInputType,
): Promise<Array<number[] | null>> {
  const key = apiKey()
  if (!key) return texts.map(() => null)
  const results: Array<number[] | null> = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map(t => t.slice(0, EMBED_TEXT_CAP))
    try {
      const res = await fetch(COHERE_EMBED_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: COHERE_EMBED_MODEL,
          input_type: inputType,
          texts: batch,
          embedding_types: ['float'],
          output_dimension: COHERE_EMBED_DIM,
          truncate: 'END',
        }),
      })
      if (!res.ok) {
        console.warn(`[cohere] embed ${res.status}: ${(await res.text()).slice(0, 240)}`)
        for (const _ of batch) results.push(null)
        continue
      }
      const data = await res.json()
      const embs: number[][] = data?.embeddings?.float ?? []
      for (let j = 0; j < batch.length; j++) {
        results.push(embs[j] ?? null)
      }
    } catch (err) {
      console.warn('[cohere] embed error:', err)
      for (const _ of batch) results.push(null)
    }
  }
  return results
}

export async function cohereEmbed(
  text: string,
  inputType: CohereInputType,
): Promise<number[] | null> {
  const [emb] = await cohereEmbedBatch([text], inputType)
  return emb
}

// -----------------------------------------------------------------------------
// Rerank — returns index + relevance_score, ordered by score desc.
//
// Documents must be pre-formatted with the metadata prefix per pipeline-v4.md
// §6.6 reranker input format: `[<source_type> · <title> · <slide|section>] <chunk_text>`
// This function is content-agnostic — caller formats.
// -----------------------------------------------------------------------------

export interface RerankHit {
  index: number
  relevance_score: number
}

export async function cohereRerank(args: {
  query: string
  documents: string[]
  topN?: number
}): Promise<RerankHit[]> {
  const key = apiKey()
  if (!key) return []
  if (args.documents.length === 0) return []
  const topN = args.topN ?? Math.min(args.documents.length, 20)
  try {
    const res = await fetch(COHERE_RERANK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: COHERE_RERANK_MODEL,
        query: args.query,
        documents: args.documents,
        top_n: topN,
        return_documents: false,
      }),
    })
    if (!res.ok) {
      console.warn(`[cohere] rerank ${res.status}: ${(await res.text()).slice(0, 240)}`)
      return []
    }
    const data = await res.json()
    const results: RerankHit[] = (data?.results ?? []).map((r: { index: number; relevance_score: number }) => ({
      index: r.index,
      relevance_score: r.relevance_score,
    }))
    return results
  } catch (err) {
    console.warn('[cohere] rerank error:', err)
    return []
  }
}
