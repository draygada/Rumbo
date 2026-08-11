// content-format — Haiku classifier that decides which chunking strategy the
// v4 ingest pipeline should apply to a record.
//
// Four outputs (matches normalized_events.content_format check constraint):
//   - 'slides'      — deck-style: slide N of M, bullet-heavy, terse
//   - 'sectioned'   — has real headings (h1/h2/h3, ## markdown); most syllabi,
//                     home pages, readings with sections
//   - 'paragraphed' — prose without headings; announcements, some assignments
//   - 'flat'        — short, single-block content; page titles, brief pages
//
// The classifier reads a signal window (first N chars) — enough to decide
// structure without shipping the whole doc to the LLM.

import { anthropicToolJson, HAIKU_MODEL } from './anthropic.ts'

const SIGNAL_WINDOW = 3500

export type ContentFormat = 'slides' | 'sectioned' | 'paragraphed' | 'flat'

interface FormatOut {
  format: ContentFormat
  confidence: number
}

const CLASSIFY_SYSTEM = `You classify course material by document STRUCTURE so a downstream chunker can pick the right strategy.

Return exactly one format:
- "slides"      — slide deck output. Signals: "Slide 3 of 42", short bullets, numbered slide markers, one-idea-per-frame layout.
- "sectioned"   — has real headings (h1/h2/h3, markdown ##, "Chapter 4:", numbered outline). Sections carry distinct topics.
- "paragraphed" — prose without headings; runs of paragraphs on one topic. Announcements, description-style assignments.
- "flat"        — short or single-block content that doesn't need chunking (< 500 chars of substance, or a single paragraph).

If the text is under ~400 substantive characters, return "flat".
If uncertain between sectioned and paragraphed, prefer paragraphed.
Confidence 0-1; return 0.6+ when the signals are clear.`

export async function detectContentFormat(args: {
  text: string
  html?: string | null
  sourceType: string
}): Promise<ContentFormat> {
  const signal = (args.html ?? args.text).slice(0, SIGNAL_WINDOW)
  if (signal.trim().length < 400) return 'flat'

  const userText = `SOURCE_TYPE: ${args.sourceType}

SIGNAL WINDOW (first ${SIGNAL_WINDOW} chars):
${signal}`

  const out = await anthropicToolJson<FormatOut>({
    system: CLASSIFY_SYSTEM,
    userText,
    toolName: 'emit_content_format',
    toolDescription: 'Emit the detected content format for this document.',
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['slides', 'sectioned', 'paragraphed', 'flat'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['format', 'confidence'],
    },
    model: HAIKU_MODEL,
    maxTokens: 128,
  })
  if (!out || !out.format) return 'paragraphed'
  return out.format
}
