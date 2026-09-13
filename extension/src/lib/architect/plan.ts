import { canonicalizeArgs, validateEffect, type ValidatedEffect } from '../writes/effects'

export interface PlanEvidence {
  id: string
  title: string
  kind: 'page' | 'database' | 'data-source' | 'view'
  reason: string
}

/** Reference to a preceding operation's validated created-object slot. */
export interface PlanReference {
  ref: string
}

export interface PlannedOperation {
  /** Unique local label; assigned op-N in array order when absent. */
  opId?: string
  tool: string
  targetId?: string | PlanReference
  /** Complete validated call arguments (canonical; refs only in id slots). */
  args: Record<string, unknown>
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
/** Tool kinds whose executions create addressable objects with result slots. */
const CREATION_TOOLS = new Set([
  'notion-create-pages',
  'notion-duplicate-page',
  'notion-create-database',
  'notion-create-folder',
  'notion-create-comment',
  'notion-create-view',
])
const MAX_EVIDENCE = 20
const MAX_OPERATIONS = 10
const MAX_CONSEQUENCES = 20
const MAX_TEXT = 500
const MAX_OP_ID = 50

/**
 * Structural validation for a proposed workspace plan. Every object and
 * array field is checked: supported kinds, real identifier types, nonempty
 * bounded strings, unique operation labels, duplicate operations, and list
 * counts. Operations carry complete canonical arguments; references to
 * preceding creations use the small explicit {ref} form and are rejected for
 * forward, self, non-creation, or misplaced uses. Evidence ids must
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
  const labels = new Map<string, { index: number; tool: string }>()
  const raws: Record<string, unknown>[] = operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('every plan operation needs a canonical notion-* tool name, complete args, and summary')
    }
    const candidate = operation as Record<string, unknown>
    const opId = candidate.opId
    if (opId !== undefined) {
      if (typeof opId !== 'string' || !opId.trim() || opId.length > MAX_OP_ID) {
        throw new Error('workspace plan operation labels must be nonempty strings')
      }
      if (labels.has(opId)) throw new Error(`workspace plan operation label "${opId}" is duplicated`)
      labels.set(opId, { index, tool: '' })
    }
    return candidate
  })
  // Assign deterministic op-N labels to the unlabeled, skipping taken names.
  raws.forEach((candidate, index) => {
    if (candidate.opId !== undefined) return
    let candidateNumber = index + 1
    while (labels.has(`op-${candidateNumber}`)) candidateNumber++
    candidate.opId = `op-${candidateNumber}`
    labels.set(`op-${candidateNumber}`, { index, tool: '' })
  })
  const seenPairs = new Set<string>()
  return raws.map((candidate, index) => validateOperation(candidate, index, labels, seenPairs))
}

function validateOperation(
  operation: Record<string, unknown>,
  index: number,
  labels: Map<string, { index: number; tool: string }>,
  seenPairs: Set<string>,
): PlannedOperation {
  const tool = operation.tool
  const summary = operation.summary
  if (typeof tool !== 'string' || !text(tool) || !new RegExp(NOTION_TOOL_NAME_PATTERN).test(tool)) {
    throw new Error('every plan operation needs a canonical notion-* tool name, complete args, and summary')
  }
  if (!text(summary)) {
    throw new Error('every plan operation needs a canonical notion-* tool name, complete args, and summary')
  }
  const args = operation.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('every plan operation needs complete validated arguments')
  }
  const canonical = canonicalizeArgs(args)
  if (Object.hasOwn(canonical, '__nox_expected_hash')) {
    throw new Error('plan operations must not carry the internal field __nox_expected_hash')
  }
  delete canonical.injected_request
  // Record this operation's tool for creation-kind reference checks below.
  for (const [label, info] of labels) {
    if (info.index === index) labels.set(label, { index, tool })
  }
  // References use the small explicit {ref} form anywhere in the arguments.
  // Every label must name a preceding creation operation; anything else —
  // unknown, forward, self, or non-creation labels — is rejected here.
  const argRefs = new Set<string>()
  collectRefLabels(canonical, argRefs)
  for (const label of argRefs) assertRefTarget(label, 'args', index, labels)
  // Substitute a placeholder so the adapter validates the operation shape
  // without knowing future ids; identity is enforced at dispatch time.
  let shaped: ValidatedEffect
  try {
    shaped = validateEffect(tool, substituteRefPlaceholders(canonical) as Record<string, unknown>)
  } catch (e) {
    throw new Error(`workspace plan operation has an unsupported shape: ${e instanceof Error ? e.message : String(e)}`)
  }
  const targetId = validateTarget(operation.targetId, index, labels, argRefs, [...shaped.targets, ...shaped.parents])
  const pair = `${tool} ${JSON.stringify(targetId ?? null)}`
  if (seenPairs.has(pair)) {
    throw new Error('workspace plan operations must not duplicate the same tool and target')
  }
  seenPairs.add(pair)
  return { opId: operation.opId as string, tool, targetId, args: canonical, summary: summary as string }
}

function validateTarget(
  targetId: unknown,
  index: number,
  labels: Map<string, { index: number; tool: string }>,
  argRefs: Set<string>,
  knownIds: string[],
): string | PlanReference | undefined {
  if (targetId === undefined) return undefined
  if (typeof targetId === 'string') {
    const id = realIdentifier(targetId, 'operation targetId')
    if (!knownIds.includes(id)) {
      throw new Error('workspace plan operation targetId must agree with the operation arguments')
    }
    return id
  }
  if (isPlanRef(targetId)) {
    assertRefTarget(targetId.ref, 'targetId', index, labels)
    if (!argRefs.has(targetId.ref)) {
      throw new Error('workspace plan operation targetId reference must agree with the operation arguments')
    }
    return { ref: targetId.ref }
  }
  throw new Error('workspace plan operation targetId must be a real identifier string')
}

/** Placeholder id standing in for future creation results during validation. */
const REF_PLACEHOLDER = '00000000-0000-4000-8000-000000000000'

function collectRefLabels(value: unknown, into: Set<string>): void {
  if (isPlanRef(value)) {
    into.add(value.ref)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRefLabels(entry, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectRefLabels(entry, into)
  }
}

function substituteRefPlaceholders(value: unknown): unknown {
  if (isPlanRef(value)) return REF_PLACEHOLDER
  if (Array.isArray(value)) return value.map(substituteRefPlaceholders)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = substituteRefPlaceholders(entry)
    return out
  }
  return value
}

function assertRefTarget(label: string, where: string, index: number, labels: Map<string, { index: number; tool: string }>): void {
  const target = labels.get(label)
  if (!target) throw new Error(`reference in ${where} names an unknown operation "${label}"`)
  if (target.index >= index) {
    throw new Error(`reference in ${where} must point to a preceding operation, not "${label}"`)
  }
  if (!CREATION_TOOLS.has(target.tool)) {
    throw new Error(`reference in ${where} must point to a creation operation, not "${label}"`)
  }
}

export function isPlanRef(value: unknown): value is PlanReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'ref' && typeof (value as Record<string, unknown>).ref === 'string'
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
