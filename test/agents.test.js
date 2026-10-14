import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePi } from '../src/sources/pi.js';
import { parseGemini } from '../src/sources/gemini.js';
import { parseQwen } from '../src/sources/qwen.js';
import { parseCline } from '../src/sources/cline.js';
import { parseOpenCode } from '../src/sources/opencode.js';
import { parseCursor, findCursorFiles } from '../src/sources/cursor.js';
import { analyzeContext } from '../src/analyze.js';

const fx = (p) => new URL(`./fixtures/${p}`, import.meta.url).pathname;
const run = async (parse, file, ...rest) => analyzeContext(await parse(file, ...rest));

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {}

test('Pi: follows the active branch, links tool results, compacts', async () => {
  const r = await run(parsePi, fx('pi/2026-10-01T10-00-00-000Z_0199e6a0.jsonl'));
  assert.equal(r.cwd, '/home/dev/pi-app');
  assert.equal(r.requests, 2, 'abandoned branch request ignored');
  assert.equal(r.compactions, 1);
  assert.ok(r.totals.build.size > 0, 'npm install output classified as build');
  assert.ok(!r.totals.conversation.subs['assistant reply'] || r.totals.conversation.subs['assistant reply'].size < 100, 'abandoned text excluded');
});

test('Gemini CLI: last record per id wins, rewinds drop messages', async () => {
  const r = await run(parseGemini, fx('gemini/chats/session-2026-10-01T10-00-abcd1234.jsonl'));
  assert.equal(r.requests, 2);
  assert.equal(r.title, 'Docker port clash');
  assert.equal(r.errors.count, 1);
  assert.ok(r.totals.env.size > 0, 'docker output classified as env');
  assert.ok(r.totals.conversation.size < 200, 'rewound prompt excluded');
});

test('Qwen Code: function calls link to results, compression is a compaction', async () => {
  const r = await run(parseQwen, fx('qwen/chats/q1.jsonl'));
  assert.equal(r.cwd, '/home/dev/q');
  assert.equal(r.requests, 2);
  assert.equal(r.compactions, 1);
  assert.ok(r.totals.env.size > 0, 'Dockerfile read classified as env');
  assert.ok(r.totals.thinking.size > 0);
});

test('Cline family: XML tool calls, environment details, ui_messages usage', async () => {
  const r = await run(parseCline, fx('cline/task1/api_conversation_history.json'), 'roo');
  assert.equal(r.agent, 'roo');
  assert.equal(r.cwd, '/home/dev/cline-app');
  assert.equal(r.requests, 3);
  assert.ok(r.totals.build.size > 0, 'npm test output classified as build');
  assert.equal(r.errors.count, 1);
  assert.ok(r.totals.code_read.size > 0, 'read_file result classified as code');
  assert.ok(r.totals.overhead.subs['environment details']);
  assert.ok(r.totals.thinking.size > 0);
});

test('OpenCode (JSON storage): step-finish usage, tool parts', async () => {
  const r = await run(parseOpenCode, fx('opencode/storage/session/proj1/ses_1.json'));
  assert.equal(r.title, 'Fix build');
  assert.equal(r.requests, 2);
  assert.ok(r.totals.build.size > 0, 'cargo build output classified as build');
  assert.equal(r.errors.count, 1);
});

test('OpenCode (SQLite v2): one row per step, compaction rows', { skip: !sqlite && 'node:sqlite unavailable' }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oc-')), 'opencode.db');
  const db = new sqlite.DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('ses_2', null, '/home/dev/oc2', 'Deploy', 1759312800000, 1759312900000);
  const rows = [
    ['user', { text: 'deploy it' }],
    ['assistant', { tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 0, write: 9000 } }, content: [{ type: 'tool', id: 't', name: 'bash', state: { status: 'completed', input: { command: 'kubectl apply -f k8s/' }, content: [{ type: 'text', text: 'deployment.apps/api configured\n'.repeat(40) }] } }] }],
    ['compaction', { status: 'completed', summary: 'Deployed.', recent: '' }],
    ['assistant', { tokens: { input: 5, output: 10, reasoning: 0, cache: { read: 2000, write: 0 } }, content: [{ type: 'text', text: 'Deployed.' }] }],
  ];
  rows.forEach(([type, data], i) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run(`m${i}`, 'ses_2', type, i, JSON.stringify(data)));
  db.close();
  const r = await run(parseOpenCode, `${path}#v2:ses_2`);
  assert.equal(r.cwd, '/home/dev/oc2');
  assert.equal(r.requests, 2);
  assert.equal(r.compactions, 1);
  assert.ok(r.totals.env.size > 0, 'kubectl classified as env');
});

