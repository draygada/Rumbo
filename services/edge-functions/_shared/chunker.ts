// chunker — adaptive text chunking for the v3 extraction pipeline.
//
// Rule (from BACKLOG.md + design conversation):
//   < 4000 chars     → no chunks (single doc body_embedding is enough)
//   4000-8000 chars  → chunk only if HTML has ≥3 headings; heading-aware split
//   > 8000 chars     → always chunk; heading-aware if possible, else fixed
//                       1500-char blocks with 200-char overlap
//
// Every chunk is prefixed with its heading (if any) at embed time so vectors
// capture structural context, not just raw words.

export interface Chunk {
  index: number
  heading: string | null
  text: string          // raw chunk body (no heading prefix)
  text_for_embed: string // "[Section: X]\n<text>" — what we actually embed
  char_start: number
  char_end: number
}

const NO_CHUNK_THRESHOLD = 4000
const MUST_CHUNK_THRESHOLD = 8000
const FIXED_CHUNK_SIZE = 1500
const FIXED_CHUNK_OVERLAP = 200
const MIN_HEADINGS_FOR_STRUCTURE = 3

// Strip HTML for text-only chunking. Keeps <h1>-<h6>, <p> boundaries useful
// as anchors so we can preserve headings.
export function extractHeadingsFromHtml(html: string): Array<{ heading: string; body: string }> {
  if (!html) return []
  const sections: Array<{ heading: string; body: string }> = []
  // Split on any heading tag.
  const parts = html.split(/<(h[1-3])[^>]*>/i)
  // parts alternates: [before, tag, headingText, ...]. Actually .split with a
  // capture group interleaves the captured tag. We use a manual pass instead:
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi
  const matches: Array<{ index: number; tag: string; heading: string }> = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(html)) !== null) {
    matches.push({ index: m.index, tag: `h${m[1]}`, heading: stripHtmlInline(m[2]) })
  }
  if (matches.length === 0) return []
  // Body of each section is the HTML between this heading and the next.
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + html.slice(matches[i].index).indexOf('>') + 1
    // ^ skip past the closing '>' of the opening tag; body starts after
    // Actually simpler: use regex position + full match length:
    const rawStart = matches[i].index
    const nextRawStart = i + 1 < matches.length ? matches[i + 1].index : html.length
    const rawBody = html.slice(rawStart, nextRawStart)
    // Strip the heading tag itself from the rawBody so body is post-heading content.
    const bodyOnly = rawBody.replace(/<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/i, '').trim()
    void start
    sections.push({ heading: matches[i].heading.trim(), body: stripHtmlInline(bodyOnly).trim() })
  }
  return sections.filter(s => s.heading || s.body)
}

function stripHtmlInline(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// Main entry: given plain text (and optional source HTML for heading extraction),
// decide whether to chunk and return the list.
export interface ChunkArgs {
  text: string           // plain-text body
  html?: string | null   // optional HTML source for heading detection
}

export function chunk({ text, html }: ChunkArgs): Chunk[] {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return []

  // Below threshold: no chunks.
  if (trimmed.length < NO_CHUNK_THRESHOLD) return []

  // Try heading-aware split first when we have HTML.
  if (html) {
    const sections = extractHeadingsFromHtml(html)
    if (sections.length >= MIN_HEADINGS_FOR_STRUCTURE) {
      return sections.map((s, i) => {
        const heading = s.heading || null
        const body = s.body || ''
        const textForEmbed = heading ? `[Section: ${heading}]\n${body}` : body
        return {
          index: i,
          heading,
          text: body,
          text_for_embed: textForEmbed,
          char_start: 0, // heading-aware chunks don't have exact source positions
          char_end: body.length,
        }
      }).filter(c => c.text.length > 0)
    }
  }

  // 4000–8000 chars without ≥3 headings → skip chunking.
  if (trimmed.length < MUST_CHUNK_THRESHOLD) return []

  // Fixed-length chunks with overlap.
  return fixedLengthChunks(trimmed, FIXED_CHUNK_SIZE, FIXED_CHUNK_OVERLAP)
}

function fixedLengthChunks(text: string, size: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = []
  let start = 0
  let index = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    // Snap to paragraph boundary if possible within a 200-char window before end.
    if (end < text.length) {
      const snapWindow = Math.max(start + 1, end - 200)
      const cutIdx = text.lastIndexOf('\n\n', end)
      if (cutIdx > snapWindow) end = cutIdx
    }
    const body = text.slice(start, end).trim()
    if (body) {
      chunks.push({
        index,
        heading: null,
        text: body,
        text_for_embed: body,
        char_start: start,
        char_end: end,
      })
      index += 1
    }
    if (end >= text.length) break
    start = Math.max(0, end - overlap)
  }
  return chunks
}
