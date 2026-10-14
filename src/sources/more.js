// Agents with simple, Anthropic-style histories: the Cline SDK, Factory Droid and Amp.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readJsonl, makeItem, basename } from './common.js';
import { anthropicMessageItems, anthropicRequest } from './anthropic.js';

function walkFiles(root, test, maxDepth, agent) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) walk(p, depth + 1);
      else if (e.isFile() && test(e.name)) out.push({ agent, file: p, mtime: statSync(p).mtimeMs });
    }
  };
  walk(root, 0);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const iso = (t) => (t ? new Date(typeof t === 'number' ? t : Date.parse(t)).toISOString() : null);

// ── Cline SDK (Cline 4.1+ SDK mode, Cline CLI 3.x): ~/.cline/data/sessions/<id>/<id>.messages.json
const clineSessions = () => process.env.CLINE_SESSION_DATA_DIR || join(process.env.CLINE_DATA_DIR || join(process.env.CLINE_DIR || join(homedir(), '.cline'), 'data'), 'sessions');

export function findClineSdkFiles() {
  return walkFiles(clineSessions(), (n) => n.endsWith('.messages.json'), 1, 'cline');
}

export async function parseClineSdk(file) {
  const doc = readJson(file) || {};
  const dir = dirname(file);
  const sessionId = basename(dir);
  const manifest = readJson(join(dir, `${sessionId}.json`)) || {};
  const messages = doc.messages || [];
  const ctx = {
    agent: 'cline',
    file,
    id: basename(file).replace(/\.messages\.json$/, ''),
    isSubagent: (doc.agent && doc.agent !== 'lead') || basename(file) !== `${sessionId}.messages.json`,
    cwd: manifest.cwd || manifest.workspace_root || null,
    model: manifest.model || null,
    title: manifest.metadata?.title || null,
    startedAt: iso(manifest.started_at || messages[0]?.ts),
    endedAt: iso(manifest.ended_at || doc.updated_at || messages.at(-1)?.ts),
    events: [],
  };
  if (doc.system_prompt) ctx.events.push(makeItem(doc.system_prompt, { category: 'overhead', sub: 'system prompt', role: 'harness', scanSecrets: false }));
  const calls = new Map();
  for (const m of messages) {
    if (m.metadata?.displayOnly) continue;
    if (m.role === 'assistant') {
      const u = m.metrics;
      // The SDK's inputTokens already includes cached tokens.
      if (u?.inputTokens) ctx.events.push({ t: 'request', contextTokens: u.inputTokens, outputTokens: u.outputTokens || 0, input: u.inputTokens - (u.cacheReadTokens || 0) - (u.cacheWriteTokens || 0), cacheRead: u.cacheReadTokens || 0, cacheWrite: u.cacheWriteTokens || 0 });
    }
    ctx.events.push(...anthropicMessageItems(m, calls));
  }
  return ctx;
}

// ── Factory Droid: ~/.factory/sessions/<cwd>/<id>.jsonl
const factoryRoot = () => join(process.env.FACTORY_HOME_OVERRIDE || join(homedir(), '.factory'), 'sessions');

export function findDroidFiles() {
  return walkFiles(factoryRoot(), (n) => n.endsWith('.jsonl'), 1, 'droid');
}

export async function parseDroid(file) {
  const ctx = { agent: 'droid', file, id: basename(file).replace(/\.jsonl$/, ''), isSubagent: false, cwd: null, model: null, title: null, startedAt: null, endedAt: null, events: [] };
  const calls = new Map();
  const requests = new Map();
  const seenContent = new Set();
  for await (const r of readJsonl(file)) {
    if (r.timestamp) {
      ctx.startedAt ??= r.timestamp;
      ctx.endedAt = r.timestamp;
    }
    if (r.type === 'session_start') {
      ctx.cwd = r.cwd || ctx.cwd;
      ctx.title = r.title || ctx.title;
      ctx.isSubagent = !!(r.callingSessionId || r.callingToolUseId);
      continue;
    }
    const m = r.message;
    if (r.type !== 'message' || !m) continue;
    if (m.role === 'assistant') {
      // Streaming writes several rows per message id; usage only grows.
      const key = m.id || r.id;
      const req = anthropicRequest(m.usage);
      if (req && !requests.has(key)) {
        requests.set(key, req);
        ctx.events.push(req);
      } else if (req) Object.assign(requests.get(key), req, { outputTokens: Math.max(requests.get(key).outputTokens, req.outputTokens) });
      if (seenContent.has(key)) continue;
      seenContent.add(key);
    }
    ctx.events.push(...anthropicMessageItems(m, calls));
  }
  return ctx;
}

// ── Amp: ~/.local/share/amp/threads/T-<uuid>.json
const ampRoot = () => join(process.env.AMP_DATA_DIR || join(homedir(), '.local', 'share', 'amp'), 'threads');

export function findAmpFiles() {
  return walkFiles(ampRoot(), (n) => /^T-.*\.json$/.test(n), 0, 'amp');
}

export async function parseAmp(file) {
  const t = readJson(file) || {};
  const messages = t.messages || [];
  const ctx = {
    agent: 'amp',
    file,
    id: t.id || basename(file).replace(/\.json$/, ''),
    isSubagent: false,
    cwd: t.env?.initial?.trees?.[0]?.uri?.replace(/^file:\/\//, '') || null,
    model: null,
    title: t.title || null,
    startedAt: iso(t.created || messages[0]?.usage?.timestamp),
    endedAt: iso(messages.at(-1)?.usage?.timestamp || t.created),
    events: [],
  };
  const calls = new Map();
  for (const m of messages) {
    if (m.role === 'assistant') {
      const req = anthropicRequest(m.usage);
      if (req) ctx.events.push(req);
      ctx.model = m.usage?.model || ctx.model;
    }
    ctx.events.push(...anthropicMessageItems(m, calls));
  }
  return ctx;
}
