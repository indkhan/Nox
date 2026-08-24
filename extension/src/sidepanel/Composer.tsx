import { useCallback, useEffect, useRef, useState } from 'react'
import { useNoxStore } from './store'
import { codex } from '../lib/codex/panel'
import type { ModelInfo } from '../lib/codex/client'
import { loadSettings, saveSettings, type NoxSettings } from '../lib/settings'
import { agentLoop } from '../lib/agent/panel'
import { notion } from '../lib/notion/panel'
import { parseNotionUrl, type MentionRef } from '../shared/notion-page'
import type { LocalAttachment } from '../shared/attachments'
import { attachmentRepository } from '../lib/history/attachments'
import { openNoxDB } from '../lib/history/schema'
import {
  ArrowUpIcon,
  ChevronDownIcon,
  PageIcon,
  PlusCircleIcon,
  SignalBarsIcon,
  StopIcon,
} from './Icons'

export type Mode = 'ask' | 'auto'

interface PickerItem {
  pageId: string
  title?: string
  iconEmoji?: string
  iconUrl?: string
}

/** Text of the editor with mention pills flattened to `@Title`. */
function editorText(el: HTMLElement): string {
  let out = ''
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? ''
    else if (node instanceof HTMLBRElement) out += '\n'
    else if (node instanceof HTMLElement && node.classList.contains('composer-mention')) {
      out += `@${node.querySelector('.mention-label')?.textContent ?? 'page'} `
    } else if (node instanceof HTMLElement) out += node.textContent ?? ''
  })
  return out
}

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return -1
  const range = sel.getRangeAt(0)
  if (!el.contains(range.endContainer)) return -1
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.endContainer, range.endOffset)
  return pre.toString().length
}

function setCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** DOM range covering character offsets [start, end) of the editor's flattened text. */
function rangeForOffsets(el: HTMLElement, start: number, end: number): Range | null {
  const range = document.createRange()
  let walked = 0
  let startNode: Node | null = null
  let startOffset = 0
  let endNode: Node | null = null
  let endOffset = 0
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0
      if (!startNode && walked + len >= start) {
        startNode = node
        startOffset = start - walked
      }
      if (!endNode && walked + len >= end) {
        endNode = node
        endOffset = end - walked
        return true
      }
      walked += len
    } else if (node instanceof HTMLBRElement) {
      walked += 1
    }
    return false
  }
  el.childNodes.forEach((child) => {
    if (!endNode) visit(child)
  })
  if (!startNode || !endNode) return null
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

function PageChipContent({ item }: { item: PickerItem }) {
  if (item.iconEmoji) return <span className="leading-none">{item.iconEmoji}</span>
  if (item.iconUrl) return <img src={item.iconUrl} alt="" className="h-3 w-3 shrink-0 rounded-[2px] object-cover" />
  return <PageIcon className="h-3 w-3 shrink-0 opacity-70" />
}

