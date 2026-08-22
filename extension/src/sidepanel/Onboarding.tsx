/** Second-window state: read-only viewer (MVP §8). */
export function ViewerBanner({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300" role="status">
      Nox is open in another window. This one is read-only.
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="ml-2 underline">dismiss</button>
      )}
    </div>
  )
}
