import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { makeItem, shortCommand, basename } from './common.js';
import { openDb, hasTable, parseJson } from './sqlite.js';

// OpenCode has had three storage generations, and older data is never deleted:
//   A. JSON files under storage/{session,message,part}   (≤ 1.1)
//   B. SQLite tables session/message/part                 (1.2 – 1.18)
//   C. SQLite tables session_v2/session_message           (2.x)
// We read C first, then B, then A, skipping session ids already seen.
// Kilo Code 7.x is an OpenCode fork with the same storage under a different name.
export const OPENCODE_FAMILY = {
  opencode: { app: 'opencode', env: 'OPENCODE_DB' },
  kilo: { app: 'kilo', env: 'KILO_DB' },
};

const dataDir = (app) => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), app);

function dbFiles({ app, env }) {
  const dir = dataDir(app);
  const out = [];
  const override = process.env[env];
  if (override) out.push(override.startsWith('/') ? override : join(dir, override));
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (new RegExp(`^${app}.*\\.db$`).test(f)) out.push(join(dir, f));
  return [...new Set(out)].filter(existsSync);
}

export async function findOpenCodeFiles(agent = 'opencode') {
  const spec = OPENCODE_FAMILY[agent];
  const out = [];
  const seen = new Set();
  for (const path of dbFiles(spec)) {
    const db = await openDb(path);
    if (!db) continue;
    if (hasTable(db, 'session_v2')) {
      for (const s of db.prepare('SELECT id, time_updated FROM session_v2').all()) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({ agent, file: `${path}#v2:${s.id}`, mtime: Number(s.time_updated) || 0 });
      }
    }
    if (hasTable(db, 'session')) {
      for (const s of db.prepare('SELECT id, time_updated FROM session').all()) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({ agent, file: `${path}#v1:${s.id}`, mtime: Number(s.time_updated) || 0 });
      }
    }
  }
  const storage = join(dataDir(spec.app), 'storage', 'session');
  if (existsSync(storage)) {
    for (const project of readdirSync(storage, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const f of readdirSync(join(storage, project.name))) {
        const id = f.replace(/\.json$/, '');
        if (!f.endsWith('.json') || seen.has(id)) continue;
        seen.add(id);
        const file = join(storage, project.name, f);
        out.push({ agent, file, mtime: statSync(file).mtimeMs });
      }
    }
  }
  return out;
}

function newCtx(file, s, agent) {
  return {
    agent,
    file,
    id: s.id,
    isSubagent: !!(s.parent_id || s.parentID),
    cwd: s.directory || null,
    model: null,
    title: s.title || null,
    startedAt: toIso(s.time_created ?? s.time?.created),
    endedAt: toIso(s.time_updated ?? s.time?.updated),
    events: [],
  };
}

function toIso(ms) {
  const n = Number(ms);
  return n ? new Date(n).toISOString() : null;
}

function request(tokens) {
  if (!tokens) return null;
  const read = tokens.cache?.read || 0;
  const write = tokens.cache?.write || 0;
  const contextTokens = (tokens.input || 0) + read + write;
  if (!contextTokens) return null;
  return { t: 'request', contextTokens, outputTokens: (tokens.output || 0) + (tokens.reasoning || 0), input: tokens.input || 0, cacheRead: read, cacheWrite: write };
}

function toolEvents(name, input, output, isError) {
  const cls = classifyTool(name, input);
  const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : name;
  return [makeItem(input, { ...cls, role: 'tool_call', label }), makeItem(output, { ...cls, role: 'tool_result', label, isError: isError || (cls.command != null && looksLikeError(output)) })];
}

function textOf(items) {
  return (items || []).map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
}

