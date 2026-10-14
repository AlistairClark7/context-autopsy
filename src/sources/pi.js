import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { readJsonl, makeItem, contentText, shortCommand, basename } from './common.js';

// Pi: <agentDir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl, a tree of entries linked by parentId.
const AGENT_DIR = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const SESSION_DIR = () => process.env.PI_CODING_AGENT_SESSION_DIR || join(AGENT_DIR(), 'sessions');

export function findPiFiles() {
  const root = SESSION_DIR();
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 1) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ agent: 'pi', file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

const PI_TOOLS = { find: 'glob', ls: 'ls', read: 'read', bash: 'bash', edit: 'edit', write: 'write', grep: 'grep' };

export async function parsePi(file) {
  const entries = [];
  let header = {};
  for await (const r of readJsonl(file)) {
    if (r.type === 'session') header = r;
    else entries.push(r);
  }
  // Abandoned branches stay in the file; only the path from the last entry back to the root was in context.
  let path = entries;
  if (entries.some((e) => e.id)) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    path = [];
    for (let e = entries.at(-1); e; e = e.parentId ? byId.get(e.parentId) : null) path.push(e);
    path.reverse();
  }

  const ctx = {
    agent: 'pi',
    file,
    id: header.id || basename(file),
    isSubagent: false,
    cwd: header.cwd || null,
    model: null,
    title: null,
    startedAt: header.timestamp || path[0]?.timestamp || null,
    endedAt: path.at(-1)?.timestamp || null,
    events: [],
  };
  const calls = new Map();

  for (const e of path) {
    if (e.type === 'session_info' && e.name) ctx.title = e.name;
    if (e.type === 'compaction') {
      ctx.events.push({ t: 'compact' });
      ctx.events.push(makeItem(e.summary, { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
      continue;
    }
    if (e.type === 'branch_summary') ctx.events.push(makeItem(e.summary, { category: 'overhead', sub: 'branch summary', role: 'harness' }));
    if (e.type === 'custom_message') ctx.events.push(makeItem(e.content, { category: 'overhead', sub: 'extension message', role: 'harness' }));
    if (e.type !== 'message' || !e.message) continue;

    const m = e.message;
    if (m.role === 'user') {
      const { text, images } = contentText(m.content);
      ctx.events.push(makeItem(text, { category: 'conversation', sub: 'your prompts', role: 'user', images }));
    } else if (m.role === 'assistant') {
      ctx.model = m.model || ctx.model;
      const u = m.usage;
      if (u && m.stopReason !== 'aborted' && m.stopReason !== 'error' && (u.input || u.cacheRead || u.cacheWrite)) {
        // `output` already includes reasoning; the prompt size excludes output.
        ctx.events.push({ t: 'request', contextTokens: (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), outputTokens: u.output || 0, input: u.input || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 });
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'thinking') ctx.events.push(makeItem(b.thinking || '', { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
        else if (b.type === 'text') ctx.events.push(makeItem(b.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
        else if (b.type === 'toolCall') {
          const cls = classifyTool(PI_TOOLS[b.name] || b.name, b.arguments);
          const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : b.name;
          calls.set(b.id, { ...cls, label });
          ctx.events.push(makeItem(b.arguments, { ...cls, role: 'tool_call', label }));
        }
      }
    } else if (m.role === 'toolResult') {
      const tool = calls.get(m.toolCallId) || { category: 'other', sub: 'tool', label: m.toolName || 'tool' };
      const { text, images } = contentText(m.content);
      ctx.events.push(makeItem(text, { ...tool, role: 'tool_result', images, isError: !!m.isError || (tool.command != null && looksLikeError(text)) }));
    } else if (m.role === 'bashExecution' && !m.excludeFromContext) {
      const cls = classifyTool('bash', { command: m.command });
      const label = shortCommand(m.command, cls.keyword);
      ctx.events.push(makeItem(`${m.command}\n${m.output || ''}`, { ...cls, role: 'tool_result', label, isError: m.exitCode != null && m.exitCode !== 0 }));
    } else if (m.role === 'system' || m.role === 'custom') {
      ctx.events.push(makeItem(contentText(m.content).text, { category: 'overhead', sub: `${m.role} message`, role: 'harness' }));
    }
  }
  return ctx;
}
