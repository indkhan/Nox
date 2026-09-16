import { describe, expect, it, vi } from 'vitest'
import { researchConfig, verifyResearchTools, RESTRICTED_FEATURES } from '../../src/lib/codex/research'
import type { NativeBridge } from '../../src/lib/codex/native'

function bridge(restricted = false, unsafe = false, mcpTools = false) {
  return { rpc: vi.fn(async (method: string) => {
    if (method === 'config/read') return { config: { mcp_servers: { external: { enabled: true } } } }
    if (method === 'configRequirements/read') return { requirements: restricted ? { allowedWebSearchModes: ['disabled'] } : null }
    if (method === 'experimentalFeature/list') return { data: RESTRICTED_FEATURES.map(name => ({ name, enabled: unsafe && name === 'shell_tool' })), nextCursor: null }
    if (method === 'mcpServerStatus/list') {
      return mcpTools
        ? { data: [{ name: 'external', tools: { 'evil-tool': {} } }], nextCursor: null }
        : { data: [], nextCursor: null }
    }
    return { data: [], nextCursor: null }
  }) } as unknown as NativeBridge
}

describe('Nox research configuration', () => {
  it('requests live search and disables inherited tools without changing global settings', async () => {
    const b = bridge()
    const result = await researchConfig(b, true)
    expect(result.config).toMatchObject({ web_search: 'live', 'features.shell_tool': false, 'features.plugins': false, 'mcp_servers.external.enabled': false })
    expect(b.rpc).not.toHaveBeenCalledWith('config/value/write', expect.anything())
  })
  it('keeps search disabled and reports a managed live-search restriction', async () => {
    expect((await researchConfig(bridge(), false)).config.web_search).toBe('disabled')
    const result = await researchConfig(bridge(true), true)
    expect(result.config.web_search).toBe('disabled')
    expect(result.limitation).toMatch(/unavailable/i)
  })
  it('refuses to run when effective native tools are broader than intended', async () => {
    await expect(verifyResearchTools(bridge(false, true), 't')).rejects.toThrow(/shell_tool/)
    await expect(verifyResearchTools(bridge(), 't')).resolves.toBeUndefined()
  })
  it('fails closed when inherited MCP tools remain exposed (Epoch 14)', async () => {
    await expect(verifyResearchTools(bridge(false, false, true), 't')).rejects.toThrow(/MCP tools/)
    await expect(verifyResearchTools(bridge(false, false, false), 't')).resolves.toBeUndefined()
  })
  it('covers shell/computer/browser/file/image/multi-agent surfaces and caps threads (Epoch 14)', async () => {
    for (const name of ['shell_tool', 'computer_use', 'browser_use', 'view_image', 'image_generation', 'multi_agent', 'plugins', 'hooks']) {
      expect(RESTRICTED_FEATURES).toContain(name)
    }
    const b = bridge()
    const result = await researchConfig(b, false)
    expect(result.config['agents.max_threads']).toBe(1)
    for (const name of RESTRICTED_FEATURES) {
      expect(result.config[`features.${name}`]).toBe(false)
    }
    // Isolation is verified through feature/MCP inspection (shell_tool gate),
    // never inferred from a writable temp cwd or a read-only sandbox label.
    expect(result.config.sandbox).toBeUndefined()
  })
})
