// query-rewriter — turn a multi-turn conversation into a standalone query.
//
// Gemini Flash is used ONLY here (per pipeline-v4.md model stack decision:
// Anthropic + Cohere everywhere except this one trivial task, where Flash's
// latency/cost profile wins). All other LLM calls in v4 use Anthropic.
//
// Input: prior turns + the student's current message.
// Output: a self-contained query the router/retrieval can operate on.
//
// Fail-soft: on error, returns the raw current message untouched.

import { geminiClassifyJson } from './gemini.ts'

interface RewriteOut {
  standalone_query: string
  needs_context: boolean
}

const SYSTEM = `You rewrite a student's tutor conversation into a SINGLE STANDALONE query.

You get:
- PRIOR_TURNS: the last few user + assistant messages (may be empty)
- CURRENT: the student's new message

Return:
- standalone_query: a self-contained question that a retrieval system could
  operate on without any prior context. Resolve pronouns ("this", "it",
  "the one before") to their specific referents from PRIOR_TURNS.
- needs_context: true if you had to resolve a reference from PRIOR_TURNS;
  false if CURRENT was already standalone.

If CURRENT is already standalone, return it verbatim.
Never invent detail not present in either PRIOR_TURNS or CURRENT.`

const SCHEMA = {
  type: 'object' as const,
  properties: {
    standalone_query: { type: 'string' as const },
    needs_context: { type: 'boolean' as const },
  },
  required: ['standalone_query', 'needs_context'],
}

export interface PriorTurn {
  role: 'user' | 'assistant'
  text: string
}

export async function rewriteQuery(args: {
  currentMessage: string
  priorTurns: PriorTurn[]
}): Promise<{ query: string; rewritten: boolean }> {
  const current = args.currentMessage.trim()
  if (!current) return { query: current, rewritten: false }
  if (args.priorTurns.length === 0) return { query: current, rewritten: false }

  const turnsBlock = args.priorTurns
    .slice(-6)
    .map(t => `${t.role.toUpperCase()}: ${t.text.slice(0, 500)}`)
    .join('\n')

  const userText = `PRIOR_TURNS:
${turnsBlock}

CURRENT:
${current}`

  const out = await geminiClassifyJson<RewriteOut>({
    system: SYSTEM, userText, schema: SCHEMA, maxTokens: 256,
  })
  if (!out?.standalone_query) return { query: current, rewritten: false }
  return { query: out.standalone_query.trim(), rewritten: !!out.needs_context }
}
