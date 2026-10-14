import { tok, int, pct, AGENT_NAME } from './format.js';

export const RUN_COMMAND = 'npx context-autopsy';
export const TWEET_LIMIT = 280;

// ~587k words ≈ 780k tokens.
const WAR_AND_PEACE_TOKENS = 780_000;

/** X/Twitter weighted length: most characters count 1, emoji and CJK count 2. */
export function tweetLength(text) {
  let n = 0;
  for (const ch of text.replace(/[️‍]/g, '')) n += ch.codePointAt(0) <= 0x10ff ? 1 : 2;
  return n;
}

const plural = (n, one, many = one + 's') => `${int(n)} ${n === 1 ? one : many}`;

/**
 * The punchline. Picks the most surprising true statement about this data.
 * Written in the first person because it's meant to be posted as-is.
 */
function headline(r) {
  const code = r.shares.code;
  const plumbing = r.shares.plumbing;
  if (code > 0 && code < 0.5) return `Only ${pct(code)} of it was my actual code.`;
  if (plumbing >= 0.2) return `${pct(plumbing)} of it was build logs and fighting my dev environment.`;
  if (r.secrets.distinct > 0) return `It saw ${plural(r.secrets.distinct, 'of my secrets', 'of my secrets')}.`;
  if (r.shares.overhead >= 0.25) return `${pct(r.shares.overhead)} of it was overhead before I'd typed a word.`;
  return `Here's where ${tok(r.processed)} tokens went.`;
}

/** Supporting stats, most striking first. Each has a score so we keep the best that fit. */
function stats(r) {
  const out = [];
  const add = (score, line) => score > 0 && out.push({ score, line });

  if (r.shares.overhead >= 0.1) add(r.shares.overhead * 3, `📦 ${pct(r.shares.overhead)} was boilerplate, re-read every turn`);
  if (r.shares.plumbing >= 0.05) add(r.shares.plumbing * 12, `🔧 ${pct(r.shares.plumbing)} was build logs & env wrangling`);
  if (r.secrets.distinct > 0) add(2 + Math.min(r.secrets.distinct, 50) / 25, `🔑 It saw ${plural(r.secrets.distinct, 'secret key/password', 'secret keys & passwords')}`);
  const o = r.offenders[0];
  if (o && o.resends >= 20) add(Math.min(2, o.resends / 100), `🔁 Re-read one ${tok(o.tokens)}-token output ${int(o.resends)}×`);
  if (r.errors.count >= 10) add(Math.min(1.8, r.errors.count / 500), `💥 ${int(r.errors.count)} failed commands`);
  if (r.compactedSessions > 0) add(Math.min(1.5, r.compactedSessions / 50), `🧠 Hit its context limit ${plural(r.compactions, 'time')}`);
  if (r.duplicates.tokens >= 100_000) add(0.8, `♻️ ${tok(r.duplicates.tokens)} tokens of copy-pasted duplicates`);
  return out.sort((a, b) => b.score - a.score).map((s) => s.line);
}

function scale(r) {
  const days = r.range.first && r.range.last ? Math.max(1, Math.round((new Date(r.range.last) - new Date(r.range.first)) / 864e5)) : null;
  const books = Math.floor(r.processed / WAR_AND_PEACE_TOKENS);
  const line = `${tok(r.processed)} tokens` + (days ? ` in ${plural(days, 'day')}` : '');
  return books >= 2 ? [line, `(≈${int(books)}× War and Peace)`] : [line];
}

/** "my Claude Code context window", "my Claude Code + Codex context windows", … */
function subject(r) {
  const names = Object.entries(r.agents)
    .sort((a, b) => b[1] - a[1])
    .map(([a]) => AGENT_NAME[a] || a);
  if (names.length === 0) return "my AI coding agent's context window";
  if (names.length === 1) return `my ${names[0]} context window`;
  if (names.length <= 3) return `my ${names.join(' + ')} context windows`;
  return `my ${names.length} AI coding agents' context windows`;
}

/** Builds the post. Drops the weakest stats until it fits in one tweet. */
export function buildCard(r, { limit = TWEET_LIMIT } = {}) {
  const top = [`🩻 I autopsied ${subject(r)}.`, '', headline(r), ''];
  const [scaleLine, books] = scale(r);
  let lines = stats(r).slice(0, 4);
  const compose = (ls, withBooks) => [...top, ...ls, '', withBooks && books ? `${scaleLine} ${books}` : scaleLine, RUN_COMMAND].join('\n');

  let text = compose(lines, true);
  if (tweetLength(text) > limit) text = compose(lines, false);
  while (tweetLength(text) > limit && lines.length > 1) {
    lines = lines.slice(0, -1);
    text = compose(lines, true);
    if (tweetLength(text) > limit) text = compose(lines, false);
  }
  return { text, length: tweetLength(text) };
}

export function tweetIntent(text) {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

export function renderShare(r) {
  const { text } = buildCard(r);
  return text;
}
