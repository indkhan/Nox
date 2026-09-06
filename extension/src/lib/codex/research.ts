import type { NativeBridge } from './native'

// Verified against the bridge-selected 0.153.4 feature catalog.
export const RESTRICTED_FEATURES = [
  'shell_tool', 'apps', 'plugins', 'remote_plugin', 'multi_agent',
  'multi_agent_v2', 'hooks', 'memories', 'image_generation', 'view_image',
  'browser_use', 'computer_use', 'code_mode', 'code_mode_host', 'goals',
  'tool_suggest', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install',
  'sleep_tool', 'artifact', 'request_permissions_tool', 'in_app_local_automation',
] as const

export async function researchConfig(bridge: NativeBridge, enabled: boolean) {
  const [current, managed] = await Promise.all([
    bridge.rpc<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', { includeLayers: false }),
    bridge.rpc<{ requirements: { allowedWebSearchModes?: string[] | null } | null }>('configRequirements/read', {}),
  ])
  if (!current.config || !('requirements' in managed)) throw new Error('Cannot inspect Codex research configuration. Update the Nox bridge and reconnect.')
  const modes = managed.requirements?.allowedWebSearchModes
  const live = enabled && (!modes || modes.includes('live'))
  const mode = live ? 'live' : 'disabled'
  if (modes && !modes.includes(mode)) throw new Error(`Managed Codex configuration does not allow ${mode} search.`)
  const config: Record<string, unknown> = Object.fromEntries(RESTRICTED_FEATURES.map(name => [`features.${name}`, false]))
  for (const name of Object.keys(current.config.mcp_servers ?? {})) {
    // Refuse ambiguous override paths rather than configuring a different server.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Cannot isolate an MCP server with an unsupported configuration name.')
    config[`mcp_servers.${name}.enabled`] = false
  }
  // unified_exec selects the shell backend and is model-forced in 0.153.4.
  // shell_tool is the availability gate; verify that gate instead.
  config['agents.max_threads'] = 1
  config.web_search = mode
  config.project_doc_max_bytes = 0
  return { config, limitation: enabled && !live ? 'Live web research is unavailable under managed Codex restrictions. External facts have not been freshly checked.' : null }
}

export async function verifyResearchTools(bridge: NativeBridge, threadId: string, signal?: AbortSignal): Promise<void> {
  const features = new Map<string, boolean>()
  let cursor: string | null = null
  do {
    signal?.throwIfAborted()
    const page: { data: Array<{ name: string; enabled: boolean }>; nextCursor?: string | null } = await bridge.rpc('experimentalFeature/list', { threadId, limit: 200, cursor })
    if (!Array.isArray(page.data)) throw new Error('Cannot verify the effective Codex tool surface. Update Codex and reconnect.')
    for (const feature of page.data) features.set(feature.name, feature.enabled)
    cursor = page.nextCursor ?? null
  } while (cursor)
  for (const feature of RESTRICTED_FEATURES) {
    if (features.get(feature) !== false) throw new Error(`Nox cannot safely run: Codex feature ${feature} is enabled or cannot be verified.`)
  }
  do {
    signal?.throwIfAborted()
    const page: { data: Array<{ name: string; tools: Record<string, unknown> }>; nextCursor?: string | null } = await bridge.rpc('mcpServerStatus/list', { threadId, cursor })
    if (!Array.isArray(page.data)) throw new Error('Cannot verify inherited MCP tools.')
    if (page.data.some(server => Object.keys(server.tools ?? {}).length > 0)) throw new Error('Nox cannot safely run: unrelated MCP tools remain exposed.')
    cursor = page.nextCursor ?? null
  } while (cursor)
}
