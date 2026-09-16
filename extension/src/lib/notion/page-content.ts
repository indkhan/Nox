import { normalizeId } from '../../shared/notion-page'

/**
 * Structured page-fetch normalization (Epoch 07 / M3).
 *
 * A concatenated text envelope is never treated as page Markdown on its own:
 * JSON provider payloads are parsed for an explicit content field plus
 * completeness metadata (`truncated`, `unknown_block_ids`), while plain-text
 * payloads are accepted as complete only when non-empty and free of explicit
 * partial markers. Anything else is refused as a destructive-replacement
 * baseline — a partial read may still support analysis, but never a
 * whole-page replacement or a whole-page inverse.
 *
 * Shapes are redacted synthetic fixtures under `tests/fixtures/notion/`;
 * field names follow the documented Notion MCP surface (`truncated`,
 * `unknown_block_ids`). Unknown future fields do not grant completeness.
 */

export type PageFetchStatus = 'complete' | 'partial' | 'unavailable'

export interface NormalizedPageFetch {
  /** Normalized page target this record describes. */
  pageId: string
  status: PageFetchStatus
  /** Normalized page content. Present for complete and partial reads. */
  markdown: string
  /** Provider truncation flag, preserved as structural metadata. */
  truncated: boolean
  /** Omitted subtree ids the model must fetch before a replacement. */
  unknownBlockIds: string[]
  /** Which envelope the content was extracted from. */
  shape: 'json-content' | 'plain-text'
}

export type BaselineRefusalCode =
  | 'FETCH_FAILED'
  | 'WRAPPER_MISMATCH'
  | 'PARTIAL_BASELINE'
  | 'UNAVAILABLE_BASELINE'

/** Refusal for a fetch that must not become an edit baseline. Never dispatched. */
export class BaselineError extends Error {
  readonly code: BaselineRefusalCode
  constructor(code: BaselineRefusalCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'BaselineError'
    this.code = code
  }
}

/** Minimal provider result surface; mirrors `McpCallResult` without the import. */
export interface PageFetchResult {
  isError?: unknown
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
}

/** Local truncation marker applied by Nox before content reaches the model. */
const LOCAL_PARTIAL_MARKERS = ['…[truncated by Nox]', '<continuation', 'unknown_block_ids', 'unknown-block-ids']

const CONTENT_KEYS = ['content', 'markdown', 'text', 'body'] as const

/**
 * Normalize one `notion-fetch` result into a structured retrieval record.
 * Throws `BaselineError` for tool-declared failures, unrecognized wrappers,
 * and unavailable pages. Partial reads return normally with
 * `status: 'partial'` so callers can use them for analysis while refusing
 * them as replacement baselines via `requireCompleteBaseline`.
 */
export function normalizePageFetch(pageId: string, result: PageFetchResult): NormalizedPageFetch {
  const normalized = normalizeId(pageId) ?? pageId
  if (result?.isError === true) {
    const detail = textParts(result).slice(0, 300) || 'the provider reported the read as failed'
    throw new BaselineError(
      'FETCH_FAILED',
      `the page read failed (${detail}) — fetch the page again and inspect the result before replacing its content. No changes were made.`,
    )
  }
  const structured = result?.structuredContent
  if (structured != null && typeof structured === 'object') {
    return normalizeJsonPayload(normalized, structured as Record<string, unknown>)
  }
  const text = textParts(result)
  const trimmed = text.trim()
  if (!trimmed) {
    throw new BaselineError(
      'UNAVAILABLE_BASELINE',
      'the page read returned no content — fetch the page again and inspect the result before replacing its content. No changes were made.',
    )
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown = undefined
    let parsable = false
    try {
      parsed = JSON.parse(trimmed)
      parsable = true
    } catch {
      // Not actually JSON: fall through to plain-text handling below.
    }
    // Provider refusals propagate; only a syntax failure falls through.
    if (parsable) return normalizeJsonPayload(normalized, parsed)
  }
  if (LOCAL_PARTIAL_MARKERS.some((marker) => trimmed.includes(marker))) {
    return { pageId: normalized, status: 'partial', markdown: text, truncated: true, unknownBlockIds: [], shape: 'plain-text' }
  }
  return { pageId: normalized, status: 'complete', markdown: text, truncated: false, unknownBlockIds: [], shape: 'plain-text' }
}

