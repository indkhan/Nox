# Nox answer quality implementation plan

Status: proposed; implementation has not started.

Goal: Nox understands the request, gathers appropriate evidence, gives a useful supported answer, preserves conversational context, and reports incomplete work honestly.

Implement this as six ordered changes. Keep Codex as the single deciding agent, the native bridge dependency-free, and all Notion operations behind the existing capability, approval, overwrite, rate-limit, and journal gates. Preserve the Web Lock and current limits. Update `docs/application.md` in each change that alters runtime behavior.

**1. Establish protocol fixtures and a quality baseline.**

Primary locations: `extension/tests/codex/`, `extension/tests/agent/`, `scripts/live/codex-smoke.mjs`; add a small local evaluation script and fixture file under `scripts/live/`.

- Identify the binary actually selected by the bridge. Generate its experimental app-server protocol types into a temporary directory and compare the request/event shapes with current official documentation. Record the tested version and compatibility assumptions.
- Add focused regression cases for multiple assistant messages, authoritative completed text, commentary/final phases, actual reasoning-summary events, interrupted/failed turns, and reasoning effort placement. Use representative wire fixtures rather than inventing events to match the client.
- Create about 20 evaluation cases before changing the prompt. Cover simple questions, current-page summaries, long pages, conflicting documents, current web facts, mixed Notion/web recommendations, explicit discussion-only requests, unavailable tools, follow-up questions, and hostile source content.
- Separate deterministic fixtures from opt-in live checks. Live checks use public questions or a dedicated test workspace, create no production workspace changes, and save only local results.
- Record correctness, evidence support, completeness, scope compliance, unnecessary questions/searches, elapsed time, and reported usage. Record the model, effort, search configuration, and prompt revision with each run.

Acceptance: targeted regression cases reproduce the known defects; the baseline evaluation can be repeated without exposing private workspace content. Existing passing tests are retained unless their asserted behavior is demonstrably incorrect.

**2. Correct the Codex turn lifecycle and answer assembly.**

Primary locations: `extension/src/lib/codex/client.ts`, `extension/src/lib/agent/loop.ts`, `extension/src/sidepanel/ChatPanel.tsx`, and the activity/history types they use.

- Track thread, turn, and message IDs. Ignore events belonging to other turns. Account for notifications arriving before the turn-start RPC response.
- Accumulate deltas per message. Treat each completed message as authoritative even if its text is shorter than the streamed text.
- Route commentary to activity and final-answer text to the answer area. For supported versions that omit phases, use the last completed assistant message as the final result; retain earlier messages as activity. Preserve partial text when a turn is interrupted.
- Consume the documented reasoning-summary events for progress. Do not expose raw internal reasoning.
- Read completion status and errors from the actual turn object. Persist completed, interrupted, and failed outcomes distinctly; partial output must not conceal a failure.
- Send reasoning effort using the supported turn-start field. Validate selected effort against model capabilities and use the model's supported default when no explicit choice exists. Keep explicit user choices authoritative.
- Capture the active turn ID and include it in interruption requests. Surface interruption failure; keep the turn unavailable for new work until completion or a controlled disconnect settles it.
- Start cancellation/deadline handling before context preparation and thread setup. Abort pending reads, dismiss approvals, prevent late tool execution, and settle the turn when the bridge disconnects. Do not automatically retry a turn after a potentially executed operation.
- Check initialization, resume, and shutdown against the selected protocol while changing this boundary. Adjust the bridge only when required by a verified mismatch.

Acceptance: progress never contaminates the final answer; corrected completed text wins; selected effort appears in the actual request; stopping during preparation, search, tool execution, and streaming terminates cleanly. Late events cannot modify a subsequent turn. UI and saved history show the same result and status.

**3. Make context complete enough and recovery explicit.**

Primary locations: `extension/src/lib/agent/context.ts`, `panel.ts`, `executor.ts`, `loop.ts`, and `extension/src/lib/history/`.

- Merge current-page metadata and explicit mention content by normalized page ID. Remove duplicate references without removing fetched content. Capture the current page once at send time so tab changes cannot silently change the request's context.
- Label each supplied page as reference-only, fetched, partial, or unavailable. Include truncation metadata rather than silently slicing at 8,000 characters. Bound the combined mention context as well as each individual result.
- Teach Nox to fetch the current page when the question depends on its contents. A title and ID must never count as having read a page.
- Make long-result recovery work beyond the first excerpt. Prefer continuation or targeted retrieval supported by the discovered Notion tools. If they cannot retrieve omitted text, add one bounded, read-only Nox continuation tool over already-fetched text, using opaque handles, offsets, and explicit end markers. Keep it ephemeral and subject to the existing turn/capability limits; do not introduce a persistent search index.
- Route continuation results through the same untrusted-result wrapper. Expired or unavailable handles produce explicit errors. When evidence remains incomplete, the answer must state its scope.
- Classify resume failures. Retry only recoverable connection failures against the same thread. Remove the catch-all transition to a fresh thread. If the original thread cannot be resumed, preserve visible history and show an actionable recovery error rather than continuing with hidden context loss.
- Preserve attachment uploading, but make clear that selected files are upload inputs until content-reading support exists. Do not imply that attachment metadata supplies PDF or image contents.

Acceptance: mentioning the active page retains its content; a long-page fixture can retrieve a decisive fact beyond the initial excerpt; failed fetches are distinguishable from empty pages; a failed resume cannot silently produce a context-free continuation. Recovery never replays mutations.

**4. Configure and expose web research deliberately.**

