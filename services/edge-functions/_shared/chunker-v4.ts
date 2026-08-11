// chunker-v4 — content_format-dispatched chunking.
//
// Four strategies (per pipeline-v4.md §5.4):
//   slides      — one chunk per slide (parse "Slide N of M" markers or ---
//                 separators); slide title becomes the heading
//   sectioned   — split on markdown H1/H2/H3; each section is one chunk unless
//                 it exceeds MAX_SECTION, in which case sub-split with overlap
//   paragraphed — sliding-window over paragraphs (~1500 chars, ~200 overlap),
//                 heading defaults to null
//   flat        — no chunking (returns [] — the doc-level embedding is enough)
//
// Every returned chunk carries `text_for_embed = "[Section: <heading>]\n<text>"`
// or, when no heading, the raw text. This preserves structural context in the
// vector, matching v3's format so downstream indexes stay compatible.

import type { ContentFormat } from './content-format.ts'

export interface ChunkV4 {
  index: number
  heading: string | null
  text: string
  text_for_embed: string
  char_start: number
  char_end: number
}

const MAX_SECTION = 3000
const WINDOW_SIZE = 1500
const WINDOW_OVERLAP = 200
const FLAT_CAP = 500

export function chunkV4(args: {
  markdown: string
  format: ContentFormat
}): ChunkV4[] {
  const md = args.markdown.trim()
  if (!md) return []

  switch (args.format) {
    case 'flat':
      return md.length <= FLAT_CAP ? [] : chunkParagraphed(md)
    case 'slides':
      return chunkSlides(md)
    case 'sectioned':
      return chunkSectioned(md)
    case 'paragraphed':
    default:
      return chunkParagraphed(md)
  }
}

function embedText(heading: string | null, text: string): string {
  return heading ? `[Section: ${heading}]\n${text}` : text
}

// ---------------------------------------------------------------------------
// Slides — split on "Slide N of M" / "Slide N" / horizontal rules / page marks.
// ---------------------------------------------------------------------------
function chunkSlides(md: string): ChunkV4[] {
  const markerRe = /(?:^|\n)(?:---+|Slide\s+\d+(?:\s+of\s+\d+)?)/gi
  const positions: number[] = []
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(md)) !== null) positions.push(m.index)
  if (positions.length < 2) return chunkSectioned(md)

  const chunks: ChunkV4[] = []
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]
    const end = i + 1 < positions.length ? positions[i + 1] : md.length
    const raw = md.slice(start, end).trim()
    if (raw.length < 40) continue
    // First line becomes the heading (slide title).
    const firstBreak = raw.indexOf('\n')
    const heading = firstBreak > 0 ? raw.slice(0, firstBreak).replace(/^[-#\s]+/, '').trim() : null
    const text = firstBreak > 0 ? raw.slice(firstBreak + 1).trim() : raw
    if (!text) continue
    chunks.push({
      index: chunks.length,
      heading: heading || null,
      text,
      text_for_embed: embedText(heading || null, text),
      char_start: start,
      char_end: end,
    })
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Sectioned — split on markdown H1/H2/H3.
// ---------------------------------------------------------------------------
function chunkSectioned(md: string): ChunkV4[] {
  const headingRe = /^(#{1,3})\s+(.+)$/gm
  const marks: Array<{ index: number; heading: string }> = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(md)) !== null) {
    marks.push({ index: m.index, heading: m[2].trim() })
  }
  if (marks.length < 2) return chunkParagraphed(md)

  const chunks: ChunkV4[] = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index
    const end = i + 1 < marks.length ? marks[i + 1].index : md.length
    const raw = md.slice(start, end).trim()
    const bodyStart = raw.indexOf('\n')
    const body = bodyStart > 0 ? raw.slice(bodyStart + 1).trim() : ''
    if (!body) continue

    if (body.length <= MAX_SECTION) {
      chunks.push({
        index: chunks.length,
        heading: marks[i].heading,
        text: body,
        text_for_embed: embedText(marks[i].heading, body),
        char_start: start,
        char_end: end,
      })
    } else {
      // Section too long — sub-window it, keep heading on each chunk.
      let cursor = 0
      while (cursor < body.length) {
        const sliceEnd = Math.min(cursor + WINDOW_SIZE, body.length)
        const text = body.slice(cursor, sliceEnd).trim()
        if (text.length >= 100) {
          chunks.push({
            index: chunks.length,
            heading: marks[i].heading,
            text,
            text_for_embed: embedText(marks[i].heading, text),
            char_start: start + cursor,
            char_end: start + sliceEnd,
          })
        }
        cursor += WINDOW_SIZE - WINDOW_OVERLAP
      }
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Paragraphed — sliding window, no headings.
// ---------------------------------------------------------------------------
function chunkParagraphed(md: string): ChunkV4[] {
  if (md.length <= WINDOW_SIZE) {
    return [{
      index: 0,
      heading: null,
      text: md,
      text_for_embed: md,
      char_start: 0,
      char_end: md.length,
    }]
  }
  const chunks: ChunkV4[] = []
  let cursor = 0
  while (cursor < md.length) {
    const end = Math.min(cursor + WINDOW_SIZE, md.length)
    // Try to end on a paragraph break for cleaner semantics.
    const window = md.slice(cursor, end)
    let breakAt = end
    if (end < md.length) {
      const lastPara = window.lastIndexOf('\n\n')
      if (lastPara > WINDOW_SIZE / 2) breakAt = cursor + lastPara
    }
    const text = md.slice(cursor, breakAt).trim()
    if (text.length >= 100) {
      chunks.push({
        index: chunks.length,
        heading: null,
        text,
        text_for_embed: text,
        char_start: cursor,
        char_end: breakAt,
      })
    }
    cursor = breakAt - WINDOW_OVERLAP
    if (cursor <= chunks[chunks.length - 1]?.char_start) break
  }
  return chunks
}
