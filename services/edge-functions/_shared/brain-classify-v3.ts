// brain-classify-v3 — closed-vocabulary concept classification for the doc-level
// extraction pass. Replaces the generative-first flow of brain-extraction-v2.
//
// For each record:
//   1. Fetch top-N candidate Concept nodes by cosine to the record's body
//      embedding (already computed).
//   2. One Gemini call: given the record's text + candidate list, decide which
//      candidates apply AND propose any NEW concepts the record introduces.
//   3. Caller wires COVERS edges + creates new-proposal concepts.
//
// Design goals:
//   - Consistent naming across records (candidates seed the vocabulary)
//   - Generic filtering built into the prompt
//   - Explicit primary-concept designation for weight_primary in COVERS

import { geminiClassifyJson, type GeminiJsonSchema } from './gemini.ts'
import { SOURCE_AUTHORITY } from './brain-extraction-v2.ts'

export interface CandidateConcept {
  id: string
  name: string
}

export interface ClassificationInput {
  record_text: string
  source_type: string
  candidates: CandidateConcept[]
}

export interface MatchedConcept {
  concept_id: string
  is_primary: boolean
  confidence: number   // 0-1
}

export interface NewConceptProposal {
  name: string
  is_primary: boolean
}

export interface ClassificationOutput {
  matched: MatchedConcept[]
  new_concepts: NewConceptProposal[]
}

const CLASSIFY_SCHEMA: GeminiJsonSchema = {
  type: 'object',
  properties: {
    matched: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          concept_id: { type: 'string' },
          is_primary: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['concept_id', 'is_primary', 'confidence'],
      },
    },
    new_concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          is_primary: { type: 'boolean' },
        },
        required: ['name', 'is_primary'],
      },
    },
  },
  required: ['matched', 'new_concepts'],
}

// Per-source-type framing so the classifier knows how much a doc weighs in.
function sourceFramingFor(sourceType: string): string {
  const authority = SOURCE_AUTHORITY[sourceType] ?? 0.6
  const map: Record<string, string> = {
    canvas_syllabus:           `This is a course SYLLABUS. Extract the substantive academic topics it covers. Include topics from any "Topics Covered" list AND from prerequisites and assessment areas.`,
    manual_syllabus:           `This is a course SYLLABUS. Extract the substantive academic topics it covers.`,
    canvas_file_syllabus:      `This is a course SYLLABUS file. Extract substantive academic topics.`,
    canvas_home:               `This is a course HOME PAGE. Extract the substantive academic topics the professor uses to frame the class.`,
    canvas_lecture:            `This is a LECTURE record. Often the concept is derivable from the title alone. Extract the single most-central concept (mark it primary).`,
    canvas_file_project:       `This is a PROJECT spec document. Extract concepts the project applies or requires.`,
    canvas_file_rubric:        `This is a RUBRIC. Extract the specific grading criteria as concepts.`,
    canvas_assignment_rubric:  `This is a RUBRIC attached to an assignment. Extract the specific grading criteria concepts.`,
    canvas_file_study:         `This is study material. Extract the academic concepts it covers.`,
    canvas_assignment:         `This is an ASSIGNMENT. Extract the specific academic concepts this assignment tests.`,
    manual_assignment:         `This is an ASSIGNMENT. Extract the specific academic concepts this assignment tests.`,
    canvas_course:             `This is a course record. Extract the subject-area concepts the course belongs to.`,
    manual_course:             `This is a course record. Extract the subject-area concepts.`,
    canvas_announcement:       `This is an ANNOUNCEMENT. Extract concepts ONLY IF the announcement is about academic content. Skip if purely administrative ("office hours moved").`,
    canvas_page:               `This is a course WIKI PAGE. Extract the substantive academic topics it explains.`,
    google_calendar:           `This is a CALENDAR EVENT. Extract concepts only if the event title is clearly academic.`,
  }
  return `${map[sourceType] ?? `This is a course material record.`} (source authority weight: ${authority.toFixed(2)})`
}

const CLASSIFY_SYSTEM_PROMPT = `You are classifying a student's course material against a KNOWN CONCEPT LIST.

Your job:
1. Decide which existing concepts (from CANDIDATES) the record COVERS. Return one entry per matching candidate in "matched", with:
   - concept_id: the candidate's id
   - is_primary: true for the single most-central concept, false otherwise. Exactly one match should be primary; if nothing fits primary, choose the strongest match as primary.
   - confidence: 0.0-1.0 estimate of how strongly the record is about that concept
   Only include candidates with confidence >= 0.6. If nothing matches at that bar, matched=[] is fine.

2. Propose NEW concepts the record introduces that are NOT in the candidate list. Return them in "new_concepts". Rules for new proposals:
   - Short (1-4 word) noun phrases in lowercase, singular where natural
   - Specific academic concepts a professor would name in class (e.g. "gradient descent", "freudian defense mechanism", "cognitive load theory", "shakespeare tragedy")
   - NEVER propose these generic categories:
     "class participation", "grading", "syllabus", "assignments", "homework", "lecture",
     "quiz", "exam", "midterm", "final exam", "office hours", "attendance",
     "learning objectives", "reading", "textbook", "discussion", "requirements",
     "prerequisites", "course description", "grading policy", "late policy",
     "academic integrity", "instructor", "teaching assistant", "welcome"
   - Aim for 2-6 new concepts if the record is a syllabus / home page / project spec
   - Aim for 1-3 new concepts if the record is a lecture item / assignment description
   - Aim for 0-1 new concepts if the record is a short assignment or announcement
   - Return [] if nothing genuinely new emerges

3. If a candidate concept clearly matches the record's primary topic, prefer marking it primary over creating a new one.

Return JSON matching the schema.`

export async function classifyRecord(input: ClassificationInput): Promise<ClassificationOutput | null> {
  const candidateList = input.candidates.length > 0
    ? input.candidates.map(c => `- ${c.id}: "${c.name}"`).join('\n')
    : '(none — the concept pool is empty for this student)'

  const userText = `${sourceFramingFor(input.source_type)}

CANDIDATES:
${candidateList}

RECORD TEXT:
${input.record_text.slice(0, 12000)}`

  const parsed = await geminiClassifyJson<ClassificationOutput>({
    system: CLASSIFY_SYSTEM_PROMPT,
    userText,
    schema: CLASSIFY_SCHEMA,
    maxTokens: 1200,
  })
  if (!parsed) return null
  return {
    matched: Array.isArray(parsed.matched) ? parsed.matched : [],
    new_concepts: Array.isArray(parsed.new_concepts) ? parsed.new_concepts : [],
  }
}
