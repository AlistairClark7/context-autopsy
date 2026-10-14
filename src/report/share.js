import { CATEGORIES } from '../classify.js';
import { tok, int, pct } from './format.js';

const BLOCKS = 20;

/** A plain-text, anonymised card meant to be pasted into a post. No paths, titles or session ids. */
export function renderShare(r) {
  const lines = [];
  const p = (s = '') => lines.push(s);
  const days = r.range.first && r.range.last ? Math.max(1, Math.round((new Date(r.range.last) - new Date(r.range.first)) / 864e5)) : null;

  p(`My coding agents' context, autopsied 🩻`);
  p(`${int(r.sessions)} sessions${days ? ` over ${days} days` : ''} · ${tok(r.processed)} tokens processed`);
  p();
  const cats = Object.entries(r.totals)
    .filter(([, t]) => t.processed / r.processed >= 0.005)
    .sort((a, b) => b[1].processed - a[1].processed)
    .slice(0, 7);
  const width = Math.max(...cats.map(([k]) => CATEGORIES[k].label.length));
  for (const [k, t] of cats) {
    const share = t.processed / r.processed;
    const n = Math.max(1, Math.round(share * BLOCKS));
    p(`${CATEGORIES[k].label.padEnd(width)}  ${'▓'.repeat(n)}${'░'.repeat(BLOCKS - n)} ${pct(share)}`);
  }
  p();
  p(`🔧 ${pct(r.shares.plumbing)} was build logs + environment wrangling`);
  if (r.shares.plumbingPerCodeToken >= 0.1) p(`📉 ${r.shares.plumbingPerCodeToken.toFixed(1)} tokens of plumbing per token of actual code`);
  if (r.errors.count) p(`💥 ${int(r.errors.count)} failed commands (${pct(r.errors.count / Math.max(1, r.errors.toolResults))} of tool calls)`);
  if (r.secrets.distinct) p(`🔑 ${int(r.secrets.distinct)} credentials passed through the model`);
  if (r.baselineMedian) p(`📦 ${tok(r.baselineMedian)} tokens of overhead before the first prompt`);
  if (r.compactedSessions) p(`🧠 ${int(r.compactedSessions)} sessions ran out of room and compacted`);
  p();
  p(`npx context-autopsy`);
  return lines.join('\n');
}
