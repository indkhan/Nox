import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  MAX_ICON_EMOJI_CHARS,
  MAX_ICON_URL_CHARS,
  MAX_TITLE_CHARS,
  isCurrentPageChangedMessage,
  isExpectedBackgroundSender,
  isExpectedContentSender,
  isNoxMessage,
  isPageMetaMessage,
  isValidCurrentPage,
} from '../src/shared/messages'
import { ensureTrustedStorageAccess } from '../src/lib/chrome-storage'

const PAGE_ID = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
const PAGE_URL = `https://www.notion.so/My-Page-${PAGE_ID.replaceAll('-', '')}`

function validPage(over: Record<string, unknown> = {}) {
  return { pageId: PAGE_ID, url: PAGE_URL, title: 'My Page', ...over }
}

describe('isNoxMessage (Epoch 13 / L3)', () => {
  it('accepts exact known discriminants', () => {
    expect(isNoxMessage({ type: 'nox/current-page-changed', page: null })).toBe(true)
    expect(isNoxMessage({ type: 'nox/current-page-changed', page: validPage() })).toBe(true)
    expect(isNoxMessage({ type: 'nox/get-current-page' })).toBe(true)
    expect(isNoxMessage({ type: 'nox/get-recent-pages' })).toBe(true)
    expect(isNoxMessage({ type: 'nox/page-meta', url: PAGE_URL })).toBe(true)
    expect(isNoxMessage({ type: 'nox/get-dnr-status' })).toBe(true)
    expect(isNoxMessage({ type: 'nox/clear-dnr' })).toBe(true)
  })

  it('rejects unknown nox/ discriminants (no prefix wildcard)', () => {
    expect(isNoxMessage({ type: 'nox/evil' })).toBe(false)
    expect(isNoxMessage({ type: 'nox/current-page-changed-evil' })).toBe(false)
    expect(isNoxMessage({ type: 'nox/' })).toBe(false)
    expect(isNoxMessage({ type: 'nox' })).toBe(false)
  })

  it('rejects non-objects and missing types', () => {
    expect(isNoxMessage(null)).toBe(false)
    expect(isNoxMessage(undefined)).toBe(false)
    expect(isNoxMessage('nox/current-page-changed')).toBe(false)
    expect(isNoxMessage({})).toBe(false)
    expect(isNoxMessage({ type: 123 })).toBe(false)
  })

  it('rejects forged current-page payloads', () => {
    expect(isNoxMessage({ type: 'nox/current-page-changed', page: { pageId: 'not-a-uuid', url: PAGE_URL } })).toBe(false)
    expect(isNoxMessage({ type: 'nox/current-page-changed', page: { pageId: PAGE_ID, url: 'https://evil.example.com/x' } })).toBe(false)
  })

  it('rejects oversized title/icon in messages', () => {
    expect(
      isNoxMessage({
        type: 'nox/current-page-changed',
        page: validPage({ title: 'x'.repeat(MAX_TITLE_CHARS + 1) }),
      }),
    ).toBe(false)
    expect(
      isNoxMessage({
        type: 'nox/page-meta',
        url: PAGE_URL,
        iconEmoji: 'x'.repeat(MAX_ICON_EMOJI_CHARS + 1),
      }),
    ).toBe(false)
    expect(
      isNoxMessage({
        type: 'nox/page-meta',
        url: PAGE_URL,
        iconUrl: `https://example.com/${'x'.repeat(MAX_ICON_URL_CHARS)}`,
      }),
    ).toBe(false)
  })
})

