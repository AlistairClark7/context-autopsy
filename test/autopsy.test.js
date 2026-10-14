import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyCommand, classifyTool } from '../src/classify.js';
import { findSecrets } from '../src/secrets.js';
import { shortCommand } from '../src/sources/common.js';
import { parseClaude } from '../src/sources/claude.js';
import { parseCodex } from '../src/sources/codex.js';
import { analyzeContext, aggregate } from '../src/analyze.js';
import { renderShare } from '../src/report/share.js';

const fixtures = new URL('./fixtures/', import.meta.url).pathname;
// Assembled at runtime so no credential-shaped string is committed.
const FAKE_STRIPE = ['sk', 'live', 'Zq8Xw2Lm4Np6Rt1Vb3Yc5Hd7'].join('_');

function claudeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'autopsy-'));
  const file = join(dir, 'claude-session.jsonl');
  writeFileSync(file, readFileSync(join(fixtures, 'claude-session.jsonl'), 'utf8').replace('__FAKE_STRIPE_KEY__', FAKE_STRIPE));
  return file;
}

test('classifies shell commands into groups', () => {
  const cases = {
    'docker compose up -d': 'env',
    'cd web && pnpm install': 'build',
    'cat .env.local': 'env',
    'sed -n 1,40p infra/main.tf': 'env',
    'kubectl logs api-0': 'env',
    'curl -s localhost:3000/health': 'env',
    'go test ./...': 'build',
    'git log --oneline': 'git',
    'cat src/app.ts': 'code_read',
    'rg handler src': 'code_read',
    'curl https://example.com': 'web',
  };
  for (const [cmd, cat] of Object.entries(cases)) assert.equal(classifyCommand(cmd).category, cat, cmd);
});

test('classifies tools, including infra files and JS-wrapped commands', () => {
  assert.equal(classifyTool('Read', { file_path: '/x/Dockerfile' }).category, 'env');
  assert.equal(classifyTool('Read', { file_path: '/x/src/a.ts' }).category, 'code_read');
  assert.equal(classifyTool('Edit', { file_path: '/x/.github/workflows/ci.yml' }).category, 'env');
  assert.equal(classifyTool('exec', 'const r = await tools.exec_command({cmd: "npm test"})').category, 'build');
  assert.equal(classifyTool('mcp__playwright__browser_snapshot', {}).category, 'browser');
});

test('short command labels drop arguments and values', () => {
  assert.equal(shortCommand('cd app && API_KEY=abc npm install --force', 'npm'), 'npm install');
  assert.equal(shortCommand('const r = await tools.exec_command({cmd: "git status"})', 'git'), 'git status');
});

test('finds credentials without returning their values', () => {
  const found = findSecrets(`STRIPE=${FAKE_STRIPE}\nPGPASSWORD=local_dev_pw\nAPI_KEY=your-api-key-here`);
  assert.deepEqual(found.map((s) => s.type), ['Stripe key']);
  assert.ok(!JSON.stringify(found).includes(FAKE_STRIPE));
});

test('analyses a Claude Code session', async () => {
  const r = analyzeContext(await parseClaude(claudeFixture()));
  assert.equal(r.requests, 7);
  assert.ok(r.baseline > 10000, 'hidden system prompt inferred from first request');
  assert.ok(r.totals.build.size > r.totals.code_write.size, 'npm log dwarfs the edit');
  assert.equal(r.errors.count, 1);
  assert.ok(r.duplicates.tokens > 0, 'server.ts read twice');
  assert.deepEqual(r.secrets.map((s) => s.type).sort(), ['Database URL with password', 'Stripe key']);
  const processed = Object.values(r.totals).reduce((a, t) => a + t.processed, 0);
  const actual = 20000 + 21000 + 24000 + 24500 + 25000 + 26000 + 26500;
  assert.ok(Math.abs(processed - actual) / actual < 0.2, `calibrated total ${processed} ≈ ${actual}`);
});

test('analyses a Codex session with compaction', async () => {
  const r = analyzeContext(await parseCodex(join(fixtures, 'rollout-codex-session.jsonl')));
  assert.equal(r.requests, 3, 'duplicate token_count ignored');
  assert.equal(r.compactions, 1);
  assert.ok(r.totals.build.size > 0 && r.totals.env.size > 0);
  assert.equal(r.errors.count, 1);
  assert.ok(r.totals.overhead.subs['system prompt']);
});

test('aggregate + share card contain no paths or secrets', async () => {
  const results = [analyzeContext(await parseClaude(claudeFixture())), analyzeContext(await parseCodex(join(fixtures, 'rollout-codex-session.jsonl')))];
  const report = aggregate(results);
  assert.equal(report.sessions, 2);
  assert.equal(report.secrets.distinct, 2);
  const card = renderShare(report);
  assert.ok(!card.includes('/home/dev'));
  assert.ok(!card.includes(FAKE_STRIPE));
  assert.match(card, /credentials passed through the model/);
});

test('CLI runs on explicit files and emits JSON', () => {
  const bin = new URL('../bin/context-autopsy.js', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [bin, '--json', claudeFixture(), join(fixtures, 'rollout-codex-session.jsonl')], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.deepEqual(report.agents, { claude: 1, codex: 1 });
  assert.ok(!out.includes(FAKE_STRIPE));
});
