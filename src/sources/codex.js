import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { readJsonl, makeItem, contentText, shortCommand, basename } from './common.js';

export const CODEX_ROOT = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

export function findCodexFiles(root = CODEX_ROOT) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ agent: 'codex', file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root);
  return out;
}

// Harness-injected "user" messages are XML-ish blocks; real prompts rarely start with a tag.
const INJECTED = /^\s*(<[a-z_]+[\s>]|# AGENTS\.md|<INSTRUCTIONS>)/i;

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw || {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function parseCodex(file) {
  const ctx = {
    agent: 'codex',
    file,
    id: basename(file).replace(/\.jsonl$/, ''),
    isSubagent: false,
    cwd: null,
    model: null,
    title: null,
    startedAt: null,
    endedAt: null,
    events: [],
  };
  const calls = new Map();
  let lastTotal = null;

  for await (const d of readJsonl(file)) {
    if (d.timestamp) {
      ctx.startedAt ??= d.timestamp;
      ctx.endedAt = d.timestamp;
    }
    const p = d.payload && typeof d.payload === 'object' ? d.payload : null;

    if (d.type === 'session_meta' && p) {
      ctx.cwd = p.cwd || ctx.cwd;
      ctx.isSubagent = !!p.parent_thread_id || (typeof p.source === 'object' && p.source && 'subagent' in p.source);
      const base = typeof p.base_instructions === 'string' ? p.base_instructions : p.base_instructions?.text;
      if (base) ctx.events.push(makeItem(base, { category: 'overhead', sub: 'system prompt', role: 'harness', scanSecrets: false }));
      continue;
    }
    if (d.type === 'turn_context' && p) {
      ctx.model = p.model || ctx.model;
      continue;
    }
    if (d.type === 'compacted') {
      ctx.events.push({ t: 'compact' });
      const carried = p?.replacement_history ?? p?.message ?? '';
      ctx.events.push(makeItem(carried, { category: 'overhead', sub: 'compaction carry-over', role: 'harness', scanSecrets: false }));
      continue;
    }
    if (d.type === 'event_msg' && p?.type === 'token_count' && p.info?.last_token_usage) {
      const total = p.info.total_token_usage?.total_tokens;
      if (total != null && total === lastTotal) continue;
      lastTotal = total;
      const u = p.info.last_token_usage;
      const cached = u.cached_input_tokens || 0;
      ctx.events.push({
        t: 'request',
        contextTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        input: (u.input_tokens || 0) - cached,
        cacheRead: cached,
        cacheWrite: u.cache_write_input_tokens || 0,
      });
      continue;
    }
    if (d.type !== 'response_item' || !p) continue;

    switch (p.type) {
      case 'message': {
        const { text, images } = contentText(p.content);
        if (p.role === 'assistant') ctx.events.push(makeItem(text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
        else if (p.role === 'developer' || p.role === 'system') ctx.events.push(makeItem(text, { category: 'overhead', sub: 'developer instructions', role: 'harness', images }));
        else {
          // One user message can mix injected blocks and the actual prompt.
          for (const c of Array.isArray(p.content) ? p.content : [{ text }]) {
            if (c.type === 'input_image') ctx.events.push(makeItem('', { category: 'conversation', sub: 'your images', role: 'user', images: 1 }));
            else if (INJECTED.test(c.text || '')) ctx.events.push(makeItem(c.text, { category: 'overhead', sub: 'injected context', role: 'harness' }));
            else ctx.events.push(makeItem(c.text, { category: 'conversation', sub: 'your prompts', role: 'user' }));
          }
        }
        break;
      }
      case 'reasoning': {
        const summary = (p.summary || []).map((s) => s.text || '').join('\n');
        const item = makeItem(summary, { category: 'thinking', sub: 'reasoning', role: 'assistant', scanSecrets: false });
        // Encrypted reasoning is carried forward in context; approximate its size.
        if (p.encrypted_content) item.tokens += Math.round(p.encrypted_content.length / 6);
        ctx.events.push(item);
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const input = p.type === 'function_call' ? parseArgs(p.arguments) : p.type === 'local_shell_call' ? p.action : p.input;
        const name = p.type === 'local_shell_call' ? 'local_shell' : p.name;
        const cls = classifyTool(name, input, p.namespace);
        const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.label || (cls.path ? basename(cls.path) : name);
        calls.set(p.call_id, { ...cls, label });
        ctx.events.push(makeItem(input, { ...cls, role: 'tool_call', label }));
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const tool = calls.get(p.call_id) || { category: 'other', sub: 'tool', label: 'tool' };
        const out = typeof p.output === 'object' && p.output && !Array.isArray(p.output) ? p.output.content ?? p.output : p.output;
        const { text, images } = contentText(out);
        const isError = tool.command != null || tool.category === 'build' ? looksLikeError(text) : false;
        ctx.events.push(makeItem(text, { ...tool, role: 'tool_result', images, isError }));
        break;
      }
      case 'web_search_call':
        ctx.events.push(makeItem(p.action || p, { category: 'web', sub: 'web search', role: 'tool_call', label: 'web search' }));
        break;
      case 'compaction':
        ctx.events.push({ t: 'compact' });
        break;
    }
  }
  return ctx;
}
