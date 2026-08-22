import { BULK_CONFIRM_ROWS } from '../writes/approvals'

export interface AutofillTask {
  rowId: string
  rowTitle: string
}

export interface AutofillPreview {
  tasks: AutofillTask[]
  property: string
  prompt: string
  estimatedToolCalls: number
  needsConfirmation: boolean
}

export interface AutofillOutcome {
  applied: number
  failed: number
  cancelled: boolean
  errors: Array<{ rowId: string; error: string }>
}

const CONCURRENCY = 3

export function buildAutofillPreview(tasks: AutofillTask[], property: string, prompt: string): AutofillPreview {
  return {
    tasks,
    property,
    prompt,
    estimatedToolCalls: tasks.length,
    needsConfirmation: tasks.length > BULK_CONFIRM_ROWS,
  }
}

/**
 * Bulk autofill (MVP §6.6): preview first, run at concurrency 3, cancel any
 * time. Runs only while the panel is open — that is the contract; the journal
 * survives a close so undo still works after reopening.
 */
export class AutofillRun {
  private cancelledFlag = false

  constructor(
    private readonly deps: {
      generate: (task: AutofillTask, prompt: string) => Promise<unknown>
      apply: (task: AutofillTask, value: unknown) => Promise<void>
      onProgress?: (done: number, total: number, lastRow?: string) => void
    },
  ) {}

  get isCancelled(): boolean {
    return this.cancelledFlag
  }

  cancel(): void {
    this.cancelledFlag = true
  }

  async run(preview: AutofillPreview): Promise<AutofillOutcome> {
    const outcome: AutofillOutcome = { applied: 0, failed: 0, cancelled: false, errors: [] }
    const queue = [...preview.tasks]
    let done = 0
    const total = queue.length

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelledFlag) return
        const task = queue.shift()
        if (!task) return
        try {
          const value = await this.deps.generate(task, preview.prompt)
          if (this.cancelledFlag) return
          await this.deps.apply(task, value)
          outcome.applied += 1
        } catch (e) {
          outcome.failed += 1
          outcome.errors.push({ rowId: task.rowId, error: e instanceof Error ? e.message : String(e) })
        }
        done += 1
        this.deps.onProgress?.(done, total, task.rowTitle)
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    outcome.cancelled = this.cancelledFlag
    return outcome
  }
}