Primary locations: `extension/src/lib/codex/client.ts`, `extension/src/lib/agent/loop.ts`, `extension/src/lib/settings.ts`, and connection/settings UI as needed.

- Use Codex's built-in search through the native bridge. Apply Nox-specific configuration through verified supported thread/launch overrides, without rewriting the user's global Codex settings.
- Provide a simple web-search enabled/disabled preference. When enabled, request live search so questions requiring current information can be researched. Model instructions determine when a search is useful; enabled does not mean search every turn.
- Inspect effective configuration and managed restrictions. Verify availability with an opt-in public live canary. If live search is unavailable or downgraded, expose the limitation and do not claim that an answer was freshly checked.
- Ensure enabling search does not broaden shell, filesystem, unrelated MCP, or connector access. Verify the effective tool surface: a read-only sandbox alone is not proof that only Nox's intended tools are exposed.
- Audit how native search events interact with existing limits. Preserve the 12-call dynamic-tool ceiling and ten-minute deadline; deduplicate search activity by item ID and interrupt on an observable research-budget boundary. Document any native-tool limit that the protocol cannot enforce before execution instead of claiming that `ToolExecutor` gates native search.
- Propagate cancellation through research. Avoid adding custom search infrastructure, browser automation, or another credential path.

Acceptance: the real bridge can search/open a public current source and return a usable link; disabled search stays unavailable; restrictions are reported honestly; unrelated tool access and Notion write gates remain intact.

**5. Improve answering instructions and the evidence UI.**

Primary locations: `extension/src/lib/agent/instructions.ts`, `notion-architect.ts`, `activity.ts`, `extension/src/lib/markdown.ts`, `extension/src/sidepanel/MessageParts.tsx`, and `ChatPanel.tsx`.

- Rewrite the persona to accurately describe Notion access, optional web research, and current attachment limitations. Build runtime-dependent instructions from current connection/capability state rather than stale initialization values.
- Resolve the conflict between "ask when ambiguous" and "infer harmless details." Ask only when a missing fact materially changes the answer or authorized action. Discussion and research requests do not authorize mutations; Auto mode does not change that.
- Add a compact evidence policy: use workspace sources for workspace facts; use the web for requested research, changing external facts, and material uncertainty; combine them when evaluating the user's situation. Respect requests not to browse.
- For research, open decisive sources, favor relevant primary sources, rephrase unsuccessful searches when useful, compare conflicting evidence, and stop when the question is adequately supported. Keep private workspace details out of unnecessary public search queries.
- Supply the current date/timezone for date-sensitive requests. Distinguish source dates, observed facts, inference, and recommendations. At a limit, state what was established and what remains unverified.
- Lead with the answer or recommendation. Match detail to the user's request. Cite evidence-dependent claims near the supporting text without forcing a citation onto every sentence. Claim a change succeeded only when execution/verification supports it.
- Preserve search item IDs, queries, and available open/find actions in activity. Display concise progress with expandable details. Store only metadata the protocol actually provides; never invent a source list or reconstruct URLs from unsupported citation tokens.
- Use verified Markdown links for web sources. Normalize and validate both dashed and undashed Notion UUIDs and make page links open reliably. Retain DOMPurify sanitization and safe URL handling.

Acceptance: rewrites need no research; current-fact questions search; workspace summaries read the right pages; mixed questions use both evidence sources; discussion-only cases issue zero mutation calls. Source links work, and progress remains separate from the answer after reopening history.

**6. Evaluate, tune, and release.**

- Re-run the baseline cases with the same model and explicit settings. Repeat nondeterministic research cases three times and compare answers side by side. Pin evidence fixtures for reproducibility; judge live answers against sources available at run time rather than stale expected facts.
- Require all deterministic correctness and safety regressions to pass. Across the evaluation set, require zero unauthorized mutations, invented citations, hidden context resets, or partial/failed turns labeled successful.
- Aim for at least 90% of cases to have both a correct answer and sufficient supporting evidence. Manually review every failure. This is a release criterion for the small evaluation set, not a claim about universal accuracy.
- Compare latency by request category. Simple questions should not acquire unnecessary research. Tune effort only after verifying its wiring; retain user overrides and avoid an additional model-based routing call unless measured results justify it.
- Run narrow tests after each change, then `pnpm test`, `pnpm typecheck`, and `pnpm build` from `extension/`. Run `node bridge/test-bridge.mjs` from the repository root for bridge or protocol changes.
- Complete real-Codex smoke checks for search, selected effort, interruption, and a follow-up turn; manually check rendering and history restoration in the side panel. Run any mutation checks only in a dedicated test workspace.
- Update `docs/application.md` and `docs/smoke.md` with actual shipped behavior, supported protocol assumptions, limits, and reproduction steps. Keep changes independently reviewable so a problematic phase can be reverted without weakening safety gates.

Acceptance: recorded test output, before/after evaluation results, and live smoke evidence support the release. Do not mark a capability verified based only on mocks or prompt wording.

Deferred: PDF/image content reading, automatic reconstruction of unrecoverable conversations, persistent semantic memory, additional agents, automatic model routing, and custom search infrastructure. Add these only when the evaluation results or actual usage establish a concrete need. Attachment capability disclosure is included in this plan; broad attachment analysis is not.

Reference points to recheck during implementation: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic), [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices), and [Notion MCP tools](https://developers.notion.com/guides/mcp/mcp-supported-tools). The protocol emitted by the bridge-selected binary is the compatibility reference for Nox; direct Responses API shapes must not be assumed to be app-server shapes.
