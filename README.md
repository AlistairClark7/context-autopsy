# context-autopsy 🩻

**Find out what's actually filling your coding agent's context window.**

Your agent has a 200k–1M token window. You'd think most of it is spent on your code. Run this and see what it's really spent on.

```bash
npx github:AlistairClark7/context-autopsy
```

It reads the Claude Code and Codex transcripts already on your machine and breaks every token down by what it was for: reading code, writing code, build and test logs, wrangling Docker, cloud CLIs and env vars, failed commands, fixed overhead, and more.

Everything runs locally. Nothing is uploaded. No dependencies.

---

## What you get

```
WHERE YOUR CONTEXT WENT
                                  processed*   share  in context
Fixed overhead                        412.0M   31.2%        4.1M  ██████████████████████████████
Reading code                          301.7M   22.9%        6.8M  ██████████████████████▏·······
Build, test & run output              188.4M   14.3%        3.2M  ██████████████▋···············
Environment & infrastructure          121.9M    9.2%        2.0M  ███████████▊··················
Reasoning                              96.3M    7.3%        2.9M  █████████▎····················
...

THE HEADLINES
▸ 24% of everything your agents processed was build output and environment wrangling.
  For every token of your actual code, they processed 1.1 tokens of plumbing.
▸ 812 failed commands and tool calls (9% of all tool calls), 41.0M tokens of error output processed.
▸ 14 credentials passed through the model's context (6 Database URL with password, 3 AWS access key, …).
▸ 31k tokens of system prompt, tool definitions and injected instructions before you type a word.
▸ Most expensive single output: a 14k-token `pnpm install` result, re-sent 212 times = 3.0M tokens.
▸ 37 sessions filled the window and compacted. Each time, the agent loses its working detail.
```
<sub>Illustrative output. Yours will differ, which is the point.</sub>

Also shown:

- **At peak**: what your fullest context was made of at the moment it was fullest.
- **Most expensive tool outputs**: the single results that cost you the most.
- **Sessions most buried in plumbing**: the ones where the agent spent its time on setup instead of your feature.

## Why "processed" and not just "size"?

An LLM is stateless. On every turn the **whole** context is sent again, so a 15k-token `npm install` log that lands early in a 200-turn session isn't 15k tokens. It's 15k tokens × every remaining turn, until the session compacts.

`context-autopsy` follows each piece of content from the turn it entered the context to the turn it left. It reports two numbers:

- **in context**: the tokens added.
- **processed**: tokens × the number of model calls they rode along for. This is what drives cost, latency and context rot.

Estimates are calibrated against the real token counts the API reported in each transcript, so the totals add up to what was actually processed. The hidden system prompt and tool schemas are inferred from the size of the first request.

## The groups

| Group | What lands here |
| --- | --- |
| **Fixed overhead** | System prompt, tool and MCP schemas, injected instructions (`CLAUDE.md`, `AGENTS.md`), reminders, compaction summaries |
| **Conversation** | Your prompts and the model's replies |
| **Reasoning** | Thinking and reasoning blocks |
| **Reading code** | File reads, `grep`/`rg`/`find`/`ls`, search results |
| **Writing code** | Edits, patches, new files |
| **Build, test & run output** | `npm`/`pnpm`/`pip`/`cargo`/`go`/`dotnet` installs and builds, test runners, linters, dev servers |
| **Environment & infrastructure** | `docker`, `kubectl`, `helm`, `terraform`, `aws`/`gcloud`/`az`, `ssh`, ports and processes, env vars, `.env`, Dockerfiles, CI and infra config |
| **Git & version control** | `git`, `gh` |
| **Web & docs lookups** | Web search, fetched pages, `curl` |
| **Browser & UI checks** | Playwright, browser and computer-use tools poking at the running app |
| **Subagents & coordination** | Spawning, messaging and waiting on other agents |
| **Other tool output** | MCP tools and everything else |

It also flags cross-cutting waste: **failed commands**, **exact duplicates** (the same file read twice, the same command re-run), **lockfiles and build artefacts** read into context, **compactions**, and **credentials** (AWS, GitHub, Stripe, OpenAI and Anthropic keys, private keys, JWTs, database URLs with passwords, `*_SECRET=` assignments).

Credentials are fingerprinted with a one-way hash so they can be counted. The values are never stored or printed.

## Options

```
npx github:AlistairClark7/context-autopsy [options] [transcript.jsonl | directory ...]

  --agent <claude|codex|all>   Which agent's transcripts to read (default: all)
  --since <7d|2026-09-01>      Only sessions active since this date or age
  --project <text>             Only sessions whose working directory contains <text>
  --last <n>                   Only the n most recent sessions
  --no-subagents               Skip subagent / child-thread transcripts
  --detail                     Show sub-categories (which tools, which commands)
  --top <n>                    Rows in the "most expensive" table
  --share                      Anonymised summary to paste into a post
  --json                       Machine-readable output
```

Transcripts are read from `~/.claude/projects` and `~/.codex/sessions`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected.

## Share yours

```bash
npx github:AlistairClark7/context-autopsy --share
```

```
My coding agents' context, autopsied 🩻
212 sessions over 30 days · 1.3B tokens processed

Fixed overhead                ▓▓▓▓▓▓░░░░░░░░░░░░░░ 31%
Reading code                  ▓▓▓▓▓░░░░░░░░░░░░░░░ 23%
Build, test & run output      ▓▓▓░░░░░░░░░░░░░░░░░ 14%
Environment & infrastructure  ▓▓░░░░░░░░░░░░░░░░░░ 9%

🔧 24% was build logs + environment wrangling
💥 812 failed commands (9% of tool calls)
🔑 14 credentials passed through the model
```

The share card contains no paths, project names, session titles or command arguments.

## Use it from inside Claude Code

Install it as a plugin, then ask "where is my context going?" or run `/context-autopsy`:

```
/plugin marketplace add AlistairClark7/context-autopsy
/plugin install context-autopsy@context-autopsy
```

Or copy [`skills/context-autopsy`](skills/context-autopsy) into `~/.claude/skills/`. The skill runs the analysis, explains the numbers, and suggests fixes specific to what it found.

## Caveats

- Token counts per item are estimated from text length (about 3.8 characters per token), then scaled per session to match the API's reported totals. Category shares are good. Individual items are approximate.
- Category rules are heuristics over tool names, commands and file paths. `--detail` shows exactly what went where. PRs that improve the rules are welcome.
- Transcript formats change between agent versions. If something looks off, run with `DEBUG=1` and open an issue.

## Licence

MIT
