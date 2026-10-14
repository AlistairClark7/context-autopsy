import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { estimateTokens } from '../classify.js';
import { findSecrets } from '../secrets.js';

export const IMAGE_TOKENS = 1600;

/** Streams a JSONL file, skipping malformed lines. */
export async function* readJsonl(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* partial line from a live session */
    }
  }
}

/**
 * Builds a context item and throws the raw text away immediately: only sizes,
 * a content hash and secret fingerprints survive.
 */
export function makeItem(text, meta) {
  const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
  const tokens = estimateTokens(s) + (meta.images || 0) * IMAGE_TOKENS;
  return {
    t: 'item',
    category: meta.category,
    sub: meta.sub || meta.category,
    role: meta.role,
    label: meta.label || null,
    tokens,
    isError: !!meta.isError,
    generated: !!meta.generated,
    hash: s.length >= 200 ? createHash('sha1').update(s).digest('hex') : null,
    secrets: meta.scanSecrets === false ? [] : findSecrets(s),
  };
}

const JS_WORDS = new Set(['var', 'let', 'const', 'await', 'return', 'async', 'function', 'new', 'tools', 'if', 'for']);

/** A short, shareable label for a shell command: program + subcommand, no args or values. */
export function shortCommand(cmd, keyword) {
  if (!cmd) return 'shell';
  const segments = String(cmd)
    .replace(/[`'"(){}\[\],]/g, ' ')
    .split(/&&|\|\||;|\n|\|/)
    .map((x) => x.trim())
    .filter(Boolean);
  const seg = (keyword && segments.find((x) => new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(x))) || segments.find((x) => !/^(cd|export|set|source|\.)\b/.test(x)) || segments[0] || '';
  const words = seg.split(/\s+/).filter((w) => /\w/.test(w) && !/^-/.test(w) && !w.includes('=') && !w.includes('$') && w.length < 30 && !JS_WORDS.has(w));
  const kw = keyword ? words.findIndex((w) => w === keyword || w.endsWith('/' + keyword)) : -1;
  const start = kw > 0 ? kw : 0;
  return words.slice(start, start + 2).map((w) => w.replace(/^.*\//, '')).join(' ') || 'shell';
}

export function basename(p) {
  return p ? String(p).replace(/\/+$/, '').split('/').pop() : null;
}

export function contentText(content) {
  if (content == null) return { text: '', images: 0 };
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: 0 };
  let text = '';
  let images = 0;
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'image' || c.type === 'input_image') images++;
    else if (typeof c.text === 'string') text += c.text + '\n';
    else if (typeof c.content === 'string') text += c.content + '\n';
    else text += JSON.stringify(c) + '\n';
  }
  return { text, images };
}