test('Cursor: bubbles from state.vscdb, tool calls, context snapshots', { skip: !sqlite && 'node:sqlite unavailable' }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cursor-')), 'state.vscdb');
  const db = new sqlite.DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, JSON.stringify(v));
  put('composerData:C1', { _v: 16, composerId: 'C1', name: 'Fix tests', createdAt: 1, fullConversationHeadersOnly: [{ bubbleId: 'B1', type: 1 }, { bubbleId: 'B2', type: 2 }, { bubbleId: 'B3', type: 2 }], workspaceIdentifier: { uri: { fsPath: '/home/dev/cur' } } });
  put('bubbleId:C1:B1', { type: 1, text: 'fix the tests', createdAt: '2026-10-01T10:00:00.000Z', contextWindowStatusAtCreation: { tokensUsed: 15000, tokenLimit: 200000 } });
  put('bubbleId:C1:B2', { type: 2, text: '', createdAt: '2026-10-01T10:00:01.000Z', toolFormerData: { tool: 15, name: 'run_terminal_command_v2', status: 'error', params: JSON.stringify({ command: 'pnpm test' }), result: JSON.stringify({ output: 'FAIL a.test.ts\n'.repeat(50), exitCode: 1 }) } });
  put('bubbleId:C1:B3', { type: 2, text: 'One test fails.', createdAt: '2026-10-01T10:00:02.000Z' });
  db.close();
  const r = await run(parseCursor, `${path}#C1`);
  assert.equal(r.cwd, '/home/dev/cur');
  assert.equal(r.title, 'Fix tests');
  assert.equal(r.requests, 2);
  assert.ok(r.baseline > 10000, 'baseline from the context snapshot');
  assert.ok(r.totals.build.size > 0);
  assert.equal(r.errors.count, 1);
  assert.ok(Array.isArray(await findCursorFiles()));
});

import { writeFileSync, mkdirSync } from 'node:fs';
import { parseClineSdk, parseDroid, parseAmp } from '../src/sources/more.js';
import { parseGoose } from '../src/sources/goose.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const LOG = 'npm WARN deprecated x\n'.repeat(200);

test('Cline SDK: messages.json with metrics and manifest cwd', async () => {
  const dir = join(tmp('cline'), 'sess1');
  mkdirSync(dir);
  writeFileSync(join(dir, 'sess1.json'), JSON.stringify({ session_id: 'sess1', cwd: '/home/dev/cl', metadata: { title: 'Install' } }));
  writeFileSync(join(dir, 'sess1.messages.json'), JSON.stringify({ agent: 'lead', system_prompt: 'You are Cline. '.repeat(500), messages: [
    { role: 'user', content: 'install deps', ts: 1 },
    { role: 'assistant', ts: 2, metrics: { inputTokens: 9000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 8000 }, content: [{ type: 'tool_use', id: 't1', name: 'run_commands', input: { command: 'pnpm install' } }] },
    { role: 'user', ts: 3, content: [{ type: 'tool_result', tool_use_id: 't1', content: LOG }] },
    { role: 'assistant', ts: 4, metrics: { inputTokens: 11000, outputTokens: 10, cacheReadTokens: 9000 }, content: [{ type: 'text', text: 'Installed.' }] },
  ] }));
  const r = analyzeContext(await parseClineSdk(join(dir, 'sess1.messages.json')));
  assert.equal(r.cwd, '/home/dev/cl');
  assert.equal(r.requests, 2);
  assert.ok(r.totals.overhead.subs['system prompt']);
});

test('Factory Droid: streaming rows share a message id', async () => {
  const file = join(tmp('droid'), 's.jsonl');
  const usage = (o) => ({ input_tokens: 10, cache_read_input_tokens: 7000, cache_creation_input_tokens: 100, output_tokens: o });
  const call = { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'docker ps' } }] };
  writeFileSync(file, jsonl([
    { type: 'session_start', cwd: '/home/dev/droid', title: 'Containers' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'what is running' }] } },
    { type: 'message', message: { ...call, usage: usage(5) } },
    { type: 'message', message: { ...call, usage: usage(40) } },
    { type: 'message', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'CONTAINER ID   IMAGE\n'.repeat(30) }] } },
  ]));
  const r = analyzeContext(await parseDroid(file));
  assert.equal(r.requests, 1);
  assert.equal(r.usage.output, 40);
  assert.ok(r.totals.env.size > 0, 'docker classified as env');
});

