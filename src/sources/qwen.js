import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { readJsonl, makeItem, shortCommand, basename } from './common.js';
import { GEMINI_TOOLS } from './gemini.js';

// Qwen Code: <QWEN_HOME|~/.qwen>/projects/<sanitised cwd>/chats/<sessionId>.jsonl,
// subagents under <project>/subagents/<sessionId>/agent-<id>.jsonl.
const ROOT = () => join(process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || join(homedir(), '.qwen'), 'projects');

export function findQwenFiles() {
  const root = ROOT();
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ agent: 'qwen', file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

export async function parseQwen(file) {
  const ctx = {
    agent: 'qwen',
    file,
    id: basename(file).replace(/\.jsonl$/, ''),
    isSubagent: file.includes('/subagents/'),
    cwd: null,
    model: null,
    title: null,
    startedAt: null,
    endedAt: null,
    events: [],
  };
  const calls = new Map();
  const seen = new Set();

  for await (const r of readJsonl(file)) {
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    if (r.timestamp) {
      ctx.startedAt ??= r.timestamp;
      ctx.endedAt = r.timestamp;
    }
    ctx.cwd ??= r.cwd || null;
    if (r.isSidechain) ctx.isSubagent = true;

    if (r.type === 'system') {
      if (r.subtype === 'chat_compression') {
        ctx.events.push({ t: 'compact' });
        ctx.events.push(makeItem(r.systemPayload?.compressedHistory ?? r.systemPayload?.info ?? '', { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
      } else if (r.subtype === 'custom_title') ctx.title = r.systemPayload?.title || r.systemPayload?.info || ctx.title;
      continue;
    }
    const parts = r.message?.parts || [];

    if (r.type === 'assistant') {
      ctx.model = r.model || ctx.model;
      const u = r.usageMetadata;
      if (u && u.promptTokenCount) {
        const cached = u.cachedContentTokenCount || 0;
        ctx.events.push({ t: 'request', contextTokens: u.promptTokenCount, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), input: u.promptTokenCount - cached, cacheRead: cached, cacheWrite: 0 });
      }
      for (const p of parts) {
        if (p.functionCall) {
          const { id, name, args } = p.functionCall;
          const cls = classifyTool(GEMINI_TOOLS[name] || name, args);
          const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : name;
          calls.set(id, { ...cls, label });
          ctx.events.push(makeItem(args, { ...cls, role: 'tool_call', label }));
        } else if (p.text) {
          ctx.events.push(p.thought ? makeItem(p.text, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }) : makeItem(p.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
        }
      }
    } else if (r.type === 'tool_result' || r.type === 'user') {
      for (const p of parts) {
        if (p.functionResponse) {
          const tool = calls.get(p.functionResponse.id) || { category: 'other', sub: 'tool', label: p.functionResponse.name || 'tool' };
          const resp = p.functionResponse.response;
          const text = typeof resp?.output === 'string' ? resp.output : JSON.stringify(resp ?? '');
          const isError = r.toolCallResult?.status === 'error' || !!resp?.error || (tool.command != null && looksLikeError(text));
          ctx.events.push(makeItem(text, { ...tool, role: 'tool_result', isError }));
        } else if (p.text) {
          ctx.events.push(makeItem(p.text, { category: 'conversation', sub: 'your prompts', role: 'user' }));
        } else if (p.inlineData) {
          ctx.events.push(makeItem('', { category: 'conversation', sub: 'your images', role: 'user', images: 1 }));
        }
      }
    }
  }
  return ctx;
}
