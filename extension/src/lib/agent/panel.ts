import { bridge, codex } from '../codex/panel'
import { notion } from '../notion/panel'
import { AgentLoop } from './loop'
import { ToolExecutor } from './executor'
import { buildDeveloperInstructions } from './instructions'
import { toDynamicTools } from './dynamic-tools'
import type { CurrentPage } from '../../shared/notion-page'

/** Production assembly: real Notion facade + real Codex client in one loop. */
export const agentLoop = new AgentLoop({
  bridge,
  codex,
  executor: new ToolExecutor({
    callTool: (name, args) => notion.scheduleCallTool(name, args),
    assertToolAllowed: (name) => {
      const verdict = notion.capabilities.can(name)
      if (!verdict.allowed) throw new Error(`"${name}" ${verdict.reason ?? 'is unavailable'}`)
    },
  }),
  getDynamicTools: async () => toDynamicTools(await notion.listTools(), notion.capabilities),
  developerInstructions: buildDeveloperInstructions({
    userName: notion.identity?.userName,
    workspaceName: notion.identity?.workspaceName,
  }),
})

export interface PageWithContext extends CurrentPage {
  markdown?: string
}

/** Fetches current-page content for context injection (best effort). */
export async function fetchCurrentPageContext(page: CurrentPage): Promise<PageWithContext> {
  try {
    const result = await notion.scheduleCallTool('notion-fetch', { id: page.pageId })
    return {
      ...page,
      markdown: result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .slice(0, 8000),
    }
  } catch {
    return page // content is optional context; never block the turn on it
  }
}
