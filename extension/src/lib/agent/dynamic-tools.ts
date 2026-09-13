import type { McpTool } from '../mcp/client'
import type { CapabilityGate } from '../notion/capabilities'
import { WORKSPACE_PLAN_TOOL } from '../architect/tool'
import { UPLOAD_FILE_TOOL, isRawUploadTicketTool, isUploadWorkflowSupported } from '../attachments/upload-tool'

/** The shape Codex `thread/start.dynamicTools` expects (verified, spike 0.2). */
export interface DynamicTool {
  type: 'function'
  name: string
  description?: string
  inputSchema?: unknown
}

/**
 * Maps the runtime tool surface into Codex dynamicTools, dropping anything the
 * account's plan cannot use. Discover, don't hardcode (RESEARCH §7.5).
 */
export function toDynamicTools(tools: McpTool[], gate: CapabilityGate): DynamicTool[] {
  const out: DynamicTool[] = []
  for (const tool of tools) {
    // The raw ticket route would bypass the upload effect policy (08.1.4):
    // ticket creation is only ever an internal step of the supported upload
    // workflow, never a model-callable tool.
    if (isRawUploadTicketTool(tool.name)) continue
    if (!gate.can(tool.name).allowed) continue
    if (typeof tool.name !== 'string' || !tool.name) continue
    out.push({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    })
  }
  // The local upload tool is advertised only when the discovered list and
  // the capability gate positively support the underlying workflow (08.1.1).
  // Without a verified ticket contract it stays hidden.
  const localTools = isUploadWorkflowSupported(tools, gate)
    ? [WORKSPACE_PLAN_TOOL, UPLOAD_FILE_TOOL]
    : [WORKSPACE_PLAN_TOOL]
  return [...out, ...localTools, {
    type: 'function', name: 'nox-read-continuation',
    description: 'Read an omitted excerpt of already-fetched text using its opaque handle and character offset. Read-only, current turn only. Prefer Notion subtree IDs or supported targeted retrieval for remote truncation.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['handle', 'offset'], additionalProperties: false },
  }]
}
