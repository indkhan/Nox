import type { ReactNode } from 'react'
import { useNoxStore } from './store'
import { NoxMark, PageIcon, PencilIcon, SearchIcon, SparkleIcon } from './Icons'
import type { MentionRef } from '../shared/notion-page'

interface SuggestionDef {
  testid: string
  message: string
  icon: ReactNode
  body: ReactNode
  mention?: MentionRef
}

/** The real Notion page icon when known, falling back to a generic page glyph. */
function CurrentPageChip({ iconEmoji, iconUrl }: { iconEmoji?: string; iconUrl?: string }) {
  if (iconEmoji) return <span className="shrink-0 leading-none">{iconEmoji}</span>
  if (iconUrl) return <img src={iconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
  return <PageIcon className="h-3.5 w-3.5 shrink-0" />
}

export function EmptyState({
  onSend,
  readOnly = false,
}: {
  onSend?: (text: string, mentions: MentionRef[]) => void
  readOnly?: boolean
}) {
  const { identity, currentPage } = useNoxStore((s) => s)
  const hour = new Date().getHours()
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = identity?.userName?.split(' ')[0]
  const pageTitle = currentPage?.title ?? 'this page'
  const chip = <CurrentPageChip iconEmoji={currentPage?.iconEmoji} iconUrl={currentPage?.iconUrl} />
  const mention: MentionRef | undefined = currentPage
    ? { pageId: currentPage.pageId, title: currentPage.title, iconEmoji: currentPage.iconEmoji, iconUrl: currentPage.iconUrl }
    : undefined

  const suggestions: SuggestionDef[] = [
    {
      testid: 'suggest-outline',
      message: `Draft an outline for ${pageTitle}`,
      icon: <PencilIcon className="h-4 w-4 shrink-0" />,
      body: (
        <>
          <span>Draft an outline for</span>
          {chip}
          <span className="truncate font-semibold">{pageTitle}</span>
        </>
      ),
      mention,
    },
    {
      testid: 'suggest-think',
      message: `Help me think through ${pageTitle}`,
      icon: <SparkleIcon className="h-4 w-4 shrink-0" />,
      body: (
        <>
          <span>Help me think through</span>
          {chip}
          <span className="truncate font-semibold">{pageTitle}</span>
        </>
      ),
      mention,
    },
    {
      testid: 'suggest-related',
      message: 'Find related work',
      icon: <SearchIcon className="h-4 w-4 shrink-0" />,
      body: <span>Find related work</span>,
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-4 pb-4 pt-2" data-testid="empty-state">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
        <NoxMark className="h-6 w-6" />
      </div>
      <p className="mt-3 text-lg font-bold tracking-tight" data-testid="greeting">
        Good {timeOfDay}{name ? `, ${name}` : ''}
      </p>
      <p className="mb-4 text-sm text-zinc-500">Here&rsquo;s what others ask me first</p>

      <div className="space-y-1.5">
        {suggestions.map((s) => (
          <button
            key={s.testid}
            disabled={readOnly}
            onClick={() => {
              const el = document.querySelector<HTMLElement>('[data-testid=composer]')
              if (onSend && !el?.textContent?.trim()) onSend(s.message, s.mention ? [s.mention] : [])
              else el?.focus()
            }}
            data-testid={s.testid}
            className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-3.5 py-2.5 text-left text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {s.icon}
            <span className="flex min-w-0 items-center gap-1.5">{s.body}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
