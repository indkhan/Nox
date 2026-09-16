import { normalizeId, parseNotionUrl, type CurrentPage } from './notion-page'

export interface CurrentPageChangedMessage {
  type: 'nox/current-page-changed'
  page: CurrentPage | null
}

export interface GetCurrentPageRequest {
  type: 'nox/get-current-page'
}

export interface GetCurrentPageResponse {
  page: CurrentPage | null
}

export interface GetRecentPagesRequest {
  type: 'nox/get-recent-pages'
}

export interface GetRecentPagesResponse {
  pages: CurrentPage[]
}

export interface PageMetaMessage {
  type: 'nox/page-meta'
  url: string
  title?: string
  iconEmoji?: string
  iconUrl?: string
}

export interface GetDnrStatusRequest {
  type: 'nox/get-dnr-status'
}

export interface ClearDnrRequest {
  type: 'nox/clear-dnr'
}

export type NoxMessage = CurrentPageChangedMessage

export type NoxRequest = GetCurrentPageRequest | GetRecentPagesRequest | GetDnrStatusRequest | ClearDnrRequest

export type NoxResponse = GetCurrentPageResponse | GetRecentPagesResponse

/** Bounded field limits for extension messages (Epoch 13 / L3). */
export const MAX_TITLE_CHARS = 500
export const MAX_ICON_EMOJI_CHARS = 50
export const MAX_ICON_URL_CHARS = 2048
export const MAX_PAGE_URL_CHARS = 2048

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Validates a CurrentPage payload: UUID shape, Notion URL format, page-id/URL
 * agreement, and bounded title/icon sizes. Null means "no current page".
 * Title/icon remain untrusted display labels — never write targets (L3).
 */
export function isValidCurrentPage(page: unknown): page is CurrentPage | null {
  if (page === null) return true
  if (typeof page !== 'object' || page === null) return false
  const p = page as Record<string, unknown>
  if (typeof p.pageId !== 'string' || !UUID_RE.test(p.pageId.toLowerCase())) return false
  // normalizeId accepts dashed/undashed/upper; the payload must carry a real id.
  if (normalizeId(p.pageId) === null) return false
  if (typeof p.url !== 'string' || p.url.length > MAX_PAGE_URL_CHARS) return false
  const parsed = parseNotionUrl(p.url)
  if (!parsed) return false
  if (parsed.pageId !== p.pageId.toLowerCase()) return false
  if (p.title !== undefined && !isBoundedString(p.title, MAX_TITLE_CHARS)) return false
  if (p.iconEmoji !== undefined && !isBoundedString(p.iconEmoji, MAX_ICON_EMOJI_CHARS)) return false
  if (p.iconUrl !== undefined) {
    if (!isBoundedString(p.iconUrl, MAX_ICON_URL_CHARS)) return false
    try {
      // Must be a parseable URL; panel never auto-loads it as a resource
      // (Epoch 01), but malformed values are still rejected here.
      void new URL(p.iconUrl)
    } catch {
      return false
    }
  }
  if (p.viewId !== undefined) {
    if (typeof p.viewId !== 'string' || normalizeId(p.viewId) === null) return false
  }
  return true
}

/** Validates a content-script page-meta payload (untrusted labels + URL). */
export function isValidPageMetaPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const p = payload as Record<string, unknown>
  if (typeof p.url !== 'string' || p.url.length > MAX_PAGE_URL_CHARS) return false
  if (!parseNotionUrl(p.url)) return false
  if (p.title !== undefined && !isBoundedString(p.title, MAX_TITLE_CHARS)) return false
  if (p.iconEmoji !== undefined && !isBoundedString(p.iconEmoji, MAX_ICON_EMOJI_CHARS)) return false
  if (p.iconUrl !== undefined) {
    if (!isBoundedString(p.iconUrl, MAX_ICON_URL_CHARS)) return false
    try {
      void new URL(p.iconUrl)
    } catch {
      return false
    }
  }
  return true
}

export function isCurrentPageChangedMessage(value: unknown): value is CurrentPageChangedMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.type !== 'nox/current-page-changed') return false
  if (!('page' in v)) return false
  return isValidCurrentPage(v.page)
}

export function isPageMetaMessage(value: unknown): value is PageMetaMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.type !== 'nox/page-meta') return false
  return isValidPageMetaPayload(v)
}

const KNOWN_REQUEST_TYPES = new Set([
  'nox/get-current-page',
  'nox/get-recent-pages',
  'nox/get-dnr-status',
  'nox/clear-dnr',
])

/**
 * Exact discriminant + bounded field validation (Epoch 13 / L3). Only known
 * extension message types pass; any `nox/`-prefixed unknown type is rejected
 * (no prefix wildcard). Payload-carrying types additionally validate UUID,
 * URL format, and title/icon sizes.
 */
export function isNoxMessage(value: unknown): value is NoxMessage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.type !== 'string') return false
  switch (v.type) {
    case 'nox/current-page-changed':
      return isValidCurrentPage(v.page)
    case 'nox/page-meta':
      return isValidPageMetaPayload(v)
    case 'nox/get-current-page':
    case 'nox/get-recent-pages':
    case 'nox/get-dnr-status':
    case 'nox/clear-dnr':
      return KNOWN_REQUEST_TYPES.has(v.type)
    default:
      return false
  }
}

interface MessageSenderLike {
  id?: string
  tab?: { id?: number; url?: string }
  frameId?: number
}

/**
 * Content-script sender check (background boundary): must come from the
 * owning extension's tab context with a finite tab id. Webpages and foreign
 * extensions never satisfy this.
 */
export function isExpectedContentSender(sender: MessageSenderLike | undefined, extensionId: string): boolean {
  if (!sender || sender.id !== extensionId) return false
  const tabId = sender.tab?.id
  if (typeof tabId !== 'number' || !Number.isFinite(tabId) || !Number.isInteger(tabId)) return false
  return true
}

/**
 * Background sender check (panel boundary): must come from the owning
 * extension context without a tab (content scripts always carry one).
 */
export function isExpectedBackgroundSender(sender: MessageSenderLike | undefined, extensionId: string): boolean {
  if (!sender || sender.id !== extensionId) return false
  if (sender.tab !== undefined) return false
  return true
}