describe('isValidCurrentPage (Epoch 13 / L3)', () => {
  it('accepts null (no current page) and valid pages', () => {
    expect(isValidCurrentPage(null)).toBe(true)
    expect(isValidCurrentPage(validPage())).toBe(true)
  })

  it('rejects invalid UUIDs', () => {
    expect(isValidCurrentPage({ pageId: 'zzz', url: PAGE_URL })).toBe(false)
    expect(isValidCurrentPage({ pageId: 123, url: PAGE_URL })).toBe(false)
  })

  it('rejects non-Notion URLs and mismatched page ids', () => {
    expect(isValidCurrentPage({ pageId: PAGE_ID, url: 'https://evil.example.com/x' })).toBe(false)
    const otherId = '11112222-3333-4777-8999-aaaabbbbcccc'
    const otherUrl = `https://www.notion.so/Other-${otherId.replaceAll('-', '')}`
    expect(isValidCurrentPage({ pageId: PAGE_ID, url: otherUrl })).toBe(false)
  })

  it('rejects oversized fields', () => {
    expect(isValidCurrentPage(validPage({ title: 'x'.repeat(MAX_TITLE_CHARS + 1) }))).toBe(false)
  })
})

describe('isPageMetaMessage / isCurrentPageChangedMessage (Epoch 13 / L3)', () => {
  it('validates page-meta payloads', () => {
    expect(isPageMetaMessage({ type: 'nox/page-meta', url: PAGE_URL, title: 'T' })).toBe(true)
    expect(isPageMetaMessage({ type: 'nox/page-meta', url: 'not a url' })).toBe(false)
    expect(isPageMetaMessage({ type: 'nox/page-meta' })).toBe(false)
    expect(isPageMetaMessage({ type: 'nox/page-meta', url: PAGE_URL, title: 'x'.repeat(MAX_TITLE_CHARS + 1) })).toBe(false)
  })

  it('validates current-page-changed payloads', () => {
    expect(isCurrentPageChangedMessage({ type: 'nox/current-page-changed', page: null })).toBe(true)
    expect(isCurrentPageChangedMessage({ type: 'nox/current-page-changed', page: validPage() })).toBe(true)
    expect(isCurrentPageChangedMessage({ type: 'nox/current-page-changed' })).toBe(false)
    expect(isCurrentPageChangedMessage({ type: 'nox/current-page-changed', page: { pageId: 'bad' } })).toBe(false)
  })
})

describe('sender validation (Epoch 13 / L3)', () => {
  it('accepts content senders only from the owning extension tab context', () => {
    expect(isExpectedContentSender({ id: 'ext-1', tab: { id: 7, url: PAGE_URL } }, 'ext-1')).toBe(true)
    // Foreign extension id.
    expect(isExpectedContentSender({ id: 'evil-ext', tab: { id: 7, url: PAGE_URL } }, 'ext-1')).toBe(false)
    // Missing tab (not a content script).
    expect(isExpectedContentSender({ id: 'ext-1' }, 'ext-1')).toBe(false)
    // Non-finite tab id.
    expect(isExpectedContentSender({ id: 'ext-1', tab: { id: NaN, url: PAGE_URL } }, 'ext-1')).toBe(false)
  })

  it('accepts background senders only from the owning extension context', () => {
    expect(isExpectedBackgroundSender({ id: 'ext-1' }, 'ext-1')).toBe(true)
    expect(isExpectedBackgroundSender({ id: 'evil-ext' }, 'ext-1')).toBe(false)
    // Content-script contexts (with tab) are never the background.
    expect(isExpectedBackgroundSender({ id: 'ext-1', tab: { id: 7 } }, 'ext-1')).toBe(false)
  })
})

describe('ensureTrustedStorageAccess (Epoch 13 / L3)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('restricts local and session storage to trusted contexts', async () => {
    const localSet = vi.fn(async () => undefined)
    const sessionSet = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      storage: {
        local: { setAccessLevel: localSet },
        session: { setAccessLevel: sessionSet },
      },
    })
    await ensureTrustedStorageAccess()
    expect(localSet).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(sessionSet).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
  })

  it('throws a compatibility error instead of silently relaxing when the API is missing', async () => {
    vi.stubGlobal('chrome', { storage: { local: {}, session: {} } })
    await expect(ensureTrustedStorageAccess()).rejects.toThrow(/storage access/i)
  })
})
