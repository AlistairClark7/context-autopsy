#!/usr/bin/env node
import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findClaudeFiles, parseClaude, CLAUDE_ROOT } from '../src/sources/claude.js';
import { findCodexFiles, parseCodex, CODEX_ROOT } from '../src/sources/codex.js';
import { analyzeContext, aggregate } from '../src/analyze.js';
import { renderTerminal } from '../src/report/terminal.js';
import { renderShare } from '../src/report/share.js';

const HELP = `context-autopsy — find out what's actually filling your coding agent's context window.

Reads Claude Code and Codex transcripts on this machine. Nothing is uploaded.

Usage
  npx context-autopsy [options] [transcript.jsonl | directory ...]

Options
  --agent <claude|codex|all>   Which agent's transcripts to read (default: all)
  --since <7d|2026-09-01>      Only sessions active since this date or age
  --project <text>             Only sessions whose working directory contains <text>
  --last <n>                   Only the n most recent sessions
  --no-subagents               Skip subagent / child-thread transcripts
  --detail                     Show sub-categories
  --top <n>                    Rows in the "most expensive" table (default 8)
  --share                      Print an anonymised summary to paste into a post
  --json                       Machine-readable output
  --no-color                   Disable colours
  -h, --help                   Show this help

Examples
  npx context-autopsy --since 30d
  npx context-autopsy --project my-app --detail
  npx context-autopsy ~/.claude/projects/-Users-me-dev-app/abc123.jsonl
`;

function fail(msg) {
  process.stderr.write(`context-autopsy: ${msg}\n`);
  process.exit(1);
}

function parseSince(s) {
  if (!s) return null;
  const m = /^(\d+)\s*([hdwm])$/.exec(s);
  if (m) return Date.now() - Number(m[1]) * { h: 36e5, d: 864e5, w: 6048e5, m: 2592e6 }[m[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`can't understand --since "${s}". Try 7d, 4w or 2026-09-01.`);
  return t;
}

function detectAgent(file) {
  return /\/\.codex\/|rollout-/.test(file) ? 'codex' : 'claude';
}

function collectExplicit(paths) {
  const out = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) fail(`no such file or directory: ${p}`);
    if (statSync(abs).isDirectory()) {
      const codex = findCodexFiles(abs);
      const claude = findClaudeFiles(abs).filter((f) => !codex.some((x) => x.file === f.file));
      out.push(...codex.map((f) => ({ ...f, agent: detectAgent(f.file) })), ...claude.map((f) => ({ ...f, agent: detectAgent(f.file) })));
    } else out.push({ agent: detectAgent(abs), file: abs, mtime: statSync(abs).mtimeMs });
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        agent: { type: 'string', default: 'all' },
        since: { type: 'string' },
        project: { type: 'string' },
        last: { type: 'string' },
        'no-subagents': { type: 'boolean' },
        detail: { type: 'boolean' },
        top: { type: 'string' },
        share: { type: 'boolean' },
        json: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${e.message}\n\n${HELP}`);
  }
  const o = args.values;
  if (o.help) return void process.stdout.write(HELP);

  let files = args.positionals.length
    ? collectExplicit(args.positionals)
    : [...(o.agent === 'codex' ? [] : findClaudeFiles()), ...(o.agent === 'claude' ? [] : findCodexFiles())];
  if (args.positionals.length && o.agent !== 'all') files = files.filter((f) => f.agent === o.agent);

  const since = parseSince(o.since);
  if (since) files = files.filter((f) => f.mtime >= since);
  files.sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    fail(`no transcripts found. Looked in:\n  ${CLAUDE_ROOT}\n  ${CODEX_ROOT}\nPass a .jsonl file or directory to analyse something else.`);
  }

  const progress = process.stderr.isTTY && !o.json;
  const results = [];
  let done = 0;
  for (const f of files) {
    if (progress && done % 10 === 0) process.stderr.write(`\rReading transcripts… ${done}/${files.length}`);
    done++;
    let ctx;
    try {
      ctx = f.agent === 'codex' ? await parseCodex(f.file) : await parseClaude(f.file);
    } catch (e) {
      if (process.env.DEBUG) process.stderr.write(`\nskipping ${f.file}: ${e.message}\n`);
      continue;
    }
    if (o['no-subagents'] && ctx.isSubagent) continue;
    if (o.project && !(ctx.cwd || '').toLowerCase().includes(o.project.toLowerCase())) continue;
    if (!ctx.events.some((e) => e.t === 'item')) continue;
    results.push(analyzeContext(ctx));
  }
  if (progress) process.stderr.write('\r\x1b[K');

  let chosen = results;
  if (o.last) {
    const n = Number(o.last);
    const main = results.filter((r) => !r.isSubagent).slice(0, n);
    const keep = new Set(main.map((r) => r.file.replace(/\.jsonl$/, '')));
    chosen = results.filter((r) => !r.isSubagent ? keep.has(r.file.replace(/\.jsonl$/, '')) : [...keep].some((k) => r.file.startsWith(k + '/')));
  }
  if (!chosen.length) fail('no sessions matched those filters.');

  const report = aggregate(chosen);
  if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (o.share) process.stdout.write(renderShare(report) + '\n');
  else process.stdout.write(renderTerminal(report, { detail: o.detail, top: o.top ? Number(o.top) : undefined }) + '\n');
}

main().catch((e) => fail(e.stack || e.message));
