import type { McpTool } from '../mcp/client'
import type { CapabilityGate } from '../notion/capabilities'

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
    if (!gate.can(tool.name).allowed) continue
    if (typeof tool.name !== 'string' || !tool.name) continue
    out.push({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    })
  }
  return out
}