export function Composer({
  busy,
  readOnly = false,
  onSend,
  onCancel,
}: {
  busy: boolean
  readOnly?: boolean
  onSend: (text: string, mentions: MentionRef[], attachments: LocalAttachment[]) => void
  onCancel: () => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [mentions, setMentions] = useState<PickerItem[]>([])
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mentionCache = useRef(new Map<string, PickerItem>())
  const [picker, setPicker] = useState<{
    open: boolean
    query: string
    items: PickerItem[]
    active: number
    tokenStart: number
    caretEnd: number
  }>({ open: false, query: '', items: [], active: 0, tokenStart: -1, caretEnd: -1 })
  const currentPage = useNoxStore((s) => s.currentPage)
  const mode = useNoxStore((s) => s.mode)
  const setMode = useNoxStore((s) => s.setMode)

  // Mirror of `picker` for imperative code paths (chip insertion).
  const pickerRef = useRef(picker)
  pickerRef.current = picker

  // Autosize to content up to a max height.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [value])

  const refreshPickerItems = useCallback(async (query: string): Promise<PickerItem[]> => {
    const trimmed = query.trim()
    const matchesCache = (item: PickerItem) => !trimmed || (item.title ?? '').toLocaleLowerCase().includes(trimmed.toLocaleLowerCase())
    const cachedMatches = [...mentionCache.current.values()].filter(matchesCache)
    const recent = !trimmed
      ? chrome.runtime.sendMessage({ type: 'nox/get-recent-pages' })
          .then((response) => (response as { pages?: PickerItem[] })?.pages ?? [])
          .catch(() => [] as PickerItem[])
      : Promise.resolve([] as PickerItem[])
    const remote = trimmed && cachedMatches.length === 0
      ? notion.scheduleCallTool('notion-search', { query: trimmed })
      .then((result) => {
        const text = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
        const found = new Map<string, PickerItem>()
        try {
          const parsed = JSON.parse(text) as { results?: Array<{ title?: string; url?: string }> }
          for (const row of parsed.results ?? []) {
            if (typeof row.url !== 'string') continue
            const page = parseNotionUrl(row.url)
            if (page) found.set(page.pageId, { pageId: page.pageId, title: row.title ?? page.title })
          }
        } catch {
          // Older MCP responses used Markdown links; keep accepting them.
        }
        const linkRe = /\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g
        for (const [, label, url] of text.matchAll(linkRe)) {
          const parsed = parseNotionUrl(url)
          if (parsed && !found.has(parsed.pageId)) found.set(parsed.pageId, { pageId: parsed.pageId, title: label || parsed.title })
        }
        return [...found.values()]
      })
      .catch(() => [] as PickerItem[])
      : Promise.resolve([] as PickerItem[])
    const [remoteItems, recentItems] = await Promise.all([remote, recent])
    for (const item of [...remoteItems, ...recentItems]) mentionCache.current.set(item.pageId, item)
    const found = new Map<string, PickerItem>()
    for (const item of [...remoteItems, ...mentionCache.current.values()].filter(matchesCache)) found.set(item.pageId, item)
    return [...found.values()].slice(0, 8)
  }, [])

  /** Reads the caret, finds an active @token, and syncs the picker. */
  const syncPicker = useCallback(() => {
    const el = editorRef.current
    if (!el || readOnly) return
    const caret = caretOffset(el)
    if (caret < 0) {
      setPicker((p) => (p.open ? { ...p, open: false } : p))
      return
    }
    const before = editorText(el).slice(0, caret)
    const match = /@([^\s@]{0,100})$/.exec(before)
    if (!match) {
      setPicker((p) => (p.open ? { ...p, open: false } : p))
      return
    }
    const query = match[1]
    const tokenStart = caret - match[0].length
    setPicker((p) =>
      p.open && p.tokenStart === tokenStart && p.query === query
        ? p
        : { open: true, query, items: [], active: 0, tokenStart, caretEnd: caret },
    )
    void refreshPickerItems(query).then((items) =>
      setPicker((p) => (p.open && p.query === query ? { ...p, items, active: 0 } : p)),
    )
  }, [readOnly, refreshPickerItems])

  const insertChip = useCallback((item: PickerItem): void => {
    const el = editorRef.current
    if (!el) return
    const p = pickerRef.current

    // Replace the @token (if the picker was open) with the pill.
    if (p.open && p.tokenStart >= 0 && p.caretEnd >= 0) {
      const caret = caretOffset(el)
      const end = caret < 0 ? p.caretEnd : Math.max(p.tokenStart, Math.min(p.caretEnd, caret))
      rangeForOffsets(el, p.tokenStart, end)?.deleteContents()
    }
    const chip = document.createElement('span')
    chip.className = 'composer-mention'
    chip.contentEditable = 'false'
    chip.dataset.mentionId = item.pageId

    const label = document.createElement('span')
    label.className = 'mention-label'
    label.textContent = item.title ?? item.pageId.slice(0, 8)
    const icon = document.createElement('span')
    if (item.iconEmoji) {
      icon.textContent = item.iconEmoji
    } else {
      icon.textContent = '📄'
      icon.className = 'opacity-70'
    }
    chip.append(icon)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Remove ${label.textContent} from context`)
    remove.className = 'ml-0.5 cursor-pointer opacity-60 hover:opacity-100'
    remove.addEventListener('click', () => {
      chip.remove()
      setMentions((list) => list.filter((m) => m.pageId !== item.pageId))
      setValue(editorText(el))
    })
    chip.append(remove)
    chip.append(label)

    // Insert at the caret when possible, otherwise append.
    const sel = window.getSelection()
    let inserted = false
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
      try {
        const r = sel.getRangeAt(0)
        r.collapse(true)
        r.insertNode(chip)
        inserted = true
      } catch {
        inserted = false
      }
    }
    if (!inserted) el.appendChild(chip)
    chip.after(document.createTextNode('\u00a0'))
    setMentions((list) => (list.some((m) => m.pageId === item.pageId) ? list : [...list, item]))
    setValue(editorText(el))
    setPicker({ open: false, query: '', items: [], active: 0, tokenStart: -1, caretEnd: -1 })
    setCaretAtEnd(el)
  }, [])

  function submit() {
    const el = editorRef.current
    if (!el || busy || readOnly) return
    const text = editorText(el).trim()
    if (!text && attachments.length === 0) return
    onSend(text || 'Attach these files to the appropriate Notion page.', mentions.map(({ pageId, title, iconEmoji, iconUrl }) => ({ pageId, title, iconEmoji, iconUrl })), attachments)
    el.innerHTML = ''
    setMentions([])
    setAttachments([])
    setValue('')
  }

  return (
    <div className="p-2.5" data-testid="composer-root">
      <div className="relative rounded-2xl border border-zinc-700 bg-zinc-900 px-3 pb-2 pt-2.5 transition-colors focus-within:border-sky-500">
        {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-1">{attachments.map((attachment) => <span key={attachment.id} className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300">{attachment.name}<button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((all) => all.filter((item) => item.id !== attachment.id))} className="ml-1 text-zinc-500">×</button></span>)}</div>}
        {picker.open && (
          <div
            data-testid="mention-picker"
            role="listbox"
            aria-label="Mention a page or database"
            className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl"
          >
            {picker.items.length === 0 && (
              <p className="px-3 py-2 text-xs text-zinc-500">
                {picker.query ? 'No matching pages or databases' : 'No pages or databases found'}
              </p>
            )}
            {picker.items.map((item, index) => (
              <button
                key={item.pageId}
                role="option"
                aria-selected={index === picker.active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertChip(item)
                }}
                onMouseEnter={() => setPicker((p) => ({ ...p, active: index }))}
                data-testid={`mention-option-${index}`}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${
                  index === picker.active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <PageChipContent item={item} />
                </span>
                <span className="truncate">{item.title ?? item.pageId.slice(0, 8)}</span>
              </button>
            ))}
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable={!readOnly}
          role="textbox"
          aria-multiline="true"
          aria-label="Message Nox"
          data-testid="composer"
          data-placeholder="Do anything with AI..."
          className="min-h-[1.75rem] w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-0.5 text-sm leading-relaxed outline-none"
          onInput={() => {
            const el = editorRef.current
            if (el && editorText(el) === '') el.innerHTML = ''
            setValue(el ? editorText(el) : '')
            syncPicker()
          }}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) syncPicker()
          }}
          onClick={syncPicker}
          onKeyDown={(e) => {
            if (picker.open && picker.items.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setPicker((p) => ({ ...p, active: (p.active + 1) % p.items.length }))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setPicker((p) => ({ ...p, active: (p.active - 1 + p.items.length) % p.items.length }))
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                insertChip(picker.items[picker.active])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setPicker((p) => ({ ...p, open: false }))
                return
              }
            }
            if (e.key === 'Escape' && busy) {
              e.preventDefault()
              onCancel()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="mt-1 flex items-center gap-0.5">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { const files = [...(event.target.files ?? [])].slice(0, 10); void Promise.all(files.filter((file) => file.size <= 20 * 1024 * 1024).map((file) => attachmentRepository(openNoxDB).save(file))).then((added) => setAttachments((all) => [...all, ...added])); event.target.value = '' }} />
          <button
            onClick={() => currentPage && insertChip(currentPage)}
            disabled={readOnly || !currentPage || mentions.some((m) => m.pageId === currentPage.pageId)}
            aria-label="Add current page"
            title="Add current page"
            data-testid="add-current-page"
            className="cursor-pointer rounded-md px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusCircleIcon />
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={readOnly || busy} aria-label="Attach file" title="Attach file" className="rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40">File</button>
          <ModelControls disabled={readOnly} />
          <span className="flex-1" />
          {busy && (
            <span aria-hidden="true" className="mr-1 text-zinc-500">
              <SignalBarsIcon />
            </span>
          )}
          <select
            disabled={readOnly}
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            aria-label="Change mode"
            data-testid="mode-selector"
            className="cursor-pointer appearance-none rounded-md px-1 py-0.5 text-xs text-zinc-300 outline-none hover:bg-zinc-800"
          >
            <option value="ask">Ask before changes</option>
            <option value="auto">Auto</option>
          </select>
          {busy ? (
            <button
              onClick={onCancel}
              aria-label="Stop"
              data-testid="stop"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
            >
              <StopIcon className="h-2.5 w-2.5" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={readOnly || (!value.trim() && attachments.length === 0)}
              aria-label="Send"
              data-testid="send"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-200 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ModelControls({ disabled }: { disabled: boolean }) {
  const codexStatus = useNoxStore((s) => s.codexStatus)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settings, setSettings] = useState<NoxSettings>({})

  useEffect(() => {
    void loadSettings().then(setSettings)
  }, [])

  useEffect(() => {
    if (codexStatus !== 'connected') return
    void codex.listModels().then(setModels).catch(() => setModels([]))
  }, [codexStatus])

  function apply(next: NoxSettings) {
    setSettings(next)
    agentLoop.setOverrides({ model: next.model, effort: next.effort })
    void saveSettings(next)
  }

  const selected = models.find((model) => model.id === settings.model) ?? models.find((model) => model.isDefault) ?? models[0]
  const efforts = selected?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh']
  const selectClass = 'max-w-28 cursor-pointer appearance-none bg-transparent py-1 pl-1 pr-3 text-[11px] text-zinc-400 outline-none hover:text-zinc-200'

  if (codexStatus !== 'connected') {
    return <span className="px-1 text-[11px] text-zinc-500" data-testid="chat-model-controls">Codex not connected</span>
  }

  return (
    <div className="flex min-w-0 items-center text-zinc-500" data-testid="chat-model-controls">
      <label className="relative flex min-w-0 items-center" title="Model">
        <span className="sr-only">Model</span>
        <select
          value={selected?.id ?? ''}
          onChange={(event) => apply({ ...settings, model: event.target.value })}
          disabled={disabled || models.length === 0}
          aria-label="Model"
          data-testid="model-select"
          className={selectClass}
        >
          {models.length === 0 && <option value="">Codex</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-0 h-2.5 w-2.5" />
      </label>
      <span aria-hidden="true" className="mx-1 h-px w-px bg-zinc-700" />
      <label className="relative flex items-center" title="Reasoning effort">
        <span className="sr-only">Reasoning effort</span>
        <select
          disabled={disabled}
          value={settings.effort ?? 'low'}
          onChange={(event) => apply({ ...settings, effort: event.target.value })}
          aria-label="Reasoning effort"
          data-testid="effort-select"
          className={selectClass}
        >
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-0 h-2.5 w-2.5" />
      </label>
    </div>
  )
}
