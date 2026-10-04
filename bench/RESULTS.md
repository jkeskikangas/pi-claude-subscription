# Results: pi + pi-claude-subscription vs Claude Code

Measured 2026-10-04 with Claude Code 2.1.289 (Agent SDK 0.3.289) and pi 1.0.2, on the same Claude
subscription account. Every request of every run went through `bench/proxy.mjs`, so the token
numbers are the API's own `usage`, side calls included.

**Arms**
- **pi**: `pi -p` with this provider (`--no-extensions -e src/index.ts --no-skills`), pi's default
  tools (read, bash, edit, write) and system prompt.
- **claude**: `claude -p` as shipped, isolated from this machine's settings, MCP servers and plugins
  (`--setting-sources "" --strict-mcp-config`), with the same model and effort.

The tasks are 11 coding tasks on a fixture repo (`bench/fixture`): bug fixes, CLI features and
multi-file features. Hidden tests (`bench/tasks/*.verify.js`) plus the repo's own test suite
decide pass or fail. "API-equivalent cost" prices each request's token classes at catalog rates
(one-hour cache writes at 2× input). The subscription meters the same token classes.

## Summary

| run | pass (pi / claude) | median wall (pi / claude) | input processed per run (pi / claude) | cost per run (pi / claude) |
|---|---|---|---|---|
| 8 tasks × 3, Sonnet 5.5 medium | 24/24 / 24/24 | 8.1s / 12.3s | 13,760 / 132,728 (9.6×) | $0.022 / $0.067 (3.1×) |
| 3 harder tasks × 3, Sonnet 5.5 medium | 9/9 / 9/9 | 14.6s / 16.8s | 20,060 / 124,554 (6.2×) | $0.045 / $0.083 (1.8×) |
| 11 tasks × 1, Opus 5.5 high | 11/11 / 11/11 | 20.4s / 20.0s | 28,060 / 148,832 (5.3×) | $0.130 / $0.256 (2.0×) |

The interactive 5-turn session (one long-lived process per harness, Sonnet 5.5 medium, 2 reps) is
in its own section below.

## Why the difference

- **Prompt size.** Claude Code sends its own system prompt and 23 tool definitions with every
  request: about 29k tokens before any work starts, or about 130k with this machine's real
  settings, MCP servers and plugins. The provider sends pi's prompt (about 2.5k tokens with tools)
  plus a two-line Claude Code preamble.
- **Cache-hit ratio isn't the target.** Claude Code's hit ratio is higher (about 92–94% against
  71–78%) only because its large constant prefix is cached across runs. pi's prompt includes the
  working directory, which is unique per benchmark run, so every pi run writes a fresh 2–3k-token
  prefix. pi still processes 5–10× fewer tokens in total.
- **Wall time.** Smaller prompts mean faster time to first token. The provider adds no per-turn
  process start (one live Claude Code process per conversation) and no title-generation side call.
  Sonnet runs were faster on pi, and Opus at high effort ran at parity, since model thinking time
  dominates there.
- **Correctness.** Both harnesses solved every task: 44 of 44 task runs each, plus 2 of 2 interactive sessions. pi's toolset and prompt
  did not cost accuracy on these tasks.

## Compared with lhahne/pi-claude-agent-sdk (design, not measured)

That fork runs Claude Code with the `claude_code` preset system prompt (pi's prompt appended,
`tools: []`), starts a new Claude Code process per turn, and rebuilds Claude Code's session file from
pi's history with `cc-session-io` before resuming. Its README reports that a rebuild loses the prompt
cache about 58% of the time, and a plain resume about 26%. This provider differs in four ways:

