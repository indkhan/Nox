import { useEffect } from 'react'
import { hydrateCurrentPage, useNoxStore } from './store'
import { ConnectionCard } from './ConnectionCard'

export function App() {
  const currentPage = useNoxStore((s) => s.currentPage)

  useEffect(() => {
    void hydrateCurrentPage()
  }, [])

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">Nox</h1>
      </header>
      <main className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        <ConnectionCard />
        {currentPage ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              Current page
            </p>
            <p className="truncate text-sm font-medium">
              {currentPage.title ?? 'Untitled'}
            </p>
            <p className="mt-1 font-mono text-xs text-emerald-400" data-testid="page-id">
              {currentPage.pageId}
            </p>
            {currentPage.viewId && (
              <p className="mt-1 font-mono text-xs text-zinc-500">
                view: {currentPage.viewId}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">
            Open a Notion page to get started.
          </p>
        )}
      </main>
    </div>
  )
}
