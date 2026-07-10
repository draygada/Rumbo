// Manual course entry — file + URL ingestion helpers.
// Reference: Rumbo-Design-Docs/External Sources/manual-course-entry.md

import { INGESTION_PIPELINE_VERSION } from './canvas.ts'
import { geminiClassifyJson, geminiReadPdf } from './gemini.ts'

// deno-lint-ignore no-explicit-any
type AdminClient = any

export type ManualDocumentType = 'syllabus' | 'assignment' | 'reading_list' | 'schedule' | 'other'
export type ManualSourceType =
  | 'manual_syllabus'
  | 'manual_assignment'
  | 'manual_reading_list'
  | 'manual_document'
  | 'manual_website'

// Map document_type → normalized source_type per manual-course-entry.md §5.
export function sourceTypeForDocument(docType: ManualDocumentType): ManualSourceType {
  switch (docType) {
    case 'syllabus': return 'manual_syllabus'
    case 'assignment': return 'manual_assignment'
    case 'reading_list':
    case 'schedule': return 'manual_reading_list'
    default: return 'manual_document'
  }
}

// -----------------------------------------------------------------------------
// Text extraction — Gemini native PDF + plain-text
// -----------------------------------------------------------------------------

const EXTRACTION_PROMPT =
  'Extract the full readable text of this document exactly as written. Do not summarize. Do not comment. Reproduce section headings, tables (as tab-separated rows), lists (with their bullets), and dates in the same order they appear. If a page has no text, skip it silently.'

const CLASSIFY_SYSTEM_PROMPT =
  'You classify academic documents into one of five categories.'

export async function extractPdfText(base64Pdf: string): Promise<string> {
  const text = await geminiReadPdf({ base64Pdf, prompt: EXTRACTION_PROMPT, maxTokens: 8000 })
  return text ?? ''
}

export async function classifyDocumentType(text: string): Promise<ManualDocumentType> {
  const excerpt = text.slice(0, 1500)
  const parsed = await geminiClassifyJson<{ document_type: ManualDocumentType }>({
    system: CLASSIFY_SYSTEM_PROMPT,
    userText: `Classify this academic document.\n\nContent:\n${excerpt}`,
    schema: {
      type: 'object',
      properties: {
        document_type: {
          type: 'string',
          enum: ['syllabus', 'assignment', 'reading_list', 'schedule', 'other'],
        },
      },
      required: ['document_type'],
    },
    maxTokens: 40,
  })
  return parsed?.document_type ?? 'other'
}

// -----------------------------------------------------------------------------
// URL fetch + boilerplate strip (manual-course-entry.md §4.2)
// -----------------------------------------------------------------------------

// Compact readability-ish extractor: strip script/style/nav/header/footer/aside,
// then take the innerText of the largest remaining block. Static-only per V0.
export function stripHtmlBoilerplate(html: string): string {
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// -----------------------------------------------------------------------------
// normalized_events write helpers
// -----------------------------------------------------------------------------

export async function writeManualDocumentRecord(
  admin: AdminClient,
  args: {
    userId: string
    manualCourseId: string
    manualUploadId: string
    sourceType: ManualSourceType
    originalFilename: string
    mimeType: string
    fileSizeBytes: number
    documentType: ManualDocumentType
    normalizedText: string
  },
): Promise<string> {
  const externalId = `manual_upload_${args.manualUploadId}`
  const { data, error } = await admin
    .from('normalized_events')
    .upsert({
      user_id: args.userId,
      source_type: args.sourceType,
      external_id: externalId,
      timestamp: new Date().toISOString(),
      course_id: `manual_course_${args.manualCourseId}`,
      classification: 'academic',
      classification_source: 'heuristic',
      raw_payload: {
        original_filename: args.originalFilename,
        file_size_bytes: args.fileSizeBytes,
        mime_type: args.mimeType,
        document_type: args.documentType,
        entry_path: 'document_upload',
        manual_course_id: args.manualCourseId,
        manual_upload_id: args.manualUploadId,
      },
      normalized_text: args.normalizedText,
      cancelled_at: null,
      pipeline_version: INGESTION_PIPELINE_VERSION,
    }, { onConflict: 'user_id,source_type,external_id' })
    .select('id')
    .single()
  if (error) throw new Error(`manual document upsert failed: ${error.message}`)
  return data.id as string
}

export async function writeManualWebsiteRecord(
  admin: AdminClient,
  args: {
    userId: string
    manualCourseId: string
    url: string
    fetchedAt: string
    normalizedText: string
  },
): Promise<string> {
  const externalIdHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${args.url}|${args.fetchedAt}`),
  )
  const hex = Array.from(new Uint8Array(externalIdHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24)
  const externalId = `manual_url_${hex}`
  const { data, error } = await admin
    .from('normalized_events')
    .upsert({
      user_id: args.userId,
      source_type: 'manual_website',
      external_id: externalId,
      timestamp: args.fetchedAt,
      course_id: `manual_course_${args.manualCourseId}`,
      classification: 'academic',
      classification_source: 'heuristic',
      raw_payload: {
        url: args.url,
        fetch_method: 'static',
        fetched_at: args.fetchedAt,
        word_count: wordCount(args.normalizedText),
        entry_path: 'website_url',
        manual_course_id: args.manualCourseId,
      },
      normalized_text: args.normalizedText,
      cancelled_at: null,
      pipeline_version: INGESTION_PIPELINE_VERSION,
    }, { onConflict: 'user_id,source_type,external_id' })
    .select('id')
    .single()
  if (error) throw new Error(`manual website upsert failed: ${error.message}`)
  return data.id as string
}
