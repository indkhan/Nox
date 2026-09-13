import type { DynamicTool } from '../agent/dynamic-tools'
import { NOTION_TOOL_NAME_PATTERN } from './plan'

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
      evidence: {
        type: 'array', minItems: 1, maxItems: 20,
        items: {
          type: 'object', required: ['id', 'title', 'kind', 'reason'],
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            kind: { type: 'string', enum: ['page', 'database', 'data-source', 'view'] },
            reason: { type: 'string' },
          },
        },
      },
      operations: {
        type: 'array', minItems: 1, maxItems: 10,
        items: {
          type: 'object', required: ['tool', 'summary'],
          properties: {
            tool: { type: 'string', pattern: NOTION_TOOL_NAME_PATTERN, description: 'Exact notion-* tool name to execute.' },
            targetId: { type: 'string' },
            summary: { type: 'string' },
          },
        },
      },
      consequences: { type: 'array', items: { type: 'string' } },
    },
  },
}
