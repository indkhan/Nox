// Spike 0.1 (server half) — what does this workspace actually give us?
// Tools, identity, plan capabilities, and the view DSL spec we plan to hand the model.
// Run: node spikes/notion-probe.mjs
import { connect, listTools, listResources, readResource, callTool } from './notion-mcp.mjs';

const line = (s) => console.log(s);

const { init } = await connect();
line(`\n✔ initialize → ${init.serverInfo?.name ?? '?'} ${init.serverInfo?.version ?? ''}`);
line(`  protocol: ${init.protocolVersion}  capabilities: ${Object.keys(init.capabilities ?? {}).join(', ')}`);

const { tools } = await listTools();
line(`\n✔ tools/list → ${tools.length} tools`);
for (const t of tools) line(`   ${t.name}`);

const self = await callTool('notion-fetch', { id: 'self' });
line('\n✔ notion-fetch self →');
line(self.text.slice(0, 1200));

// current_tool_access decides what E7 can even be tested against.
const m = self.text.match(/current_tool_access[\s\S]{0,2000}/);
if (m) {
  line('\n── plan capabilities ──');
  for (const [, tool, state] of m[0].matchAll(/"?([a-z_]+)"?\s*:\s*"(available|available_with_limit|upgrade_required|not_enabled)"/g)) {
    line(`   ${state.padEnd(22)} ${tool}`);
  }
}

try {
  const res = await listResources();
  line(`\n✔ resources/list → ${(res.resources ?? []).length}`);
  for (const r of res.resources ?? []) line(`   ${r.uri}`);
} catch (e) { line(`\n✖ resources/list: ${e.message}`); }

try {
  const dsl = await readResource('notion://docs/view-dsl-spec');
  const body = (dsl.contents ?? []).map((c) => c.text ?? '').join('\n');
  line(`\n✔ view-dsl-spec → ${body.length} chars (${Math.round(body.length / 4)} tokens approx)`);
  line('  first 400 chars:\n' + body.slice(0, 400));
} catch (e) { line(`\n✖ view-dsl-spec: ${e.message}`); }
