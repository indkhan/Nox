/**
 * Publish-gate evidence evaluation (Epoch F5).
 *
 * Pure, side-effect-free check extracted from `scripts/release-smoke.mjs` so
 * it can be unit-tested without running the full release smoke. The gate is
 * fail-closed: every required live scenario C01–C17 must read PASS in the
 * evidence log plus an explicit `Publish gate: PASS` marker. Anything else
 * (BLOCKED, missing rows, missing marker, missing file) blocks publishing.
 * Automated success alone never publishes live-verified behavior.
 */

/** Evaluate evidence-log text for the publish gate. Never touches disk. */
export function evaluatePublishGateEvidence(text) {
  const input = typeof text === 'string' ? text : ''
  const missing = []
  for (let i = 1; i <= 17; i++) {
    const id = `C${String(i).padStart(2, '0')}`
    if (!new RegExp(`\\|\\s*${id}\\b[^\\n]*\\|\\s*PASS\\b`, 'i').test(input)) missing.push(id)
  }
  const marker = /^Publish gate:\s*PASS\s*$/m.test(input)
  return { ok: marker && missing.length === 0, missing, marker }
}
