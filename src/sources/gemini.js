import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { readJsonl, makeItem, shortCommand, basename } from './common.js';

// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl (legacy: one .json per session).
// Subagents live at chats/<parentSessionId>/<childSessionId>.jsonl.
const ROOTS = () => [join(homedir(), '.gemini', 'tmp'), join(homedir(), '.cache', '.gemini', 'tmp')];

export const GEMINI_TOOLS = {
  read_file: 'read',
  read_many_files: 'read',
  write_file: 'write',
  replace: 'edit',
  edit: 'edit',
  run_shell_command: 'bash',
  glob: 'glob',
  search_file_content: 'grep',
  grep: 'grep',
  list_directory: 'ls',
  web_fetch: 'webfetch',
  google_web_search: 'websearch',
  save_memory: 'todowrite',
  write_todos: 'todowrite',
  codebase_investigator: 'task',
};

function projectPaths() {
  const map = {};
  try {
    const { projects } = JSON.parse(readFileSync(join(homedir(), '.gemini', 'projects.json'), 'utf8'));
    for (const [path, slug] of Object.entries(projects || {})) map[slug] = path;
  } catch {}
  return map;
}

export function findGeminiFiles() {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && /\.jsonl?$/.test(e.name) && (depth > 0 || e.name.startsWith('session-'))) out.push({ agent: 'gemini', file: p, mtime: statSync(p).mtimeMs });
    }
  };
  for (const root of ROOTS()) {
    if (!existsSync(root)) continue;
    for (const project of readdirSync(root, { withFileTypes: true })) {
      const chats = join(root, project.name, 'chats');
      if (project.isDirectory() && existsSync(chats)) walk(chats, 0);
    }
  }
  return out;
}

/** Replays the append-only log: later records for the same id replace earlier ones. */
async function loadMessages(file) {
  const order = [];
  const byId = new Map();
  let meta = {};
  if (file.endsWith('.json')) {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    return { meta: rec, messages: rec.messages || [] };
  }
  for await (const r of readJsonl(file)) {
    if (r.sessionId && r.startTime && !r.type) meta = { ...meta, ...r };
    else if (r.$set) {
      meta = { ...meta, ...r.$set };
      if (Array.isArray(r.$set.messages)) {
        order.length = 0;
        byId.clear();
        for (const m of r.$set.messages) (order.push(m.id), byId.set(m.id, m));
      }
    } else if (r.$rewindTo) {
      const i = order.indexOf(r.$rewindTo);
      if (i >= 0) for (const id of order.splice(i)) byId.delete(id);
    } else if (r.$patch) {
      for (const id of r.$patch.removeIds || []) {
        byId.delete(id);
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
      }
    } else if (r.id && r.type) {
      if (!byId.has(r.id)) order.push(r.id);
      byId.set(r.id, r);
    }
  }
  return { meta, messages: order.map((id) => byId.get(id)).filter(Boolean) };
}

function partsText(content) {
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  for (const p of Array.isArray(content) ? content : [content]) {
    if (!p) continue;
    if (typeof p === 'string') text += p + '\n';
    else if (p.text) text += p.text + '\n';
    else if (p.inlineData) images++;
    else if (p.functionResponse) text += JSON.stringify(p.functionResponse.response ?? '') + '\n';
  }
  return { text, images };
}

export async function parseGemini(file) {
  const { meta, messages } = await loadMessages(file);
  const slug = file.split('/chats/')[0].split('/').pop();
  const ctx = {
    agent: 'gemini',
    file,
    id: meta.sessionId || basename(file),
    isSubagent: meta.kind === 'subagent' || /\/chats\/[^/]+\/[^/]+$/.test(file),
    cwd: projectPaths()[slug] || null,
    model: null,
    title: meta.summary || null,
    startedAt: meta.startTime || messages[0]?.timestamp || null,
    endedAt: meta.lastUpdated || messages.at(-1)?.timestamp || null,
    events: [],
  };

  for (const m of messages) {
    if (m.type === 'user') {
      const { text, images } = partsText(m.content);
      ctx.events.push(makeItem(text, { category: 'conversation', sub: 'your prompts', role: 'user', images }));
    } else if (m.type === 'gemini') {
      ctx.model = m.model || ctx.model;
      const t = m.tokens;
      if (t && t.input) ctx.events.push({ t: 'request', contextTokens: t.input, outputTokens: (t.output || 0) + (t.thoughts || 0), input: t.input - (t.cached || 0), cacheRead: t.cached || 0, cacheWrite: 0 });
      for (const th of m.thoughts || []) ctx.events.push(makeItem(`${th.subject || ''}\n${th.description || ''}`, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
      const { text } = partsText(m.content);
      if (text.trim()) ctx.events.push(makeItem(text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
      for (const call of m.toolCalls || []) {
        const cls = classifyTool(GEMINI_TOOLS[call.name] || call.name, call.args);
        const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : call.name;
        ctx.events.push(makeItem(call.args, { ...cls, role: 'tool_call', label }));
        const out = partsText(call.result || '').text || (typeof call.resultDisplay === 'string' ? call.resultDisplay : '');
        const isError = call.status === 'error' || (cls.command != null && looksLikeError(out));
        ctx.events.push(makeItem(out, { ...cls, role: 'tool_result', label, isError }));
      }
    } else if (m.type === 'error') {
      ctx.events.push(makeItem(partsText(m.content).text, { category: 'other', sub: 'agent error', role: 'harness', isError: true }));
    } else {
      ctx.events.push(makeItem(partsText(m.content).text, { category: 'overhead', sub: `${m.type} message`, role: 'harness' }));
    }
  }
  return ctx;
}
