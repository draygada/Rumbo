// html-to-md — lightweight HTML → Markdown converter for the v4 ingest path.
//
// Runs before the chunker so structural cues (headings, lists, blockquotes,
// code, links, tables) survive into the chunked text_for_embed. Not a full
// parser; heuristic and fast, tolerant of Canvas / Google Docs HTML.
//
// Order matters — we process from block-level down to inline.

interface ConvertResult {
  markdown: string
  headings: Array<{ level: number; text: string }>
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
}

function stripInlineTags(s: string): string {
  return s
    .replace(/<(strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$2*')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

export function htmlToMarkdown(html: string): ConvertResult {
  if (!html) return { markdown: '', headings: [] }

  const headings: Array<{ level: number; text: string }> = []
  let md = html

  // Strip head/style/script.
  md = md.replace(/<head[\s\S]*?<\/head>/gi, '')
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '')
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '')

  // Headings — record + convert.
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
    const level = Number(lvl)
    const text = decodeEntities(stripInlineTags(inner)).trim()
    if (text) headings.push({ level, text })
    return `\n\n${'#'.repeat(level)} ${text}\n\n`
  })

  // Block-level: p, div, blockquote, pre.
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const raw = decodeEntities(inner.replace(/<[^>]+>/g, ''))
    return `\n\n\`\`\`\n${raw.trim()}\n\`\`\`\n\n`
  })
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const lines = decodeEntities(stripInlineTags(inner)).trim().split(/\n+/)
    return '\n\n' + lines.map(l => `> ${l.trim()}`).join('\n') + '\n\n'
  })
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${decodeEntities(stripInlineTags(inner)).trim()}\n\n`)
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, (_, inner) => `\n${decodeEntities(stripInlineTags(inner)).trim()}\n`)

  // Lists.
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, item: string) =>
      `- ${decodeEntities(stripInlineTags(item)).trim()}\n`,
    ) + '\n'
  })
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let i = 1
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, item: string) =>
      `${i++}. ${decodeEntities(stripInlineTags(item)).trim()}\n`,
    ) + '\n'
  })

  // Tables — collapse to pipe-separated rows.
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
    const rows: string[] = []
    inner.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m: string, rowInner: string) => {
      const cells: string[] = []
      rowInner.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_c: string, cellInner: string) => {
        cells.push(decodeEntities(stripInlineTags(cellInner)).trim())
        return ''
      })
      if (cells.length > 0) rows.push('| ' + cells.join(' | ') + ' |')
      return ''
    })
    return '\n\n' + rows.join('\n') + '\n\n'
  })

  // Anything remaining — strip inline tags + decode entities.
  md = decodeEntities(stripInlineTags(md))

  // Whitespace normalize — collapse runs of blank lines.
  md = md.replace(/[ \t]+\n/g, '\n')
  md = md.replace(/\n{3,}/g, '\n\n')
  md = md.trim()

  return { markdown: md, headings }
}
