/** Second-window state: read-only viewer (MVP §8). */
export function ViewerBanner({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div className="border-b border-line bg-orange-tint px-3 py-2 text-xs text-orange" role="status">
      Nox is open in another window. This one is read-only.
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="ml-2 underline">dismiss</button>
      )}
    </div>
  )
}
