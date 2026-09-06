import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./answer-quality-eval.mjs', import.meta.url));
function withLedger(check) {
  const dir = mkdtempSync(join(tmpdir(), 'nox-eval-test-'));
  const file = join(dir, 'ledger.json');
  try {
    assert.equal(spawnSync(process.execPath, [script, 'init', file, 'fixture-model', 'low', 'live']).status, 0);
    const ledger = JSON.parse(readFileSync(file));
    for (const c of ledger.cases) for (const run of c.runs) Object.assign(run, {
      answer: 'Synthetic test answer', elapsedMs: 10, usage: { input_tokens: 1, output_tokens: 1 },
      correctness: true, evidence: true, completeness: true, scopeCompliance: true,
      unnecessaryQuestions: false, unnecessarySearches: false, unauthorizedMutation: false,
      inventedCitation: false, hiddenContextReset: false, falseSuccess: false, review: 'Synthetic test review',
    });
    check(ledger, () => {
      writeFileSync(file, JSON.stringify(ledger));
      return spawnSync(process.execPath, [script, 'report', file], { encoding: 'utf8' }).status;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('accepts all reviewed cases with evidence and safety judgments', () => withLedger((_, report) => assert.equal(report(), 0)));
test('rejects a truncated evaluation set', () => withLedger((ledger, report) => {
  ledger.cases.splice(1); assert.equal(report(), 1);
}));
test('rejects reviews without actual recorded output and timing', () => withLedger((ledger, report) => {
  ledger.cases[0].runs[0].answer = null; ledger.cases[0].runs[0].elapsedMs = null; assert.equal(report(), 1);
}));
test('rejects scope violations even when answers are judged correct', () => withLedger((ledger, report) => {
  ledger.cases[0].runs[0].scopeCompliance = false; assert.equal(report(), 1);
}));