/** Normalize a concatenated fetch string (guard/read-hash path). Same rules, no envelope. */
export function normalizePageText(pageId: string, text: string): NormalizedPageFetch {
  return normalizePageFetch(pageId, { content: [{ type: 'text', text }] })
}

/**
 * Throw unless the record is a complete baseline. Partial reads keep their
 * content for analysis; they never authorize whole-page replacement.
 */
export function requireCompleteBaseline(record: NormalizedPageFetch): NormalizedPageFetch {
  if (record.status === 'partial') {
    const omitted = record.unknownBlockIds.length > 0 ? ` Fetch the ${record.unknownBlockIds.length} omitted block id(s) or a targeted subtree first` : ' Fetch a targeted subtree first'
    throw new BaselineError(
      'PARTIAL_BASELINE',
      `the available read of this page is incomplete (truncated content).${omitted} before replacing its content — a partial read cannot support whole-page replacement. No changes were made.`,
    )
  }
  if (record.status === 'unavailable') {
    throw new BaselineError(
      'UNAVAILABLE_BASELINE',
      'the available read of this page has no content — fetch the page again and inspect the result before replacing its content. No changes were made.',
    )
  }
  return record
}

function normalizeJsonPayload(pageId: string, payload: unknown): NormalizedPageFetch {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BaselineError(
      'WRAPPER_MISMATCH',
      'the fetch result was not recognizable page content — fetch the page again and inspect the result before replacing its content. No changes were made.',
    )
  }
  const record = payload as Record<string, unknown>
  // Identity (`notion-fetch self`) and search envelopes are valid reads for
  // their own tools, never page-content baselines.
  if ('self' in record || 'current_tool_access' in record) {
    throw new BaselineError(
      'WRAPPER_MISMATCH',
      'the fetch result carries workspace identity, not page content — fetch the page itself and inspect the result before replacing its content. No changes were made.',
    )
  }
  if (Array.isArray(record.results)) {
    throw new BaselineError(
      'WRAPPER_MISMATCH',
      'the fetch result carries a result list, not page content — fetch the page itself and inspect the result before replacing its content. No changes were made.',
    )
  }
  const nested = record.page != null && typeof record.page === 'object' && !Array.isArray(record.page)
    ? (record.page as Record<string, unknown>)
    : null
  let content: string | null = null
  for (const key of CONTENT_KEYS) {
    const direct = record[key]
    if (typeof direct === 'string' && direct.trim()) {
      content = direct
      break
    }
    const inner = nested?.[key]
    if (content == null && typeof inner === 'string' && inner.trim()) {
      content = inner
      break
    }
  }
  const unknownBlockIds = collectUnknownBlockIds(record, nested)
  const truncated =
    record.truncated === true ||
    record.has_more === true ||
    record.hasMore === true ||
    record.omitted === true ||
    unknownBlockIds.length > 0
  if (content == null) {
    const errorText =
      (typeof record.error === 'string' && record.error) ||
      (record.error != null ? JSON.stringify(record.error).slice(0, 200) : '') ||
      (typeof record.message === 'string' && record.message) ||
      ''
    if (errorText) {
      throw new BaselineError(
        'UNAVAILABLE_BASELINE',
        `the page read is unavailable (${errorText.slice(0, 200)}) — fetch the page again and inspect the result before replacing its content. No changes were made.`,
      )
    }
    throw new BaselineError(
      'WRAPPER_MISMATCH',
      'the fetch result was not recognizable page content — fetch the page again and inspect the result before replacing its content. No changes were made.',
    )
  }
  return {
    pageId,
    status: truncated ? 'partial' : 'complete',
    markdown: content,
    truncated,
    unknownBlockIds,
    shape: 'json-content',
  }
}

function collectUnknownBlockIds(record: Record<string, unknown>, nested: Record<string, unknown> | null): string[] {
  const raw =
    record.unknown_block_ids ?? record.unknownBlockIds ?? record.unknown_blocks ?? nested?.unknown_block_ids ?? nested?.unknownBlockIds
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 100)
}

function textParts(result: PageFetchResult): string {
  if (!Array.isArray(result?.content)) return ''
  return result
    .content!.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}
