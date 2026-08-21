import { useNoxStore } from './store'

export function EmptyState() {
  const { identity, currentPage } = useNoxStore((s) => s)
  const hour = new Date().getHours()
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = identity?.userName?.split(' ')[0]

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4" data-testid="empty-state">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-700/30 text-xl">⬡</div>
      <div className="text-center">
        <p className="text-sm font-medium">Good {timeOfDay}{name ? `, ${name}` : ''}</p>
        <p className="text-xs text-zinc-500">Here's what others ask me first</p>
      </div>
      <div className="w-full max-w-xs space-y-2">
        {currentPage && (
          <Suggestion text={`Draft an outline for ${currentPage.title ?? 'this page'}`} />
        )}
        <Suggestion text="Find my overdue tasks" />
        <Suggestion text="Summarize recent changes in this workspace" />
      </div>
    </div>
  )
}

function Suggestion({ text }: { text: string }) {
  return (
    <button
      onClick={() => document.querySelector<HTMLTextAreaElement>('[data-testid=composer]')?.focus()}
      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-600"
    >
      {text}
    </button>
  )
}
