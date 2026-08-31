import { useEffect, useRef, useState } from 'react'

/**
 * StreamText — reusable streaming primitive (vendored from Beautiful UI).
 * Reveals characters quickly; the leading edge resolves out of a soft blur,
 * and the caret stays solid while streaming, then blinks once the text
 * settles. Inherits typography from its context.
 */
export function StreamText({
  text,
  charsPerTick = 2,
  tickMs = 9,
  blurTail = 6,
  caret = true,
  className,
  onProgress,
  onDone,
}: {
  text: string
  charsPerTick?: number
  tickMs?: number
  blurTail?: number
  caret?: boolean
  className?: string
  onProgress?: () => void
  onDone?: () => void
}) {
  const [count, setCount] = useState(0)
  const onProgressRef = useRef(onProgress)
  const onDoneRef = useRef(onDone)
  onProgressRef.current = onProgress
  onDoneRef.current = onDone

  useEffect(() => {
    setCount(0)
    let i = 0
    const id = setInterval(() => {
      i = Math.min(i + charsPerTick, text.length)
      setCount(i)
      onProgressRef.current?.()
      if (i >= text.length) {
        clearInterval(id)
        onDoneRef.current?.()
      }
    }, tickMs)
    return () => clearInterval(id)
  }, [text, charsPerTick, tickMs])

  const streaming = count < text.length
  const shown = text.slice(0, count)
  const split = streaming ? Math.max(0, shown.length - blurTail) : shown.length

  return (
    <span className={className}>
      {shown.slice(0, split)}
      {split < shown.length && <span className="stream-tail">{shown.slice(split)}</span>}
      {caret && <span aria-hidden className={`stream-caret${streaming ? ' is-streaming' : ''}`} />}
    </span>
  )
}
