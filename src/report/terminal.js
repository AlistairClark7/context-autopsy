import { CATEGORIES } from '../classify.js';
import { c, CATEGORY_COLOR, tok, int, pct, bar, date, pad } from './format.js';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };

export function headlines(r) {
  const out = [];
  const plumbing = r.totals.build.processed + r.totals.env.processed;
  if (plumbing > 0) {
    out.push([
      `${c.bold(pct(r.shares.plumbing))} of everything your agents processed was build output and environment wrangling.`,
      r.shares.plumbingPerCodeToken >= 0.1 ? `For every token of your actual code, they processed ${c.bold(r.shares.plumbingPerCodeToken.toFixed(1))} tokens of plumbing.` : null,
    ]);
  }
  if (r.totals.env.processed > 0) {
    out.push([
      `${c.bold(int(r.envCommands))} environment & infra operations (docker, cloud CLIs, ports, env vars, config) = ${c.bold(tok(r.totals.env.processed))} tokens processed.`,
      r.heavyPlumbingSessions ? `${r.heavyPlumbingSessions} session${r.heavyPlumbingSessions === 1 ? '' : 's'} spent 30%+ of their context on plumbing.` : null,
    ]);
  }
  if (r.errors.count > 0) {
    out.push([
      `${c.bold(int(r.errors.count))} failed commands and tool calls (${pct(r.errors.count / Math.max(1, r.errors.toolResults))} of all tool calls), ${c.bold(tok(r.errors.processed))} tokens of error output processed.`,
      r.errors.longestStreak > 2 ? `Longest losing streak: ${c.bold(r.errors.longestStreak)} failures in a row.` : null,
    ]);
  }
  if (r.secrets.distinct > 0) {
    const types = Object.entries(r.secrets.types)
      .sort((a, b) => b[1].distinct - a[1].distinct)
      .map(([t, v]) => `${v.distinct} ${t}`)
      .slice(0, 4)
      .join(', ');
    out.push([`${c.red(c.bold(int(r.secrets.distinct)))} credentials passed through the model's context (${types}).`, `They're now in your transcripts and in the provider's request logs.`]);
  }
  if (r.baselineMedian > 0) {
    out.push([`${c.bold(tok(r.baselineMedian))} tokens of system prompt, tool definitions and injected instructions before you type a word (median session).`, `Fixed overhead was ${c.bold(pct(r.shares.overhead))} of everything processed.`]);
  }
  if (r.duplicates.tokens > 0) {
    out.push([`${c.bold(tok(r.duplicates.tokens))} tokens of exact-duplicate output (same file re-read, same command re-run), ${tok(r.duplicates.processed)} processed.`]);
  }
  if (r.generatedTokens > 10_000) {
    out.push([`${c.bold(tok(r.generatedTokens))} tokens of lockfiles, build artefacts and node_modules read into context.`]);
  }
  const o = r.offenders[0];
  if (o && o.resends > 1) {
    out.push([`Most expensive single output: a ${c.bold(tok(o.tokens))}-token \`${o.label}\` result, re-sent ${c.bold(int(o.resends))} times = ${c.bold(tok(o.processed))} tokens.`]);
  }
  if (r.compactions > 0) {
    out.push([`${c.bold(int(r.compactedSessions))} session${r.compactedSessions === 1 ? '' : 's'} filled the window and compacted (${int(r.compactions)} times). Each time, the agent loses its working detail.`]);
  }
  return out;
}

