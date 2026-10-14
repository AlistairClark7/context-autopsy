import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyTool, looksLikeError } from '../classify.js';
import { makeItem, contentText, shortCommand, basename } from './common.js';
import { globalStorageDirs } from './vscode.js';

// Cline and its forks (Roo Code, Kilo Code) share one task format:
// tasks/<id>/api_conversation_history.json + ui_messages.json.
export const CLINE_FAMILY = {
  cline: { name: 'Cline', extensions: ['saoudrizwan.claude-dev'], extra: () => [join(process.env.CLINE_DATA_DIR || join(process.env.CLINE_DIR || join(homedir(), '.cline'), 'data'), 'tasks')] },
  roo: { name: 'Roo Code', extensions: ['rooveterinaryinc.roo-cline'] },
  kilo: { name: 'Kilo Code', extensions: ['kilocode.kilo-code'] },
};

export function findClineFiles(agent) {
  const spec = CLINE_FAMILY[agent];
  const roots = [];
  for (const { dir } of globalStorageDirs()) for (const ext of spec.extensions) roots.push(join(dir, ext, 'tasks'));
  if (spec.extra) roots.push(...spec.extra());
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const file = join(root, e.name, 'api_conversation_history.json');
      if (e.isDirectory() && existsSync(file)) out.push({ agent, file, mtime: statSync(file).mtimeMs });
    }
  }
  return out;
}

// Tools are written as XML in the assistant's text. Map them to the shared vocabulary.
const TOOL_MAP = {
  read_file: 'read',
  fetch_instructions: 'read',
  list_files: 'ls',
  search_files: 'grep',
  list_code_definition_names: 'grep',
  codebase_search: 'grep',
  write_to_file: 'write',
  replace_in_file: 'edit',
  apply_diff: 'edit',
  insert_content: 'edit',
  search_and_replace: 'edit',
  edit_file: 'edit',
  execute_command: 'bash',
  browser_action: 'browser_action',
  web_fetch: 'webfetch',
  use_mcp_tool: 'mcp__tool',
  access_mcp_resource: 'mcp__resource',
  new_task: 'task',
  update_todo_list: 'todowrite',
  ask_followup_question: 'askuserquestion',
  attempt_completion: 'attempt_completion',
  switch_mode: 'skill',
  plan_mode_respond: 'attempt_completion',
  new_rule: 'write',
};
const TOOL_TAGS = Object.keys(TOOL_MAP);
const CONVERSATIONAL = new Set(['attempt_completion', 'ask_followup_question', 'plan_mode_respond']);
const TOOL_XML = new RegExp(`<(${TOOL_TAGS.join('|')})>([\\s\\S]*?)(?:</\\1>|$)`, 'g');
const RESULT_HEAD = /^\s*\[([a-z_]+)(?: for [^\]]*)?\](?: Result:)?/;
const CONVERSATION_TAGS = /^\s*<(task|feedback|answer|user_message)>/;

