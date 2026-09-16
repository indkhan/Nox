import type { DynamicTool } from '../agent/dynamic-tools'
import { NOTION_TOOL_NAME_PATTERN } from './plan'

export const WORKSPACE_PLAN_TOOL_NAME = 'nox-propose-workspace-plan'

export const WORKSPACE_PLAN_TOOL: DynamicTool = {
  type: 'function',
  name: WORKSPACE_PLAN_TOOL_NAME,
  description: 'Present an inspected, structural Notion workspace plan for explicit user approval before significant changes. List exact operations with complete arguments and cite only workspace items Nox retrieved this conversation. Approval covers exactly the listed operations, once each.',
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
          type: 'object', required: ['tool', 'args', 'summary'],
          properties: {
            opId: { type: 'string', description: 'Unique local label, for referencing this operation from later ones.' },
            tool: { type: 'string', pattern: NOTION_TOOL_NAME_PATTERN, description: 'Exact notion-* tool name to execute.' },
            targetId: {
              description: 'Existing target id, or {ref: label} for an object created by a preceding operation.',
              anyOf: [{ type: 'string' }, { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } }, additionalProperties: false }],
            },
            args: { type: 'object', description: 'Complete call arguments. Use {ref: label} for ids created by preceding operations.' },
            summary: { type: 'string' },
          },
        },
      },
      consequences: { type: 'array', items: { type: 'string' } },
    },
  },
}
