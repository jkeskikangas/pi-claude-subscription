# pi-claude-subscription

Use your **Claude Pro/Max subscription** in [pi](https://pi.dev). This pi provider runs Claude
models through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), while
pi keeps its own agent loop, tools, system prompt, compaction and session tree. Claude Code serves
only as the authenticated model transport.

```
pi install npm:pi-claude-subscription
# or: pi install git:github.com/jkeskikangas/pi-claude-subscription
/model claude-sdk/claude-sonnet-5-5
```

On the bundled benchmark it matches Claude Code's task success, processes 5–10× fewer input tokens
and costs about half as much (API-equivalent). See [bench/RESULTS.md](bench/RESULTS.md).

Requirements: pi ≥ 1.0 and a logged-in Claude Code (`claude` → `/login`). The extension uses Claude
Code's own login. It never reads pi's credentials, and it removes `ANTHROPIC_API_KEY` from the Claude
Code environment so a stray key can't switch you to API billing.

## How it works

```
pi agent loop ──streamSimple──▶ provider ──streaming input──▶ Claude Code process (one per conversation)
      ▲                              │                               │  custom system prompt = pi's prompt
      │ toolCall events              │◀── raw API stream events ─────┤  tools = pi's tools via in-process MCP
      └── pi runs the tool ──────────┴── tool result releases the parked MCP call
```

- **pi's prompt and tools, not Claude Code's.** The Claude Code process runs with
  `systemPrompt` set to pi's prompt, `tools: []`, and pi's tools as an in-process MCP server. A
  request carries pi's prompt plus a two-line Claude Code preamble, not Claude Code's ~30k-token
  prompt and tool set.
- **One live process per conversation.** pi's next provider call after a tool round delivers the
  tool results to the parked MCP handlers, matched by `tool_use` id, and Claude Code continues the
  same API conversation. New user turns go in through streaming input. Nothing is respawned and the
  prompt cache stays warm.
- **Steering is native.** A message you type while a tool runs is queued in Claude Code before the
  tool results are released, so the model sees it at that tool boundary as Claude Code's own
  "user sent a message while you were working" notice.
- **Divergence resumes Claude Code's own transcript.** pi's history can stop matching the live
  process after an abort, `/tree` navigation, a fork, a thinking-level change or a pi restart. The
  provider then looks up the longest matching prefix in an anchor registry (pi transcript hash →
  Claude Code session and message) and resumes that session with `resumeSessionAt`. Claude Code
  replays its own bytes, so the prompt cache still hits. A resume waits for the old process to exit
  first: resuming a session that is still open makes Claude Code fork a copy without its context
  attachments, which changes the prefix.
- **Foreign history is synthesized.** Turns from other providers, a compacted session, or a session
  from before the extension was installed are written as a Claude Code transcript (tool ids
  sanitized, cross-model thinking dropped) and resumed.
- **One-shot requests**, such as compaction summaries and branch summaries, run tool-less and
  unpersisted.
- **pi owns context.** Claude Code's auto-compaction, CLAUDE.md loading, auto-memory, title
  generation and other non-essential traffic are disabled. The MCP output cap and tool timeout are
  lifted so pi's own truncation and timeouts apply.

## Configuration

Optional `~/.pi/agent/claude-sdk.json` (or `.pi/claude-sdk.json` in a project):

```json
{ "pathToClaudeCodeExecutable": "/opt/homebrew/bin/claude", "maxSessions": 3, "idleMinutes": 20 }
```

- `PI_CLAUDE_SDK_DEBUG=/path/log`: routing decisions (`live` / `resume` / `synth` / `fresh`).
- Thinking levels map to Claude effort (`low` … `max`) on adaptive-thinking models and to thinking
  budgets on older ones.
- Claude Code writes one-hour prompt-cache entries, so pi's cache warmer is not used.
  `cacheRetention: "none"` disables caching.

## Tests

- `npm test`: offline unit tests.
- `npm run test:live`: the provider against real Claude Code: tool loop, multi-turn, restart
  resume, abort recovery, foreign history, tool-less requests. With `PROXY=http://127.0.0.1:8787`
  it also asserts cache hits.
- `npm run test:e2e`: pi's own agent loop over RPC: steering, `/compact`, thinking switch, image
  input.

## Benchmark

`bench/proxy.mjs` is a logging reverse proxy for api.anthropic.com. Both harnesses run with
`ANTHROPIC_BASE_URL` pointing at it, so every request's real usage, side calls included, is
recorded per run.

- `bench/run.mjs`: 8 coding tasks on a fixture repo with hidden verification tests.
- `bench/session.mjs`: one 5-turn interactive session per harness.
- `bench/report.mjs`: summary tables.

Results are in [bench/RESULTS.md](bench/RESULTS.md).

## Limitations

- Tool names reach the model as `mcp__pi__<name>`. pi's tool descriptions are unchanged.
- Claude Code adds a short preamble (billing header, SDK identity), the account email and an
  environment block. These are about 250 stable tokens.
- Using a subscription through the Agent SDK is subject to Anthropic's terms for your plan.
