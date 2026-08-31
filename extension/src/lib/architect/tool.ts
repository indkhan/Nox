import type { DynamicTool } from '../agent/dynamic-tools'

export const WORKSPACE_PLAN_TOOL_NAME = 'nox-propose-workspace-plan'

export const WORKSPACE_PLAN_TOOL: DynamicTool = {
  type: 'function',
  name: WORKSPACE_PLAN_TOOL_NAME,
  description: 'Present an inspected, structural Notion workspace plan for user approval before significant changes.',
  inputSchema: {
    type: 'object',
    required: ['goal', 'recommendation', 'evidence', 'operations', 'consequences'],
    properties: {
      goal: { type: 'string' },
      recommendation: { type: 'string' },
      evidence: { type: 'array', items: { type: 'object' } },
      operations: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object' } },
      consequences: { type: 'array', items: { type: 'string' } },
    },
  },
}
