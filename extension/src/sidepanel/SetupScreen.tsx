import { BridgeCard } from './BridgeCard'
import { ConnectionCard } from './ConnectionCard'
import { NoxMark } from './Icons'

export function SetupScreen() {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto p-5"
      aria-labelledby="setup-title"
      data-testid="setup-screen"
    >
      <div>
        <NoxMark className="mb-3 h-11 w-11 rounded-xl" />
        <h2 id="setup-title" className="text-xl font-bold tracking-tight">Welcome to Nox</h2>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
          Connect your workspace to start working with Notion.
        </p>
      </div>

      <div className="space-y-2">
        <BridgeCard />
        <ConnectionCard />
      </div>
    </section>
  )
}
