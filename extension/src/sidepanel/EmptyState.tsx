import type { ReactNode } from 'react'
import { useNoxStore } from './store'
import { NoxMark, PageIcon, PencilIcon, SearchIcon, SparkleIcon } from './Icons'

interface SuggestionDef {
  testid: string
  message: string
  icon: ReactNode
  body: ReactNode
}

const EASE = 'cubic-bezier(0.23,1,0.32,1)'

export function EmptyState({ onSend }: { onSend?: (text: string) => void }) {
  const { identity, currentPage } = useNoxStore((s) => s)
  const hour = new Date().getHours()
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = identity?.userName?.split(' ')[0]
  const pageTitle = currentPage?.title ?? 'this page'

  const suggestions: SuggestionDef[] = [
    {
      testid: 'suggest-outline',
      message: `Draft an outline for ${pageTitle}`,
      icon: <PencilIcon className="h-4 w-4 shrink-0" />,
      body: (
        <>
          <span>Draft an outline for</span>
          <PageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-semibold">{pageTitle}</span>
        </>
      ),
    },
    {
      testid: 'suggest-think',
      message: 'Help me think through this page',
      icon: <SparkleIcon className="h-4 w-4 shrink-0" />,
      body: <span>Help me think through this page</span>,
    },
    {
      testid: 'suggest-related',
      message: 'Find related work',
      icon: <SearchIcon className="h-4 w-4 shrink-0" />,
      body: <span>Find related work</span>,
    },
  ]

  return (
    <div
      className="flex min-h-0 flex-1 flex-col justify-center px-4 pb-4 pt-2"
      data-testid="empty-state"
    >
      <div
        className="flex h-11 w-11 items-center justify-center rounded-full bg-field text-ink shadow-hairline"
        style={{ animation: `pop-in 400ms ${EASE} both` }}
      >
        <NoxMark className="h-6 w-6" />
      </div>
      <p
        className="mt-3 text-lg font-bold tracking-tight"
        data-testid="greeting"
        style={{ animation: `fade-up 350ms ${EASE} 80ms both` }}
      >
        Good {timeOfDay}
        {name ? `, ${name}` : ''}
      </p>
      <p
        className="mb-4 text-[13px] text-ink-3"
        style={{ animation: `fade-up 350ms ${EASE} 160ms both` }}
      >
        Here&rsquo;s what others ask me first
      </p>

      <div className="space-y-1.5">
        {suggestions.map((s, i) => (
          <button
            key={s.testid}
            onClick={() => {
              const el = document.querySelector<HTMLTextAreaElement>('[data-testid=composer]')
              if (onSend && !el?.value.trim()) onSend(s.message)
              else el?.focus()
            }}
            data-testid={s.testid}
            className="flex w-full items-center gap-2.5 rounded-card bg-surface px-3.5 py-2.5 text-left text-[13px] font-medium text-ink shadow-hairline transition-[background-color,border-color] duration-150 hover:bg-hover"
            style={{ animation: `fade-up 350ms ${EASE} ${240 + i * 90}ms both` }}
          >
            <span className="text-ink-3">{s.icon}</span>
            <span className="flex min-w-0 items-center gap-1.5">{s.body}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
