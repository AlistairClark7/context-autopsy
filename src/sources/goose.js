import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { makeItem, shortCommand, basename } from './common.js';
import { openDb, hasTable, parseJson } from './sqlite.js';

// Goose: <data>/sessions/sessions.db with sessions, messages and a per-request usage_ledger.
function dbPaths() {
  const roots = process.env.GOOSE_PATH_ROOT
    ? [join(process.env.GOOSE_PATH_ROOT, 'data')]
    : process.platform === 'win32'
      ? [join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'data')]
      : [join(homedir(), '.local', 'share', 'goose'), join(homedir(), 'Library', 'Application Support', 'Block', 'goose')];
  return roots.map((r) => join(r, 'sessions', 'sessions.db')).filter(existsSync);
}

export async function findGooseFiles() {
  const out = [];
  for (const path of dbPaths()) {
    const db = await openDb(path);
    if (!db || !hasTable(db, 'sessions')) continue;
    for (const s of db.prepare('SELECT * FROM sessions').all()) {
      out.push({ agent: 'goose', file: `${path}#${s.id}`, mtime: Date.parse(s.updated_at || s.created_at || '') || 0 });
    }
  }
  return out;
}

function gooseTool(name = '') {
  const n = name.toLowerCase();
  if (/shell|bash|command/.test(n)) return 'bash';
  if (/text_editor|editor/.test(n)) return 'edit';
  if (/read|view/.test(n)) return 'read';
  if (/search|grep|find|glob|list/.test(n)) return 'grep';
  if (/fetch|web|browse/.test(n)) return 'webfetch';
  if (/subagent|delegate/.test(n)) return 'task';
  if (/todo/.test(n)) return 'todowrite';
  return name.includes('__') ? `mcp__${name}` : name;
}

function resultText(r) {
  const v = r?.value ?? r;
  const items = Array.isArray(v) ? v : Array.isArray(v?.content) ? v.content : [v];
  return items.map((x) => (typeof x === 'string' ? x : x?.text ?? (x ? JSON.stringify(x) : ''))).join('\n');
}

export async function parseGoose(file) {
  const [path, id] = file.split('#');
  const db = await openDb(path);
  if (!db) throw new Error('SQLite unavailable');
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || {};
  const ctx = {
    agent: 'goose',
    file,
    id,
    isSubagent: /sub/.test(s.session_type || ''),
    cwd: s.working_dir || null,
    model: null,
    title: s.name || s.description || null,
    startedAt: s.created_at ? new Date(s.created_at).toISOString() : null,
    endedAt: s.updated_at ? new Date(s.updated_at).toISOString() : null,
    events: [],
  };
  // The ledger has one row per model call, in order; pair them with assistant messages.
  const ledger = hasTable(db, 'usage_ledger') ? db.prepare('SELECT * FROM usage_ledger WHERE session_id = ? AND NOT COALESCE(is_compaction, 0) ORDER BY rowid').all(id) : [];
  let next = 0;
  const calls = new Map();
  for (const row of db.prepare('SELECT role, content_json, metadata_json FROM messages WHERE session_id = ? ORDER BY created_timestamp, rowid').all(id)) {
    const meta = parseJson(row.metadata_json) || {};
    const content = parseJson(row.content_json) || [];
    if (row.role === 'assistant') {
      const u = ledger[next++];
      if (u) {
        const read = u.cache_read_tokens || 0;
        const write = u.cache_write_tokens || 0;
        const input = u.input_tokens || 0;
        ctx.events.push({ t: 'request', contextTokens: input >= read + write ? input : input + read + write, outputTokens: u.output_tokens || 0, input, cacheRead: read, cacheWrite: write });
      } else ctx.events.push({ t: 'request', contextTokens: null, outputTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
    }
    if (meta.agentVisible === false && row.role !== 'assistant') continue;
    for (const c of content) {
      if (c.type === 'text') ctx.events.push(makeItem(c.text, row.role === 'assistant' ? { category: 'conversation', sub: 'assistant reply', role: 'assistant' } : { category: 'conversation', sub: 'your prompts', role: 'user' }));
      else if (c.type === 'thinking' || c.type === 'redactedThinking') ctx.events.push(makeItem(c.thinking || c.data || '', { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
      else if (c.type === 'toolRequest') {
        const call = c.toolCall?.value || c.toolCall || {};
        const cls = classifyTool(gooseTool(call.name), call.arguments);
        const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : call.name;
        calls.set(c.id, { ...cls, label });
        ctx.events.push(makeItem(call.arguments, { ...cls, role: 'tool_call', label }));
      } else if (c.type === 'toolResponse') {
        const tool = calls.get(c.id) || { category: 'other', sub: 'tool', label: 'tool' };
        const text = resultText(c.toolResult);
        ctx.events.push(makeItem(text, { ...tool, role: 'tool_result', isError: c.toolResult?.status === 'error' || (tool.command != null && looksLikeError(text)) }));
      } else if (c.type === 'systemNotification') ctx.events.push(makeItem(c.msg || c, { category: 'overhead', sub: 'system notification', role: 'harness' }));
    }
  }
  return ctx;
}
