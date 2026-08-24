export interface PlanEvidence {
  id: string
  title: string
  kind: 'page' | 'database' | 'data-source' | 'view'
  reason: string
}

export interface PlannedOperation {
  tool: string
  targetId?: string
  summary: string
}

export interface WorkspacePlan {
  goal: string
  recommendation: string
  evidence: PlanEvidence[]
  operations: PlannedOperation[]
  consequences: string[]
}

export function validateWorkspacePlan(value: unknown): WorkspacePlan {
  if (!value || typeof value !== 'object') throw new Error('workspace plan must be an object')
  const plan = value as Partial<WorkspacePlan>
  if (!text(plan.goal)) throw new Error('workspace plan goal is required')
  if (!text(plan.recommendation)) throw new Error('workspace plan recommendation is required')
  if (!Array.isArray(plan.evidence) || plan.evidence.length === 0 || plan.evidence.length > 20) {
    throw new Error('workspace plan requires 1-20 evidence items from workspace inspection')
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0 || plan.operations.length > 20) {
    throw new Error('workspace plan requires 1-20 operations')
  }
  for (const operation of plan.operations) {
    if (!operation || !text(operation.tool) || !text(operation.summary)) throw new Error('every plan operation needs a tool and summary')
  }
  return {
    goal: plan.goal!,
    recommendation: plan.recommendation!,
    evidence: plan.evidence,
    operations: plan.operations,
    consequences: Array.isArray(plan.consequences) ? plan.consequences.filter(text) : [],
  }
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500
}
