/**
 * Nox audit: isolated, offline control-flow demonstrations.
 * Reviewed source: indkhan/Nox @ a222ff23b0debd649f70903264af651903f01cc6
 *
 * IMPORTANT: This file does NOT import or run the Nox repository. The pure
 * classification/regex branches are extracted from inspected source, with
 * TypeScript annotations removed. Scheduler and database I/O are reduced to
 * the ordering needed to demonstrate the reviewed race. No Chrome, Notion,
 * Codex, actual IndexedDB, or network behavior is exercised.
 *
 * A passing assertion here means the described BAD behavior is reproduced
 * in the isolated example, not that Nox passes a regression suite.
 * Run: node nox-control-flow-probes.mjs
 */
import assert from 'node:assert/strict';

const observations = [];

// NOX-01: exact relevant branch from writes/classify.ts, types removed.
function classifyUpdatePage(args = {}) {
  const command = args.command ?? args;
  const type = typeof command.type === 'string' ? command.type : '';
  if (/replace_content/i.test(type) || 'replace_content' in args || 'content' in args && type === '') {
    return 'content-replace';
  }
  if (/properties/i.test(type)) return 'properties';
  if (/update_content/i.test(type)) return 'content-update';
  return 'content-replace';
}
assert.equal(classifyUpdatePage({page_id: 'example', command: 'update_content', content_updates: []}), 'content-replace');
assert.equal(classifyUpdatePage({page_id: 'example', command: 'update_properties', properties: {}}), 'content-replace');
assert.equal(classifyUpdatePage({command: {type: 'update_content'}}), 'content-update');
observations.push('NOX-01: string commands fall through to content-replace while the object command is recognized.');

// NOX-08: exact RICH_MARKERS expressions from writes/classify.ts.
const RICH_MARKERS = [
  /synced[_\s-]?block/i,
  /child\s+database/i,
  /\bcolumns?\s*:/i,
  /<empty-block\s*\/>/i,
  /embed/i,
];
const detectRichPage = markdown => RICH_MARKERS.some(re => re.test(markdown));
assert.equal(detectRichPage('<columns>\n<column>\n# A\n</column>\n</columns>'), false);
assert.equal(detectRichPage('<table><tr><td>Important</td></tr></table>'), false);
assert.equal(detectRichPage('<synced_block>Known marker</synced_block>'), true);
observations.push('NOX-08: the rich-page blacklist misses structural columns/table content. This does not itself demonstrate a lossy provider round-trip.');

// NOX-12: preserve the real acquire -> await -> abort -> finally ordering.
// Rate buckets/retries are omitted because the admitted, pre-dispatch case
// never reaches those paths. acquire() reserves synchronously before return.
class AdmittedPath {
  inFlight = 0;
  invocations = 0;
  async acquire() { this.inFlight += 1; }
  release() { this.inFlight -= 1; }
  async schedule(signal) {
    signal.throwIfAborted();
    await this.acquire();
    signal.throwIfAborted(); // Outside release-owning try/finally in source.
    try {
      this.invocations += 1;
      return 'ok';
    } finally {
      this.release();
    }
  }
}
const scheduler = new AdmittedPath();
for (let i = 0; i < 3; i++) {
  const ctrl = new AbortController();
  const pending = scheduler.schedule(ctrl.signal);
  ctrl.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
}
assert.equal(scheduler.inFlight, 3);
assert.equal(scheduler.invocations, 0);
observations.push('NOX-12: three admitted-then-cancelled calls leave three permits reserved despite zero invocations.');

// NOX-18: preserve cache check -> asynchronous precheck -> promise assignment.
// No real IndexedDB behavior is simulated; this demonstrates the duplicate
// opening attempts admitted by the shared JavaScript control flow only.
let cachedOpen = null;
let openAttempts = 0;
async function deletionPrecheck() { await Promise.resolve(); }
async function openLikeReviewedCode() {
  if (cachedOpen) return cachedOpen;
  await deletionPrecheck();
  const connection = {attempt: ++openAttempts};
  const pending = Promise.resolve(connection);
  cachedOpen = pending;
  return await pending;
}
const [first, second] = await Promise.all([openLikeReviewedCode(), openLikeReviewedCode()]);
assert.equal(openAttempts, 2);
assert.notStrictEqual(first, second);
observations.push('NOX-18: simultaneous cold callers create two opening attempts before the cache becomes authoritative.');

console.log('ISOLATED CONTROL-FLOW DEMONSTRATIONS — NOT THE NOX TEST SUITE');
console.log('Runtime: ' + process.version);
for (const observation of observations) console.log('REPRODUCED: ' + observation);
console.log('Total: ' + observations.length + ' expected bad-behavior demonstrations reproduced.');
console.log('No repository build, browser/native-host integration, or authenticated provider test was run.');
