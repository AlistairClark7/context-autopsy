import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTool, looksLikeError } from '../classify.js';
import { makeItem, shortCommand, basename } from './common.js';
import { globalStorageDirs } from './vscode.js';
import { openDb, hasTable, parseJson } from './sqlite.js';

// Cursor IDE keeps chats in globalStorage/state.vscdb (table cursorDiskKV):
//   composerData:<composerId>             one per chat
//   bubbleId:<composerId>:<bubbleId>      one per message (newer versions)
// Older versions inline the messages in composerData.conversation.

const childIds = new Set();

function dbPath() {
  const g = globalStorageDirs().find((d) => d.app === 'Cursor');
  const p = g && join(g.dir, 'state.vscdb');
  return p && existsSync(p) ? p : null;
}

export async function findCursorFiles() {
  const path = dbPath();
  if (!path) return [];
  const db = await openDb(path);
  if (!db || !hasTable(db, 'cursorDiskKV')) return [];
  const out = [];
  const fallbackMtime = statSync(path).mtimeMs;
  for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
    const c = parseJson(row.value);
    if (!c) continue;
    for (const id of [...(c.subagentComposerIds || []), ...(c.subComposerIds || [])]) childIds.add(id);
    const n = (c.fullConversationHeadersOnly || []).length + (c.conversation || []).length;
    if (!n) continue;
    out.push({ agent: 'cursor', file: `${path}#${c.composerId}`, mtime: c.lastUpdatedAt || c.createdAt || fallbackMtime });
  }
  return out;
}

// Tool names change between versions; the numeric id is stable.
const TOOL_BY_ID = { 15: 'bash', 38: 'edit', 40: 'read', 41: 'grep', 48: 'task', 19: 'mcp__tool' };
const TOOL_BY_NAME = [
  [/terminal|command/, 'bash'],
  [/read_file|read/, 'read'],
  [/edit|write|search_replace|apply_patch|delete_file/, 'edit'],
  [/grep|codebase_search|file_search|list_dir|glob|search/, 'grep'],
  [/web/, 'websearch'],
  [/todo/, 'todowrite'],
  [/task|subagent/, 'task'],
  [/mcp/, 'mcp__tool'],
];

function toolName(t) {
  if (t.name) for (const [re, n] of TOOL_BY_NAME) if (re.test(t.name)) return n;
  return TOOL_BY_ID[t.tool] || t.name || 'tool';
}

function toolInput(t) {
  const p = parseJson(t.params) || parseJson(t.rawArgs) || {};
  return {
    ...p,
    command: p.command,
    file_path: p.targetFile || p.target_file || p.relativeWorkspacePath || p.filePath || p.path,
  };
}

function bubbleTime(b) {
  const t = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) : b.createdAt;
  return Number.isFinite(t) ? t : 0;
}

export async function parseCursor(file) {
  const [path, id] = file.split('#');
  const db = await openDb(path);
  if (!db) throw new Error('SQLite unavailable');
  const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
  const c = parseJson(get.get(`composerData:${id}`)?.value) || {};

  let bubbles = (c.fullConversationHeadersOnly || []).map((h) => parseJson(get.get(`bubbleId:${id}:${h.bubbleId}`)?.value)).filter(Boolean);
  if (!bubbles.length) bubbles = c.conversation || [];
  bubbles.sort((a, b) => bubbleTime(a) - bubbleTime(b));

  const ctx = {
    agent: 'cursor',
    file,
    id,
    isSubagent: childIds.has(id),
    cwd: c.workspaceIdentifier?.uri?.fsPath || c.trackedGitRepos?.[0]?.repoPath || null,
    model: c.modelConfig?.modelName || null,
    title: c.name || null,
    startedAt: bubbles.length ? new Date(bubbleTime(bubbles[0]) || c.createdAt).toISOString() : null,
    endedAt: bubbles.length ? new Date(bubbleTime(bubbles.at(-1)) || c.lastUpdatedAt).toISOString() : null,
    events: [],
  };

  // Cursor doesn't record per-request usage. Each assistant bubble is roughly
  // one model call; the user bubble's context snapshot calibrates the size.
  let lastWasAssistant = false;
  let lastWasTool = false;
  for (const b of bubbles) {
    if (b.type === 1) {
      lastWasAssistant = false;
      lastWasTool = false;
      const attached = [...(b.attachedCodeChunks || []), ...(b.attachedFileCodeChunksMetadataOnly || [])];
      if (attached.length) ctx.events.push(makeItem(attached, { category: 'code_read', sub: 'attached files', role: 'user' }));
      ctx.events.push(makeItem(b.text || '', { category: 'conversation', sub: 'your prompts', role: 'user', images: (b.images || []).length }));
      const used = b.contextWindowStatusAtCreation?.tokensUsed;
      if (used) ctx.events.push({ t: 'snapshot', contextTokens: used });
      continue;
    }
    if (b.type !== 2) continue;
    const t = b.toolFormerData;
    const isTool = t && (t.name || typeof t.tool === 'number');
    // A new model call starts after the user speaks or after a tool result comes back.
    if (!lastWasAssistant || lastWasTool) ctx.events.push({ t: 'request', contextTokens: null, outputTokens: b.tokenCount?.outputTokens || 0, input: 0, cacheRead: 0, cacheWrite: 0 });
    lastWasAssistant = true;
    lastWasTool = !!isTool;
    if (b.modelInfo?.modelName) ctx.model = b.modelInfo.modelName;
    const thinking = b.thinking?.text || (b.allThinkingBlocks || []).map((x) => x.text || '').join('\n');
    if (thinking) ctx.events.push(makeItem(thinking, { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
    if (b.text) ctx.events.push(makeItem(b.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
    if (isTool) {
      const input = toolInput(t);
      const cls = classifyTool(toolName(t), input);
      const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : t.name || 'tool';
      ctx.events.push(makeItem(t.params || t.rawArgs || '', { ...cls, role: 'tool_call', label }));
      const result = typeof t.result === 'string' ? t.result : JSON.stringify(t.result ?? '');
      ctx.events.push(makeItem(result, { ...cls, role: 'tool_result', label, isError: t.status === 'error' || (cls.command != null && looksLikeError(result)) }));
    }
  }
  return ctx;
}
