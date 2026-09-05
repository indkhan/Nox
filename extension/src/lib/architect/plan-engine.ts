import { normalizeId } from '../../shared/notion-page'
import { validateWorkspacePlan, type WorkspacePlan } from './plan'

export interface PendingWorkspacePlan {
  id: string
  plan: WorkspacePlan
  resolve: (decision: 'approved' | 'rejected') => void
}

export class PlanEngine {
  private turnId: string | null = null
  private approved: WorkspacePlan | null = null
  private pending = new Map<string, PendingWorkspacePlan>()

  constructor(
    private readonly notify?: (plan: PendingWorkspacePlan) => void,
    private readonly dismiss?: (id: string) => void,
  ) {}

  beginTurn(turnId: string): void {
    this.rejectPending()
    this.turnId = turnId
    this.approved = null
  }

  request(input: unknown, approveAutomatically = false): Promise<'approved' | 'rejected'> {
    const plan = validateWorkspacePlan(input)
    if (approveAutomatically) {
      this.approved = plan
      return Promise.resolve('approved')
    }
    return new Promise((resolve) => {
      const pending: PendingWorkspacePlan = {
        id: crypto.randomUUID(),
        plan,
        resolve: (decision) => {
          this.pending.delete(pending.id)
          this.dismiss?.(pending.id)
          if (decision === 'approved') this.approved = plan
          resolve(decision)
        },
      }
      this.pending.set(pending.id, pending)
      this.notify?.(pending)
    })
  }

  authorize(tool: string, args: Record<string, unknown>): { allowed: boolean; reason?: string } {
    if (!this.turnId || !this.approved) return { allowed: false, reason: 'PLAN_REQUIRED: structural workspace changes require an approved plan.' }
    const targets = targetIds(args)
    const match = this.approved.operations.some((operation) =>
      operation.tool === tool && (!operation.targetId || targets.some((target) => sameId(operation.targetId!, target))),
    )
    return match
      ? { allowed: true }
      : { allowed: false, reason: 'PLAN_MISMATCH: this structural operation was not included in the approved plan.' }
  }

  answer(id: string, decision: 'approved' | 'rejected'): void {
    this.pending.get(id)?.resolve(decision)
  }

  rejectPending(): void {
    for (const pending of [...this.pending.values()]) pending.resolve('rejected')
  }
}

function targetIds(args: Record<string, unknown>): string[] {
  const targets: string[] = []
  for (const value of [args.data_source_id, args.database_id, args.view_id, args.page_id, args.parent, args.data, args.command]) {
    if (typeof value === 'string') targets.push(value)
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>
      for (const id of [nested.data_source_id, nested.database_id, nested.view_id, nested.page_id, nested.id]) {
        if (typeof id === 'string') targets.push(id)
      }
    }
  }
  return targets
}

function sameId(left: string, right: string | undefined): boolean {
  if (!right) return false
  return (normalizeId(left) ?? left) === (normalizeId(right) ?? right)
}