export function renderTerminal(r, opts = {}) {
  const W = Math.min(process.stdout.columns || 100, 110);
  const barW = Math.max(12, W - 62);
  const lines = [];
  const p = (s = '') => lines.push(s);
  const rule = (title) => {
    p();
    p(c.bold(title) + ' ' + c.dim('─'.repeat(Math.max(0, W - title.length - 3))));
  };

  const agents = Object.entries(r.agents)
    .map(([a, n]) => `${n} ${AGENT_NAME[a] || a}`)
    .join(', ');
  p();
  p(`${c.bold('context-autopsy')}  ${c.dim('·')}  ${int(r.sessions)} contexts (${agents})  ${c.dim('·')}  ${date(r.range.first)} – ${date(r.range.last)}`);
  if (r.measured) {
    p(c.dim(`${int(r.requests)} model calls · ${tok(r.processed)} tokens processed · ${tok(r.usage.output)} output tokens · ${pct(r.usage.cacheRead / Math.max(1, r.usage.input + r.usage.cacheRead + r.usage.cacheWrite))} served from cache`));
  }

  rule('WHERE YOUR CONTEXT WENT');
  p(c.dim(pad('', 33) + pad('processed*', 11, true) + pad('share', 8, true) + pad('in context', 12, true)));
  const cats = Object.entries(r.totals)
    .filter(([, t]) => t.processed > 0 || t.size > 0)
    .sort((a, b) => b[1].processed - a[1].processed);
  const max = Math.max(...cats.map(([, t]) => t.processed), 1);
  for (const [k, t] of cats) {
    const color = CATEGORY_COLOR[k];
    p(`${pad(color(CATEGORIES[k].label), 33)}${pad(tok(t.processed), 11, true)}${pad(pct(t.processed / r.processed, 1), 8, true)}${pad(tok(t.size), 12, true)}  ${bar(t.processed / max, barW, color)}`);
    if (opts.detail) {
      const subs = Object.entries(t.subs)
        .sort((a, b) => b[1].processed - a[1].processed)
        .slice(0, 6);
      for (const [s, v] of subs) p(c.dim(`${pad('   ' + s, 33)}${pad(tok(v.processed), 11, true)}${pad(pct(v.processed / r.processed, 1), 8, true)}${pad(tok(v.size), 12, true)}  ×${int(v.count)}`));
    }
  }
  p();
  p(c.dim('* Everything in context is re-sent on every model call until it is compacted.'));
  p(c.dim('  processed = tokens × number of calls it stayed in context. "in context" = tokens added.'));
  if (!opts.detail) p(c.dim('  Run with --detail for sub-categories.'));

  rule('THE HEADLINES');
  for (const [a, b] of headlines(r)) {
    p(`${c.cyan('▸')} ${a}`);
    if (b) p(`  ${c.dim(b)}`);
  }

  if (r.peak && r.peak.contextTokens > 0) {
    rule(`AT PEAK  ${c.dim(`(${tok(r.peak.contextTokens)} tokens in one context${r.peak.title ? ` · "${r.peak.title}"` : ''})`)}`);
    const total = Object.values(r.peak.byCategory).reduce((a, b) => a + b, 0) || 1;
    const segs = Object.entries(r.peak.byCategory)
      .filter(([, v]) => v / total >= 0.01)
      .sort((a, b) => b[1] - a[1]);
    const width = W - 2;
    let line = '';
    for (const [k, v] of segs) line += CATEGORY_COLOR[k]('█'.repeat(Math.max(1, Math.round((v / total) * width))));
    p(line);
    p(segs.map(([k, v]) => `${CATEGORY_COLOR[k]('■')} ${CATEGORIES[k].label} ${pct(v / total)}`).join(c.dim('  ·  ')));
  }

  if (r.offenders.length) {
    rule('MOST EXPENSIVE TOOL OUTPUTS');
    p(c.dim(pad('', 4) + pad('what', 28) + pad('category', 30) + pad('size', 8, true) + pad('re-sent', 10, true) + pad('processed', 12, true)));
    r.offenders.slice(0, opts.top || 8).forEach((o, i) => {
      const color = CATEGORY_COLOR[o.category];
      p(`${pad(c.dim(`${i + 1}.`), 4)}${pad(String(o.label).slice(0, 26) + (o.isError ? c.red(' ✗') : ''), 28)}${pad(color(CATEGORIES[o.category].label), 30)}${pad(tok(o.tokens), 8, true)}${pad('×' + int(o.resends), 10, true)}${pad(tok(o.processed), 12, true)}`);
    });
  }

  if (r.worstSessions.length && !opts.share) {
    rule('SESSIONS MOST BURIED IN PLUMBING');
    for (const s of r.worstSessions) {
      const name = s.title || (s.cwd ? s.cwd.split('/').slice(-2).join('/') : s.id.slice(0, 8));
      p(`${pad(c.red(pct(s.plumbingShare)), 6, true)}  ${pad(String(name).slice(0, W - 40), W - 38)}${c.dim(`${tok(s.processed)} · ${date(s.startedAt)}`)}`);
    }
  }

  p();
  p(c.dim('Everything above was computed locally. Nothing left your machine.'));
  p(c.dim('Share an anonymised summary: npx context-autopsy --share'));
  p();
  return lines.join('\n');
}
