---
name: context-autopsy
description: Analyse what is filling this machine's coding-agent context windows (Claude Code and Codex transcripts), grouped into code, build/test output, environment & infrastructure wrangling, errors, overhead, duplicates and leaked credentials. Use when the user asks where their tokens or context go, why sessions compact or get slow, what their agent wastes context on, or wants a context/token audit.
---

# Context autopsy

Run the analyser, read its JSON, and explain the results in plain language.

## 1. Run it

```bash
npx -y github:AlistairClark7/context-autopsy --json --since 30d > "${TMPDIR:-/tmp}/context-autopsy.json"
```

Adjust the flags to the user's question:

- A single project: add `--project <part of the path>`.
- Only this agent: add `--agent claude` or `--agent codex`.
- Just the most recent work: add `--last 10` (or replace `--since`).
- A specific transcript: pass its `.jsonl` path as an argument.

If the user wants to see the visual report themselves, tell them to run `npx -y github:AlistairClark7/context-autopsy --detail` in their terminal. The output uses colour and is wide.

## 2. Read the JSON

Key fields:

- `totals.<category>.processed`: tokens × the number of model calls that content stayed in context. This is the real cost, because everything is re-sent on every call. `size` is the tokens added. `subs` breaks each category down.
- Categories: `overhead`, `conversation`, `thinking`, `code_read`, `code_write`, `build`, `env`, `git`, `web`, `browser`, `agents`, `other`.
- `shares.plumbing`: share of processed tokens that went to `build` + `env`. `shares.plumbingPerCodeToken` compares that to reading and writing code.
- `baselineMedian`: tokens in context before the first prompt (system prompt, tool schemas, injected instructions).
- `errors`, `duplicates`, `generatedTokens` (lockfiles, build artefacts), `compactions` / `compactedSessions`.
- `secrets`: distinct credentials seen, by type. Values are never included. Do not try to find them in the transcripts.
- `offenders`: the single tool outputs that cost the most processed tokens. `peak`: the composition of the fullest context.
- `worstSessions`: the sessions with the highest plumbing share.

## 3. Report back

Lead with the three or four most striking numbers, phrased concretely. For example: "38% of everything your agent processed was build and environment output", or "a single 14k-token `pnpm install` log was re-sent 212 times". Then give a short breakdown table of the top categories by processed share.

Finish with specific, practical suggestions tied to what you found. For example:

- **Large build or test logs**: pipe through `tail -n 50`, use quiet or `--silent` flags, or summarise failures only.
- **Environment & infra churn**: script the setup, keep a working dev environment, so the agent stops rediscovering ports, containers and env vars every session.
- **Credentials in context**: name the types found and recommend rotating them. Keep secrets out of files the agent reads, for example `.env` files, `env` and `printenv`, or `kubectl get secret`.
- **High fixed overhead**: prune unused MCP servers, tools, skills and long instruction files.
- **Duplicates and generated files**: avoid re-reading unchanged files and reading lockfiles or `dist/`.
- **Frequent compaction**: start fresh sessions per task and offload noisy work to subagents.

Everything runs locally. Nothing is uploaded.
