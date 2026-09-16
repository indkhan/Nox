import { validateEffect, type ValidatedEffect } from '../writes/effects'
import { isPlanRef, validateWorkspacePlan, type WorkspacePlan } from './plan'
import { isInspectedEvidence } from '../agent/retrievals'

export interface PendingWorkspacePlan {
  id: string
  plan: WorkspacePlan
  resolve: (decision: 'approved' | 'rejected') => void
}

/** Runtime scope an approved plan is bound to. Any change fails closed. */
export interface PlanScope {
  workspaceId: string | null
  connectionGeneration: string | null
  threadId: string | null
  turnId: string | null
}

export interface PlanAuthorization {
  allowed: boolean
  reason?: string
  reservationId?: string
  operationLabel?: string
}

interface ApprovedPlanState {
  plan: WorkspacePlan
  scope: PlanScope
  consumed: Set<string>
  reservations: Map<string, { opId: string; scope: PlanScope; count: number }>
  createdSlots: Map<string, string[]>
}

const MAX_REJECTED_DIGESTS = 20

export class PlanEngine {
  private approved: ApprovedPlanState | null = null
  private pending = new Map<string, PendingWorkspacePlan>()
  private rejectedDigests = new Set<string>()

  constructor(
    private readonly notify?: (plan: PendingWorkspacePlan) => void,
    private readonly dismiss?: (id: string) => void,
    private readonly resultAdapters: Record<string, (resultText: string) => string[]> = {},
  ) {}

  beginTurn(_turnId: string): void {
    this.rejectPending()
    this.approved = null
    this.rejectedDigests.clear()
  }

  /**
   * Validate and present a plan for explicit human approval — in both Ask
   * and Auto modes. A plan rejected this turn cannot be silently reproposed
   * until a new turn begins.
   */
  request(input: unknown, scope: PlanScope): Promise<'approved' | 'rejected'> {
    const plan = validateWorkspacePlan(input, {
      threadId: scope.threadId,
      isInspected: isInspectedEvidence,
    })
    const digest = planDigest(plan)
    if (this.rejectedDigests.has(digest)) {
      throw new Error('PLAN_REJECTED_REPEAT: this plan was already rejected this turn — ask the user before proposing it again.')
    }
    return new Promise((resolve) => {
      const pending: PendingWorkspacePlan = {
        id: crypto.randomUUID(),
        plan,
        resolve: (decision) => {
          this.pending.delete(pending.id)
          this.dismiss?.(pending.id)
          if (decision === 'approved') {
            this.approved = { plan, scope: { ...scope }, consumed: new Set(), reservations: new Map(), createdSlots: new Map() }
          } else {
            this.rejectedDigests.add(digest)
            while (this.rejectedDigests.size > MAX_REJECTED_DIGESTS) {
              const oldest = this.rejectedDigests.values().next()
              if (oldest.done) break
              this.rejectedDigests.delete(oldest.value)
            }
          }
          resolve(decision)
        },
      }
      this.pending.set(pending.id, pending)
      this.notify?.(pending)
    })
  }

  /**
   * Match a validated effect against the approved plan's unconsumed,
   * unreserved operations. Comparison is exact over the complete canonical
   * arguments with creation references resolved: omitted targets never
   * wildcard, and one matching id from a batch never stands in for the rest.
   * Returns a one-use reservation — never a reusable boolean.
   */
  authorize(effect: ValidatedEffect, scope: PlanScope): PlanAuthorization {
    const state = this.approved
    if (!state) {
      return { allowed: false, reason: 'PLAN_REQUIRED: structural workspace changes require an approved plan.' }
    }
    if (!sameScope(state.scope, scope)) {
      return { allowed: false, reason: 'PLAN_STALE: the approved plan belongs to a different workspace, connection, thread, or turn.' }
    }
    for (const operation of state.plan.operations) {
      const opId = operation.opId
      if (!opId || state.consumed.has(opId) || isReserved(state, opId)) continue
      if (operation.tool !== effect.tool) continue
      const resolved = resolveOperation(operation.args, state.createdSlots)
      if (!resolved) continue
      let expected: ValidatedEffect
      try {
        expected = validateEffect(operation.tool, resolved)
      } catch {
        continue
      }
      if (JSON.stringify(expected.args) === JSON.stringify(effect.args)) {
        const reservationId = crypto.randomUUID()
        state.reservations.set(reservationId, { opId, scope: { ...scope }, count: expected.count })
        return { allowed: true, reservationId, operationLabel: opId }
      }
    }
    return { allowed: false, reason: 'PLAN_MISMATCH: this structural operation was not included in the approved plan. If it follows a creation, submit a second concrete plan with the created ids.' }
  }

