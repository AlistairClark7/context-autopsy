import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { readJsonl, makeItem, contentText, shortCommand, basename } from './common.js';

export const CLAUDE_ROOT = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Finds main-session and subagent transcripts under ~/.claude/projects. */
export function findClaudeFiles(root = CLAUDE_ROOT) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== 'memory' && e.name !== 'tool-results') walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ agent: 'claude', file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

const INJECTED = /^\s*<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|task-notification)/;

const ATTACHMENT_CATEGORY = {
  edited_text_file: 'code_read',
  queued_command: 'conversation',
  diagnostics: 'code_read',
};

export async function parseClaude(file) {
  const ctx = {
    agent: 'claude',
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
  const tools = new Map();
  const requests = new Map();

  for await (const d of readJsonl(file)) {
    if (d.timestamp) {
      ctx.startedAt ??= d.timestamp;
      ctx.endedAt = d.timestamp;
    }
    if (d.cwd && !ctx.cwd) ctx.cwd = d.cwd;
    if (d.type === 'ai-title' || d.type === 'summary') ctx.title = d.aiTitle || d.summary || ctx.title;

    if (d.type === 'system' && /compact/.test(d.subtype || '')) {
      ctx.events.push({ t: 'compact' });
      continue;
    }

    if (d.type === 'attachment' && d.attachment) {
      const a = d.attachment;
      const rendered = Array.isArray(d.rendered) ? contentText(d.rendered).text : a.content ?? a;
      const category = ATTACHMENT_CATEGORY[a.type] || 'overhead';
      ctx.events.push(makeItem(rendered, { category, sub: a.type || 'attachment', role: 'harness', label: a.type }));
      continue;
    }

    const m = d.message;
    if (!m || typeof m !== 'object') continue;

    if (d.type === 'assistant') {
      ctx.model = m.model || ctx.model;
      const rid = m.id || d.requestId || d.uuid;
      const u = m.usage;
      if (!requests.has(rid)) {
        const req = { t: 'request', contextTokens: null, outputTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
        requests.set(rid, req);
        ctx.events.push(req);
      }
      const req = requests.get(rid);
      if (u) {
        req.input = u.input_tokens || 0;
        req.cacheRead = u.cache_read_input_tokens || 0;
        req.cacheWrite = u.cache_creation_input_tokens || 0;
        req.contextTokens = req.input + req.cacheRead + req.cacheWrite;
        req.outputTokens = Math.max(req.outputTokens, u.output_tokens || 0);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text') ctx.events.push(makeItem(b.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') ctx.events.push(makeItem(b.thinking || b.data || '', { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
        else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const cls = classifyTool(b.name, b.input);
          const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.label || (cls.path ? basename(cls.path) : b.name);
          tools.set(b.id, { ...cls, label, name: b.name });
          ctx.events.push(makeItem(b.input, { ...cls, role: 'tool_call', label }));
        }
      }
      continue;
    }

    if (d.type === 'user') {
      if (d.isCompactSummary) {
        ctx.events.push({ t: 'compact' });
        ctx.events.push(makeItem(contentText(m.content).text, { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
        continue;
      }
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const tool = tools.get(b.tool_use_id) || { category: 'other', sub: 'tool', label: 'tool' };
          const { text, images } = contentText(b.content);
          const isError = !!b.is_error || (tool.command != null && looksLikeError(text));
          ctx.events.push(makeItem(text, { ...tool, role: 'tool_result', images, isError }));
        } else if (b.type === 'text') {
          const injected = d.isMeta || INJECTED.test(b.text || '');
          ctx.events.push(makeItem(b.text, injected ? { category: 'overhead', sub: 'injected reminder', role: 'harness' } : { category: 'conversation', sub: 'your prompts', role: 'user' }));
        } else if (b.type === 'image') {
          ctx.events.push(makeItem('', { category: 'conversation', sub: 'your images', role: 'user', images: 1 }));
        } else if (b.type === 'document') {
          ctx.events.push(makeItem(b.source?.data ? '' : b, { category: 'conversation', sub: 'your documents', role: 'user', images: b.source?.data ? 2 : 0 }));
        }
      }
    }
  }
  return ctx;
}
