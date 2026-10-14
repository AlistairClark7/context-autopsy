# context-autopsy 🩻

**Find out what's actually filling your coding agent's context window.**

Your agent has a 200k–1M token window. You'd think most of it is spent on your code. Run this and see what it's really spent on.

```bash
npx context-autopsy
```

It reads the Claude Code and Codex transcripts already on your machine and breaks every token down by what it was for: reading code, writing code, build and test logs, wrangling Docker, cloud CLIs and env vars, failed commands, fixed overhead, and more.

Everything runs locally. Nothing is uploaded. No dependencies.

---

## What you get

First, a card sized for one post (example output):

```
🩻 I autopsied my Claude Code context window.

Only 27% of it was my actual code.

🔑 It saw 23 secret keys & passwords
💥 1,204 failed commands
🔧 21% was build logs & env wrangling
🧠 Hit its context limit 87 times

1.9B tokens in 60 days
npx context-autopsy
```

The headline and stats are picked from whatever is most striking in *your* data. The card always fits in 280 characters and contains no paths, project names or commands. `--share --copy` puts it on your clipboard and prints a link to post it.

Below the card is the full breakdown:

```
WHERE YOUR CONTEXT WENT
                                  processed*   share  in context
Reading code                          512.3M   27.0%        9.1M  ██████████████████████████████
Fixed overhead                        398.4M   21.0%        5.2M  ███████████████████▍··········
Build, test & run output              246.6M   13.0%        4.4M  █████████████▏················
Reasoning                             227.6M   12.0%        4.6M  ████████▍·····················
Environment & infrastructure          151.8M    8.0%        2.7M  ████████▏·····················
Git & version control                 132.8M    7.0%        2.4M  ███████▍······················
...

THE HEADLINES
▸ 21% of everything your agents processed was build output and environment wrangling.
▸ 1,204 failed commands and tool calls (7% of all tool calls), 64.0M tokens of error output processed.
▸ 23 credentials passed through the model's context (9 Database URL with password, 6 AWS access key, …).
▸ Most expensive single output: a 14k-token `pnpm install` result, re-sent 212 times = 3.0M tokens.
▸ 41 sessions filled the window and compacted (87 times).
```

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
npx context-autopsy [options] [transcript.jsonl | directory ...]

  --agent <claude|codex|all>   Which agent's transcripts to read (default: all)
  --since <7d|2026-09-01>      Only sessions active since this date or age
  --project <text>             Only sessions whose working directory contains <text>
  --last <n>                   Only the n most recent sessions
  --no-subagents               Skip subagent / child-thread transcripts
  --detail                     Show sub-categories (which tools, which commands)
  --top <n>                    Rows in the "most expensive" table
  --share                      Just the post-ready card, plus a link to post it
  --copy                       Copy the card to the clipboard
  --json                       Machine-readable output
```

Transcripts are read from `~/.claude/projects` and `~/.codex/sessions`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected.

## Share yours

```bash
npx context-autopsy --share --copy
```

This prints just the card, copies it to your clipboard, and gives you a link that opens a pre-filled post.

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