  /** Pre-dispatch revalidation of a reservation against the current scope. */
  checkReservation(reservationId: string, scope: PlanScope): boolean {
    const state = this.approved
    const reservation = state?.reservations.get(reservationId)
    return !!reservation && sameScope(reservation.scope, scope)
  }

  /**
   * Consume a reservation at dispatch — exactly once per operation, whatever
   * the outcome. Creation ids are recorded only through a verified
   * tool-specific adapter with an exact object count; anything else leaves
   * dependent references unresolvable so a second concrete plan is required.
   */
  consume(reservationId: string, resultText?: string): boolean {
    const state = this.approved
    const reservation = state?.reservations.get(reservationId)
    if (!state || !reservation) return false
    state.reservations.delete(reservationId)
    state.consumed.add(reservation.opId)
    const operation = state.plan.operations.find((op) => op.opId === reservation.opId)
    const adapter = operation ? this.resultAdapters[operation.tool] : undefined
    if (operation && adapter && resultText != null) {
      let ids: string[] = []
      try {
        ids = adapter(resultText)
      } catch {
        ids = []
      }
      if (ids.length === reservation.count && reservation.count > 0) {
        state.createdSlots.set(reservation.opId, ids)
      }
    }
    return true
  }

  /** Drop the approved plan and its reservations: cancel, timeout, sign-out. */
  invalidateApproval(): void {
    this.approved = null
  }

  answer(id: string, decision: 'approved' | 'rejected'): void {
    this.pending.get(id)?.resolve(decision)
  }

  rejectPending(): void {
    for (const pending of [...this.pending.values()]) pending.resolve('rejected')
  }
}

function sameScope(a: PlanScope, b: PlanScope): boolean {
  return a.workspaceId === b.workspaceId &&
    a.connectionGeneration === b.connectionGeneration &&
    a.threadId === b.threadId &&
    a.turnId === b.turnId
}

function isReserved(state: ApprovedPlanState, opId: string): boolean {
  for (const reservation of state.reservations.values()) {
    if (reservation.opId === opId) return true
  }
  return false
}

/**
 * Substitute creation references with recorded slot ids (deep copy). Returns
 * null when any reference is unresolvable — including slots holding anything
 * but exactly one recorded id, which keeps ambiguous bulk results fail-closed.
 */
function resolveOperation(
  args: Record<string, unknown>,
  slots: Map<string, string[]>,
): Record<string, unknown> | null {
  const resolved = resolveValue(args, slots)
  if (!resolved.ok || !resolved.value || typeof resolved.value !== 'object' || Array.isArray(resolved.value)) {
    return null
  }
  return resolved.value as Record<string, unknown>
}

type Resolved = { ok: true; value: unknown } | { ok: false }

function resolveValue(value: unknown, slots: Map<string, string[]>): Resolved {
  if (isPlanRef(value)) {
    const ids = slots.get(value.ref)
    if (!ids || ids.length !== 1) return { ok: false }
    return { ok: true, value: ids[0] }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const entry of value) {
      const resolved = resolveValue(entry, slots)
      if (!resolved.ok) return resolved
      out.push(resolved.value)
    }
    return { ok: true, value: out }
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const resolved = resolveValue(entry, slots)
      if (!resolved.ok) return resolved
      out[key] = resolved.value
    }
    return { ok: true, value: out }
  }
  return { ok: true, value }
}

function planDigest(plan: WorkspacePlan): string {
  return JSON.stringify(plan)
}