function tagValue(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

// Cline keeps per-task metadata in one index: <storage>/state/taskHistory.json.
const historyIndex = new Map();
function clineHistoryItem(taskDir) {
  const indexFile = join(taskDir, '..', '..', 'state', 'taskHistory.json');
  if (!historyIndex.has(indexFile)) {
    const items = readJson(indexFile);
    historyIndex.set(indexFile, new Map((Array.isArray(items) ? items : []).map((h) => [String(h.id), h])));
  }
  return historyIndex.get(indexFile).get(basename(taskDir));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function parseCline(file, agent = 'cline') {
  const dir = file.replace(/\/api_conversation_history\.json$/, '');
  const history = readJson(file) || [];
  const ui = readJson(join(dir, 'ui_messages.json')) || [];
  const meta = readJson(join(dir, 'history_item.json')) || clineHistoryItem(dir) || {};

  const ctx = {
    agent,
    file,
    id: basename(dir),
    isSubagent: !!meta.parentTaskId,
    cwd: meta.workspace || meta.cwdOnTaskInitialization || null,
    model: null,
    title: typeof meta.task === 'string' ? meta.task.slice(0, 80) : null,
    startedAt: null,
    endedAt: null,
    events: [],
  };

  // Usage lives in ui_messages; content lives in the API history. Merge them by timestamp.
  const timed = [];
  for (const u of ui) {
    if (u.say === 'api_req_started') {
      let info = {};
      try {
        info = JSON.parse(u.text || '{}');
      } catch {}
      if (info.tokensIn == null) continue;
      const cacheRead = info.cacheReads || 0;
      const cacheWrite = info.cacheWrites || 0;
      // tokensIn's meaning varies by provider and version: some include cached
      // tokens (current Roo, OpenAI-style), some don't (Anthropic in Cline, older Roo).
      const cached = cacheRead + cacheWrite;
      const contextTokens = info.tokensIn >= cached && (info.apiProtocol === 'openai' || cached > 0) ? info.tokensIn : info.tokensIn + cached;
      timed.push({ ts: u.ts, order: 0, ev: { t: 'request', contextTokens, outputTokens: info.tokensOut || 0, input: info.tokensIn, cacheRead, cacheWrite } });
    } else if (u.say === 'condense_context' || u.say === 'sliding_window_truncation' || (u.say === 'compaction' && /"completed"/.test(u.text || ''))) {
      timed.push({ ts: u.ts, order: 0, ev: { t: 'compact' } });
    }
  }

  const pending = [];
  const push = (ts, ev) => timed.push({ ts, order: 1, ev });
  for (const m of history) {
    const ts = m.ts || 0;
    if (m.isTruncationMarker) continue;
    if (m.isSummary) {
      push(ts, makeItem(contentText(m.content).text, { category: 'overhead', sub: 'compaction summary', role: 'harness', scanSecrets: false }));
      continue;
    }
    if (m.type === 'reasoning') {
      const item = makeItem((m.summary || []).map((x) => x.text || '').join('\n'), { category: 'thinking', sub: 'reasoning', role: 'assistant', scanSecrets: false });
      if (m.encrypted_content) item.tokens += Math.round(m.encrypted_content.length / 6);
      push(ts, item);
      continue;
    }
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const cls = classifyTool(TOOL_MAP[b.name] || b.name, b.input);
          const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : b.name;
          pending.push({ id: b.id, name: b.name, cls: { ...cls, label } });
          push(ts, makeItem(b.input, { ...cls, role: 'tool_call', label }));
          continue;
        }
        if (b.type === 'reasoning' || b.type === 'thinking') {
          push(ts, makeItem(b.text || b.thinking || '', { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
          continue;
        }
        if (b.type !== 'text') continue;
        let text = b.text || '';
        text = text.replace(/<thinking>([\s\S]*?)(<\/thinking>|$)/g, (_, inner) => {
          push(ts, makeItem(inner, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
          return '';
        });
        text = text.replace(TOOL_XML, (whole, tag, inner) => {
          const input = { path: tagValue(inner, 'path'), command: tagValue(inner, 'command') };
          const cls = CONVERSATIONAL.has(tag)
            ? { category: 'conversation', sub: 'assistant reply' }
            : classifyTool(TOOL_MAP[tag], tag === 'execute_command' ? { command: input.command } : { file_path: input.path });
          const label = cls.command ? shortCommand(cls.command, cls.keyword) : input.path ? basename(input.path) : tag;
          pending.push({ name: tag, cls: { ...cls, label } });
          push(ts, makeItem(whole, { ...cls, role: 'tool_call', label }));
          return '';
        });
        if (text.trim()) push(ts, makeItem(text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
      }
    } else {
      let current = null;
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const i = pending.findIndex((p) => p.id === b.tool_use_id);
          const tool = i >= 0 ? pending.splice(i, 1)[0].cls : { category: 'other', sub: 'tool', label: 'tool' };
          const { text, images } = contentText(b.content);
          push(ts, makeItem(text, { ...tool, role: 'tool_result', images, isError: !!b.is_error || (tool.command != null && looksLikeError(text)) }));
          continue;
        }
        if (b.type === 'image') {
          push(ts, makeItem('', { category: current ? current.category : 'conversation', sub: current ? current.sub : 'your images', role: current ? 'tool_result' : 'user', images: 1 }));
          continue;
        }
        if (b.type !== 'text') continue;
        const text = b.text || '';
        const head = RESULT_HEAD.exec(text);
        if (/^\s*<environment_details>/.test(text)) {
          ctx.cwd ??= (/# Current Working Directory \(([^)]+)\)/.exec(text) || [])[1] || null;
          push(ts, makeItem(text, { category: 'overhead', sub: 'environment details', role: 'harness' }));
        } else if (head && TOOL_MAP[head[1]]) {
          const i = pending.findIndex((p) => p.name === head[1]);
          current = i >= 0 ? pending.splice(i, 1)[0].cls : classifyTool(TOOL_MAP[head[1]], {});
          push(ts, makeItem(text, { ...current, role: 'tool_result', isError: /\[ERROR\]|<error/.test(text) || (current.command != null && looksLikeError(text)) }));
        } else if (head && head[1] === 'ERROR') {
          push(ts, makeItem(text, { category: 'other', sub: 'tool error', role: 'tool_result', isError: true }));
        } else if (CONVERSATION_TAGS.test(text) || !current) {
          current = null;
          push(ts, makeItem(text, { category: 'conversation', sub: 'your prompts', role: 'user' }));
        } else {
          // Continuation of the previous tool result (e.g. <files>, <file_write_result>, <error_details>).
          push(ts, makeItem(text, { ...current, role: 'tool_result', isError: /^\s*<error/.test(text) || (current.command != null && looksLikeError(text)) }));
        }
      }
    }
  }

  // Requests sort before content with the same timestamp: the request produced that content.
  timed.sort((a, b) => a.ts - b.ts || a.order - b.order);
  ctx.events = timed.map((x) => x.ev);
  const stamps = timed.map((x) => x.ts).filter(Boolean);
  if (stamps.length) {
    ctx.startedAt = new Date(stamps[0]).toISOString();
    ctx.endedAt = new Date(stamps[stamps.length - 1]).toISOString();
  }
  return ctx;
}
