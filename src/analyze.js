import { CATEGORIES, PLUMBING } from './classify.js';

const BASELINE_SUB = 'system prompt & tool schemas';

function emptyTotals() {
  return Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { size: 0, processed: 0, count: 0, subs: {} }]));
}

function add(totals, category, sub, size, processed, count = 1) {
  const t = totals[category] || totals.other;
  t.size += size;
  t.processed += processed;
  t.count += count;
  const s = (t.subs[sub] ||= { size: 0, processed: 0, count: 0 });
  s.size += size;
  s.processed += processed;
  s.count += count;
}

/**
 * Walks one context's event stream. Every item stays "live" from the request
 * after it was added until the next compaction (or the end), and is re-sent
 * to the model on every request in between. `processed` = tokens × re-sends.
 */
export function analyzeContext(ctx) {
  const items = [];
  const requests = [];
  let live = [];
  let reqCount = 0;
  let lastCompactAt = -1;
  let compactions = 0;
  const liveByCat = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  let peak = null;
  let startup = null;

  for (const ev of ctx.events) {
    if (ev.t === 'item') {
      ev.start = reqCount;
      ev.end = null;
      items.push(ev);
      live.push(ev);
      liveByCat[ev.category] = (liveByCat[ev.category] || 0) + ev.tokens;
    } else if (ev.t === 'request') {
      ev.index = reqCount++;
      ev.liveEstimate = live.reduce((a, i) => a + i.tokens, 0);
      requests.push(ev);
      if (startup == null && ev.contextTokens != null) startup = { contextTokens: ev.contextTokens, overheadEstimate: liveByCat.overhead, liveEstimate: ev.liveEstimate };
      if (ev.contextTokens != null && (!peak || ev.contextTokens > peak.contextTokens)) {
        peak = { contextTokens: ev.contextTokens, index: ev.index, byCategory: { ...liveByCat } };
      }
    } else if (ev.t === 'compact') {
      if (reqCount === lastCompactAt) continue;
      lastCompactAt = reqCount;
      compactions++;
      for (const i of live) i.end = reqCount;
      live = [];
      for (const k in liveByCat) liveByCat[k] = 0;
    }
  }
  for (const i of live) i.end = reqCount;
  for (const i of items) i.resends = Math.max(0, i.end - i.start);

  // Calibrate: the first request's real size minus what we can see is the
  // hidden baseline (system prompt + tool schemas). Then scale our character
  // estimates so the total matches the tokens the API actually reported.
  const measured = requests.filter((r) => r.contextTokens != null && r.contextTokens > 0);
  const actualProcessed = measured.reduce((a, r) => a + r.contextTokens, 0);
  let baseline = 0;
  let scale = 1;
  if (measured.length) {
    const first = measured[0];
    baseline = Math.max(0, first.contextTokens - first.liveEstimate);
    const itemProcessed = items.reduce((a, i) => a + i.tokens * i.resends, 0);
    const remaining = actualProcessed - baseline * requests.length;
    if (itemProcessed > 0 && remaining > 0) scale = Math.min(2, Math.max(0.5, remaining / itemProcessed));
  }

  // Everything the model had to read before your first prompt mattered:
  // hidden system prompt + tool schemas + injected instructions.
  const startupOverhead = startup ? baseline + Math.round(startup.overheadEstimate * scale) : 0;

  const totals = emptyTotals();
  if (baseline > 0) add(totals, 'overhead', BASELINE_SUB, baseline, baseline * requests.length);

  const seen = new Set();
  const secrets = [];
  const offenders = [];
  let errorCount = 0;
  let errorTokens = 0;
  let errorProcessed = 0;
  let toolResults = 0;
  let streak = 0;
  let longestStreak = 0;
  let dupTokens = 0;
  let dupProcessed = 0;
  let generatedTokens = 0;
  let envCommands = 0;

  for (const i of items) {
    i.tokens = Math.round(i.tokens * scale);
    const processed = i.tokens * i.resends;
    add(totals, i.category, i.sub, i.tokens, processed);

    if (i.role === 'tool_result') {
      toolResults++;
      if (i.isError) {
        errorCount++;
        errorTokens += i.tokens;
        errorProcessed += processed;
        longestStreak = Math.max(longestStreak, ++streak);
      } else streak = 0;
      if (i.category === 'env') envCommands++;
    }
    if (i.hash) {
      if (seen.has(i.hash)) {
        dupTokens += i.tokens;
        dupProcessed += processed;
      } else seen.add(i.hash);
    }
    if (i.generated) generatedTokens += i.tokens;
    for (const s of i.secrets) secrets.push({ ...s, category: i.category, role: i.role });
    if (i.role === 'tool_result' && processed > 0) offenders.push({ category: i.category, sub: i.sub, label: i.label, tokens: i.tokens, resends: i.resends, processed, isError: i.isError });
  }
  offenders.sort((a, b) => b.processed - a.processed);

  if (peak) {
    const visible = Object.values(peak.byCategory).reduce((a, b) => a + b, 0) * scale;
    peak.byCategory = Object.fromEntries(Object.entries(peak.byCategory).map(([k, v]) => [k, v * scale]));
    peak.byCategory.overhead += Math.max(0, peak.contextTokens - visible);
  }

  const usage = requests.reduce(
    (a, r) => ({ input: a.input + (r.input || 0), cacheRead: a.cacheRead + (r.cacheRead || 0), cacheWrite: a.cacheWrite + (r.cacheWrite || 0), output: a.output + (r.outputTokens || 0) }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );

  return {
    agent: ctx.agent,
    id: ctx.id,
    file: ctx.file,
    cwd: ctx.cwd,
    title: ctx.title,
    model: ctx.model,
    isSubagent: ctx.isSubagent,
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    requests: requests.length,
    measured: measured.length > 0,
    baseline,
    startupOverhead,
    compactions,
    totals,
    usage,
    peak,
    errors: { count: errorCount, tokens: errorTokens, processed: errorProcessed, longestStreak, toolResults },
    duplicates: { tokens: dupTokens, processed: dupProcessed },
    generatedTokens,
    envCommands,
    secrets,
    offenders: offenders.slice(0, 10),
  };
}

export function sum(totals, field, keys = Object.keys(totals)) {
  return keys.reduce((a, k) => a + (totals[k]?.[field] || 0), 0);
}

/** Rolls per-context results into the report the CLI prints. */
export function aggregate(results) {
  const totals = emptyTotals();
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const errors = { count: 0, tokens: 0, processed: 0, longestStreak: 0, toolResults: 0 };
  const duplicates = { tokens: 0, processed: 0 };
  const secretMap = new Map();
  let offenders = [];
  let compactions = 0;
  let compactedSessions = 0;
  let generatedTokens = 0;
  let envCommands = 0;
  let requests = 0;
  const baselines = [];
  const agents = {};
  let first = null;
  let last = null;
  let peakCtx = null;

  for (const r of results) {
    agents[r.agent] = (agents[r.agent] || 0) + 1;
    for (const [k, t] of Object.entries(r.totals)) {
      for (const [sub, s] of Object.entries(t.subs)) add(totals, k, sub, s.size, s.processed, s.count);
    }
    for (const k in usage) usage[k] += r.usage[k];
    errors.count += r.errors.count;
    errors.tokens += r.errors.tokens;
    errors.processed += r.errors.processed;
    errors.toolResults += r.errors.toolResults;
    errors.longestStreak = Math.max(errors.longestStreak, r.errors.longestStreak);
    duplicates.tokens += r.duplicates.tokens;
    duplicates.processed += r.duplicates.processed;
    compactions += r.compactions;
    if (r.compactions) compactedSessions++;
    generatedTokens += r.generatedTokens;
    envCommands += r.envCommands;
    requests += r.requests;
    if (r.startupOverhead > 0 && !r.isSubagent) baselines.push(r.startupOverhead);
    for (const s of r.secrets) {
      const e = secretMap.get(s.hash) || { type: s.type, generic: s.generic, occurrences: 0, categories: new Set() };
      e.occurrences++;
      e.categories.add(s.category);
      secretMap.set(s.hash, e);
    }
    offenders.push(...r.offenders.map((o) => ({ ...o, session: r.id, agent: r.agent })));
    if (r.startedAt && (!first || r.startedAt < first)) first = r.startedAt;
    if (r.endedAt && (!last || r.endedAt > last)) last = r.endedAt;
    if (r.peak && (!peakCtx || r.peak.contextTokens > peakCtx.peak.contextTokens)) peakCtx = r;
  }
  offenders.sort((a, b) => b.processed - a.processed);

  const processed = sum(totals, 'processed');
  const size = sum(totals, 'size');
  const plumbing = sum(totals, 'processed', PLUMBING);
  const code = sum(totals, 'processed', ['code_read', 'code_write']);

  const secretTypes = {};
  for (const s of secretMap.values()) {
    const t = (secretTypes[s.type] ||= { distinct: 0, occurrences: 0, generic: s.generic });
    t.distinct++;
    t.occurrences += s.occurrences;
  }

  // Sessions where plumbing ate a big share of the context.
  const heavy = results.filter((r) => {
    const p = sum(r.totals, 'processed');
    return p > 50_000 && sum(r.totals, 'processed', PLUMBING) / p >= 0.3;
  }).length;

  const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

  return {
    sessions: results.length,
    mainSessions: results.filter((r) => !r.isSubagent).length,
    agents,
    range: { first, last },
    requests,
    measured: results.some((r) => r.measured),
    totals,
    processed,
    size,
    usage,
    shares: {
      plumbing: processed ? plumbing / processed : 0,
      code: processed ? code / processed : 0,
      overhead: processed ? totals.overhead.processed / processed : 0,
      plumbingPerCodeToken: code ? plumbing / code : 0,
    },
    heavyPlumbingSessions: heavy,
    errors,
    duplicates,
    generatedTokens,
    envCommands,
    compactions,
    compactedSessions,
    baselineMedian: median(baselines),
    secrets: { distinct: secretMap.size, highConfidence: [...secretMap.values()].filter((s) => !s.generic).length, types: secretTypes },
    offenders: offenders.slice(0, 10),
    peak: peakCtx ? { session: peakCtx.id, agent: peakCtx.agent, title: peakCtx.title, contextTokens: peakCtx.peak.contextTokens, byCategory: peakCtx.peak.byCategory } : null,
    worstSessions: results
      .filter((r) => !r.isSubagent && sum(r.totals, 'processed') > 50_000)
      .map((r) => ({ id: r.id, agent: r.agent, title: r.title, cwd: r.cwd, startedAt: r.startedAt, processed: sum(r.totals, 'processed'), plumbingShare: sum(r.totals, 'processed', PLUMBING) / sum(r.totals, 'processed') }))
      .sort((a, b) => b.plumbingShare * Math.log(b.processed) - a.plumbingShare * Math.log(a.processed))
      .slice(0, 5),
  };
}
