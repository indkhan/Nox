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

export interface EvidenceScope {
  threadId: string | null
  isInspected: (threadId: string | null, id: string) => boolean
}

export const NOTION_TOOL_NAME_PATTERN = '^notion-[a-z0-9]+(?:-[a-z0-9]+)*$'

const EVIDENCE_KINDS = new Set(['page', 'database', 'data-source', 'view'])
const MAX_EVIDENCE = 20
const MAX_OPERATIONS = 10
const MAX_CONSEQUENCES = 20
const MAX_TEXT = 500

/**
 * Structural validation for a proposed workspace plan. Every object and
 * array field is checked: supported kinds, real identifier types, nonempty
 * bounded strings, duplicate operations, and list counts. Evidence ids must
 * additionally be ledger-recorded retrievals in the current scope — unknown
 * ids are rejected as inspection evidence with a model-readable error, and
 * no pending card is created. Throws; never filters quietly.
 */
export function validateWorkspacePlan(value: unknown, scope: EvidenceScope): WorkspacePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace plan must be an object')
  }
  const plan = value as Partial<WorkspacePlan>
  if (!text(plan.goal)) throw new Error('workspace plan goal is required')
  if (!text(plan.recommendation)) throw new Error('workspace plan recommendation is required')
  if (!Array.isArray(plan.evidence) || plan.evidence.length === 0 || plan.evidence.length > MAX_EVIDENCE) {
    throw new Error(`workspace plan requires 1-${MAX_EVIDENCE} evidence items from workspace inspection`)
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0 || plan.operations.length > MAX_OPERATIONS) {
    throw new Error(`workspace plan requires 1-${MAX_OPERATIONS} operations`)
  }
  const evidence = plan.evidence.map((entry) => validateEvidence(entry, scope))
  const operations = validateOperations(plan.operations)
  let consequences: string[] = []
  if (plan.consequences !== undefined) {
    if (!Array.isArray(plan.consequences) || plan.consequences.length > MAX_CONSEQUENCES) {
      throw new Error(`workspace plan consequences must be a list of at most ${MAX_CONSEQUENCES} strings`)
    }
    for (const consequence of plan.consequences) {
      if (!text(consequence)) throw new Error('workspace plan consequences must be nonempty strings')
    }
    consequences = plan.consequences as string[]
  }
  return {
    goal: plan.goal!,
    recommendation: plan.recommendation!,
    evidence,
    operations,
    consequences,
  }
}

function validateEvidence(entry: unknown, scope: EvidenceScope): PlanEvidence {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('workspace plan evidence entries must be objects with id, title, kind, and reason')
  }
  const candidate = entry as Partial<PlanEvidence>
  const id = realIdentifier(candidate.id, 'evidence id')
  if (!text(candidate.title)) throw new Error('workspace plan evidence title is required')
  if (typeof candidate.kind !== 'string' || !EVIDENCE_KINDS.has(candidate.kind)) {
    throw new Error('workspace plan evidence kind must be page, database, data-source, or view')
  }
  if (!text(candidate.reason)) throw new Error('workspace plan evidence reason is required')
  if (!scope.isInspected(scope.threadId, id)) {
    throw new Error(
      `EVIDENCE_NOT_INSPECTED: "${id}" was never retrieved by Nox in this conversation — fetch it first instead of citing it as inspected.`,
    )
  }
  return { id, title: candidate.title!, kind: candidate.kind as PlanEvidence['kind'], reason: candidate.reason! }
}

function validateOperations(operations: unknown[]): PlannedOperation[] {
  const seen = new Set<string>()
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('every plan operation needs a canonical notion-* tool name and summary')
    }
    const candidate = operation as Partial<PlannedOperation>
    if (!text(candidate.tool) || !new RegExp(NOTION_TOOL_NAME_PATTERN).test(candidate.tool!)) {
      throw new Error('every plan operation needs a canonical notion-* tool name and summary')
    }
    if (!text(candidate.summary)) {
      throw new Error('every plan operation needs a canonical notion-* tool name and summary')
    }
    let targetId: string | undefined
    if (candidate.targetId !== undefined) {
      targetId = realIdentifier(candidate.targetId, 'operation targetId')
    }
    const key = `${candidate.tool} ${targetId ?? ''}`
    if (seen.has(key)) throw new Error('workspace plan operations must not duplicate the same tool and target')
    seen.add(key)
    return targetId === undefined
      ? { tool: candidate.tool!, summary: candidate.summary! }
      : { tool: candidate.tool!, targetId, summary: candidate.summary! }
  })
}

/** Real identifier type: a non-empty, non-numeric string (UUIDs normalize downstream). */
function realIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /^\d+$/.test(value.trim())) {
    throw new Error(`workspace plan ${field} must be a real identifier string`)
  }
  return value
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT
}