- It uses a custom system prompt (pi's own) instead of Claude Code's preset: fewer tokens, and pi's
  instructions without competing ones.
- It keeps one live process per conversation with streaming input, so ordinary turns involve no
  resume, rebuild or respawn.
- Divergence resumes Claude Code's own transcript at a hashed anchor (`resumeSessionAt`), so the
  bytes are Claude Code's and the cache hits. The live tests assert this: about 9.7k of 9.7k
  prefix tokens are read from cache after an abort, and the prefix is fully cached after a pi
  restart.
- Authentication is Claude Code's own login, not pi's Anthropic OAuth token.

lhahne's provider was not benchmarked here. It authenticates with pi's own Anthropic OAuth credential rather than Claude Code's login, and that credential was not available for these runs.

## 5-turn interactive session (claude-sonnet-5-5, effort medium, 2 reps)

| metric | pi | claude |
|---|---:|---:|
| all checks passed | 2/2 | 2/2 |
| session wall time (s) | 39.8 | 43.4 |
| per-turn wall time (s) | 6.7 / 7.6 / 10.4 / 10.2 / 4.9 | 7.6 / 9.1 / 13.0 / 10.4 / 3.4 |
| API requests | 11.0 | 11.5 |
| cache read | 78,100 | 383,889 |
| cache write | 10,554 | 28,057 |
| uncached input | 30 | 31 |
| output | 4,402 | 5,303 |
| API-equivalent cost | $0.102 | $0.242 |

## Detail

### main-sonnet55-medium

#### Overall (claude-sonnet-5-5, effort medium, 8 tasks × 3 reps)

| metric | pi | claude |
|---|---:|---:|
| tasks passed | 24/24 | 24/24 |
| wall time, median (s) | 8.1 | 12.3 |
| wall time, mean (s) | 9.0 | 12.5 |
| API requests / run | 3.9 | 4.2 |
| uncached input / run | 8 | 8 |
| cache read / run | 10,738 | 124,997 |
| cache write / run | 3,014 | 7,722 |
| output / run | 768 | 1,112 |
| input processed / run | 13,760 | 132,728 |
| cache hit ratio | 77.9% | 93.8% |
| API-equivalent cost / run | $0.0219 | $0.0670 |
| models called | claude-sonnet-5-5 | claude-sonnet-5-5 |

#### Per task

| task | pi pass | claude pass | pi wall s | claude wall s | pi cost | claude cost |
|---|---:|---:|---:|---:|---:|---:|
| csv-quotes | 3/3 | 3/3 | 8.7 | 12.6 | $0.0199 | $0.0681 |
| duration-units | 3/3 | 3/3 | 5.4 | 6.4 | $0.0131 | $0.0485 |
| lru-recency | 3/3 | 3/3 | 7.9 | 10.3 | $0.0190 | $0.0589 |
| median | 3/3 | 3/3 | 5.7 | 9.9 | $0.0153 | $0.0509 |
| pricing | 3/3 | 3/3 | 8.8 | 12.3 | $0.0214 | $0.0627 |
| cli-json | 3/3 | 3/3 | 7.4 | 24.8 | $0.0224 | $0.1026 |
| cli-low | 3/3 | 3/3 | 14.2 | 12.3 | $0.0305 | $0.0680 |
| transfer | 3/3 | 3/3 | 14.4 | 16.1 | $0.0336 | $0.0765 |

### hard-sonnet55-medium

#### Overall (claude-sonnet-5-5, effort medium, 3 tasks × 3 reps)

| metric | pi | claude |
|---|---:|---:|
| tasks passed | 9/9 | 9/9 |
| wall time, median (s) | 14.6 | 16.8 |
| wall time, mean (s) | 15.7 | 17.7 |
| API requests / run | 4.0 | 3.8 |
| uncached input / run | 8 | 8 |
| cache read / run | 14,311 | 114,706 |
| cache write / run | 5,741 | 9,841 |
| output / run | 1,955 | 2,102 |
| input processed / run | 20,060 | 124,554 |
| cache hit ratio | 71.2% | 91.8% |
| API-equivalent cost / run | $0.0454 | $0.0833 |
| models called | claude-sonnet-5-5 | claude-sonnet-5-5 |

#### Per task

| task | pi pass | claude pass | pi wall s | claude wall s | pi cost | claude cost |
|---|---:|---:|---:|---:|---:|---:|
| reservations | 3/3 | 3/3 | 19.1 | 18.6 | $0.0585 | $0.0928 |
| csv-rfc4180 | 3/3 | 3/3 | 14.3 | 15.4 | $0.0343 | $0.0738 |
| cli-value | 3/3 | 3/3 | 14.2 | 16.8 | $0.0434 | $0.0835 |

### all-opus55-high

#### Overall (claude-opus-5-5, effort high, 11 tasks × 1 reps)

| metric | pi | claude |
|---|---:|---:|
| tasks passed | 11/11 | 11/11 |
| wall time, median (s) | 20.4 | 20.0 |
| wall time, mean (s) | 23.7 | 24.0 |
| API requests / run | 5.4 | 4.5 |
| uncached input / run | 11 | 9 |
| cache read / run | 22,203 | 136,049 |
| cache write / run | 5,847 | 12,773 |
| output / run | 2,403 | 2,389 |
| input processed / run | 28,060 | 148,832 |
| cache hit ratio | 77.2% | 91.4% |
| API-equivalent cost / run | $0.1297 | $0.2555 |
| models called | claude-opus-5-5 | claude-opus-5-5 |

#### Per task

| task | pi pass | claude pass | pi wall s | claude wall s | pi cost | claude cost |
|---|---:|---:|---:|---:|---:|---:|
| csv-quotes | 1/1 | 1/1 | 16.1 | 20.0 | $0.0951 | $0.4660 |
| duration-units | 1/1 | 1/1 | 9.4 | 13.6 | $0.0550 | $0.1680 |
| lru-recency | 1/1 | 1/1 | 16.0 | 15.9 | $0.0806 | $0.1750 |
| median | 1/1 | 1/1 | 10.5 | 11.6 | $0.0540 | $0.1392 |
| pricing | 1/1 | 1/1 | 16.2 | 18.9 | $0.1181 | $0.2137 |
| cli-json | 1/1 | 1/1 | 20.4 | 18.8 | $0.1176 | $0.2152 |
| cli-low | 1/1 | 1/1 | 21.4 | 25.7 | $0.1227 | $0.2344 |
| transfer | 1/1 | 1/1 | 22.4 | 23.7 | $0.1175 | $0.2169 |
| reservations | 1/1 | 1/1 | 44.5 | 41.2 | $0.2307 | $0.3438 |
| csv-rfc4180 | 1/1 | 1/1 | 36.4 | 33.9 | $0.1735 | $0.2680 |
| cli-value | 1/1 | 1/1 | 47.8 | 40.4 | $0.2620 | $0.3705 |

## Reproduce

```
node bench/proxy.mjs &                     # logging proxy on :8787
node bench/run.mjs --reps 3 --label mine   # task benchmark
node bench/session.mjs --reps 2            # interactive session benchmark
node bench/report.mjs --label mine
node bench/session-report.mjs
```