/** Generation C: one session_message row per user turn / LLM step. */
function parseV2(db, file, id, agent) {
  const s = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(id) || { id };
  const ctx = newCtx(file, s, agent);
  for (const row of db.prepare('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq').all(id)) {
    const d = parseJson(row.data) || {};
    switch (row.type) {
      case 'user':
        ctx.events.push(makeItem(d.text || '', { category: 'conversation', sub: 'your prompts', role: 'user', images: (d.files || []).filter((f) => /^image\//.test(f.mime || '')).length }));
        break;
      case 'assistant': {
        ctx.model = d.model?.id || ctx.model;
        const req = request(d.tokens);
        if (req) ctx.events.push(req);
        for (const c of d.content || []) {
          if (c.type === 'reasoning') ctx.events.push(makeItem(c.text, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
          else if (c.type === 'text') ctx.events.push(makeItem(c.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
          else if (c.type === 'tool') ctx.events.push(...toolEvents(c.name, c.state?.input, textOf(c.state?.content) || c.state?.error || '', c.state?.status === 'error'));
        }
        break;
      }
      case 'shell':
        ctx.events.push(...toolEvents('bash', { command: d.command }, d.output || '', d.exit != null && d.exit !== 0));
        break;
      case 'compaction':
        if (d.status === 'completed') {
          ctx.events.push({ t: 'compact' });
          ctx.events.push(makeItem(`${d.summary || ''}\n${d.recent || ''}`, { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
        }
        break;
      case 'synthetic':
      case 'system':
      case 'skill':
        ctx.events.push(makeItem(d.text ?? d.content ?? d, { category: 'overhead', sub: `${row.type} message`, role: 'harness' }));
        break;
    }
  }
  return ctx;
}

/** Generations A and B share one message + parts shape. */
function parseMessages(ctx, messages) {
  for (const { info, parts } of messages) {
    if (info.role === 'user') {
      if (parts.some((p) => p.type === 'compaction')) continue;
      for (const p of parts) {
        if (p.type === 'text') ctx.events.push(makeItem(p.text, p.synthetic ? { category: 'overhead', sub: 'injected context', role: 'harness' } : { category: 'conversation', sub: 'your prompts', role: 'user' }));
        else if (p.type === 'file') ctx.events.push(makeItem(/^data:/.test(p.url || '') ? '' : p.url, { category: 'conversation', sub: 'attached files', role: 'user', images: /^image\//.test(p.mime || '') ? 1 : 0 }));
      }
      continue;
    }
    if (info.role !== 'assistant') continue;
    ctx.model = info.modelID || ctx.model;
    if (info.summary) {
      ctx.events.push({ t: 'compact' });
      ctx.events.push(makeItem(parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n'), { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
      continue;
    }
    // Each step's usage arrives at its end, but the request happened before its output.
    const hasSteps = parts.some((p) => p.type === 'step-finish');
    if (!hasSteps) {
      const req = request(info.tokens);
      if (req) ctx.events.push(req);
    }
    let step = [];
    for (const p of parts) {
      if (p.type === 'step-finish') {
        const req = request(p.tokens);
        if (req) ctx.events.push(req);
        ctx.events.push(...step);
        step = [];
      } else if (p.type === 'reasoning') step.push(makeItem(p.text, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
      else if (p.type === 'text') step.push(makeItem(p.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
      else if (p.type === 'tool') {
        const st = p.state || {};
        // Pruned outputs are replaced in context by a placeholder.
        const output = st.time?.compacted ? '[Old tool result content cleared]' : st.output ?? st.error ?? '';
        step.push(...toolEvents(p.tool, st.input, output, st.status === 'error'));
      }
    }
    ctx.events.push(...step);
  }
  return ctx;
}

function parseV1(db, file, id, agent) {
  const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id) || { id };
  const ctx = newCtx(file, s, agent);
  const parts = new Map();
  for (const row of db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(id)) {
    if (!parts.has(row.message_id)) parts.set(row.message_id, []);
    parts.get(row.message_id).push(parseJson(row.data) || {});
  }
  const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id).map((m) => ({ info: parseJson(m.data) || {}, parts: parts.get(m.id) || [] }));
  return parseMessages(ctx, messages);
}

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseJson(readFileSync(join(dir, f), 'utf8')) || {});
}

function parseJsonStorage(file, agent) {
  const s = parseJson(readFileSync(file, 'utf8')) || {};
  const storage = file.split('/session/')[0];
  const ctx = newCtx(file, s, agent);
  const messages = readDir(join(storage, 'message', s.id)).map((info) => ({ info, parts: readDir(join(storage, 'part', info.id)) }));
  messages.sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0));
  return parseMessages(ctx, messages);
}

export async function parseOpenCode(file, agent = 'opencode') {
  const m = /^(.*)#(v1|v2):(.+)$/.exec(file);
  if (!m) return parseJsonStorage(file, agent);
  const db = await openDb(m[1]);
  if (!db) throw new Error('SQLite unavailable');
  return m[2] === 'v2' ? parseV2(db, file, m[3], agent) : parseV1(db, file, m[3], agent);
}