test('Amp: thread JSON with per-message usage', async () => {
  const file = join(tmp('amp'), 'T-1.json');
  writeFileSync(file, JSON.stringify({ id: 'T-1', title: 'Tests', messages: [
    { role: 'user', content: [{ type: 'text', text: 'run tests' }] },
    { role: 'assistant', usage: { model: 'm', totalInputTokens: 12000, outputTokens: 30 }, content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { cmd: 'go test ./...' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok  pkg 0.1s\n'.repeat(40) }] },
  ] }));
  const r = analyzeContext(await parseAmp(file));
  assert.equal(r.requests, 1);
  assert.ok(r.totals.build.size > 0);
});

test('Goose: sessions.db with usage ledger', { skip: !sqlite && 'node:sqlite unavailable' }, async () => {
  const path = join(tmp('goose'), 'sessions.db');
  const db = new sqlite.DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT, working_dir TEXT, session_type TEXT, name TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE messages (session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER, metadata_json TEXT);
           CREATE TABLE usage_ledger (session_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, is_compaction INTEGER);`);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('g1', '/home/dev/goose', 'user', 'Build', '2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z');
  const msg = (role, content, t) => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('g1', role, JSON.stringify(content), t, '{}');
  msg('user', [{ type: 'text', text: 'build it' }], 1);
  msg('assistant', [{ type: 'toolRequest', id: 'c1', toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command: 'cargo build' } } } }], 2);
  msg('user', [{ type: 'toolResponse', id: 'c1', toolResult: { status: 'success', value: [{ type: 'text', text: 'Compiling foo\n'.repeat(50) }] } }], 3);
  db.prepare('INSERT INTO usage_ledger VALUES (?,?,?,?,?,?)').run('g1', 9000, 30, 0, 0, 0);
  db.close();
  const r = analyzeContext(await parseGoose(`${path}#g1`));
  assert.equal(r.cwd, '/home/dev/goose');
  assert.equal(r.requests, 1);
  assert.ok(r.totals.build.size > 0);
});

test('Kilo Code 7.x: OpenCode-style SQLite (message/part tables)', { skip: !sqlite && 'node:sqlite unavailable' }, async () => {
  const path = join(tmp('kilo'), 'kilo.db');
  const db = new sqlite.DatabaseSync(path);
  db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
           CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('ses_k', null, '/home/dev/kilo', 'Env', 1, 2);
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_k', 1, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses_k', 1, JSON.stringify({ type: 'text', text: 'check env' }));
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'ses_k', 2, JSON.stringify({ role: 'assistant', modelID: 'm' }));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p2', 'm2', 'ses_k', 2, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'printenv' }, output: 'PATH=/usr/bin\n'.repeat(30) } }));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p3', 'm2', 'ses_k', 3, JSON.stringify({ type: 'step-finish', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 6000 } } }));
  db.close();
  const r = analyzeContext(await parseOpenCode(`${path}#v1:ses_k`, 'kilo'));
  assert.equal(r.agent, 'kilo');
  assert.equal(r.requests, 1);
  assert.ok(r.totals.env.size > 0, 'printenv classified as env');
});

test('Roo Code: condense summary and truncation markers', async () => {
  const dir = join(tmp('roo'), 'task');
  mkdirSync(dir);
  writeFileSync(join(dir, 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '<task>go</task>' }], ts: 1, condenseParent: 'c1' },
    { role: 'user', content: '[Sliding window truncation: 3 messages hidden]', isTruncationMarker: true, ts: 2 },
    { role: 'user', content: [{ type: 'text', text: 'Summary of earlier work. '.repeat(40) }], isSummary: true, condenseId: 'c1', ts: 4 },
  ]));
  writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify([
    { ts: 1, type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 16000, tokensOut: 10, cacheReads: 14000, cacheWrites: 500, apiProtocol: 'anthropic' }) },
    { ts: 3, type: 'say', say: 'condense_context' },
  ]));
  const r = analyzeContext(await parseCline(join(dir, 'api_conversation_history.json'), 'roo'));
  assert.equal(r.compactions, 1);
  assert.ok(r.totals.overhead.subs['compaction summary']);
  assert.equal(r.baseline, 16000, 'tokensIn already includes cache, so it is not added twice');
});
