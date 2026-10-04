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
Code's own login. It never reads pi's credentials. It also removes `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex/Foundry switches from Claude Code's environment, so
none of them can move you to API billing.

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

## System prompt

For `claude-sdk` models the extension replaces pi's default prompt prefix with one written for
Claude. It lists the selected tools and keeps every tool and prompt guideline that pi and other
extensions contribute, adds Claude-oriented working rules (read before editing, parallel tool calls,
verify, report faithfully) and points to pi's docs. pi's context files, skills and working directory
are unchanged, and your own `SYSTEM.md` always wins.

Set `"promptMode": "pi"` in the global `claude-sdk.json`, or `PI_CLAUDE_SDK_PROMPT=pi`, to keep pi's
default prompt.

**Billing.** Requests declare themselves honestly as Agent SDK traffic (`sdk-ts`). An inherited Claude
Code entrypoint is always cleared. Observed on a Max plan on 2026-10-04: with the Claude prompt,
requests ran within the plan's usage limits; with pi's default prompt, Anthropic answered `400 Third-party apps
now draw from your extra usage`. Anthropic's routing can change; see their
[Agent SDK plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Configuration

Optional `claude-sdk.json` in pi's agent directory (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`):

```json
{ "pathToClaudeCodeExecutable": "/opt/homebrew/bin/claude", "maxSessions": 3, "idleMinutes": 20 }
```

A project's `.pi/claude-sdk.json` can set `maxSessions` and `idleMinutes` only. pi reads that file
before you grant project trust, so a project cannot choose which program runs.
`PI_CLAUDE_SDK_CLAUDE_PATH` overrides the executable path.

- `PI_CLAUDE_SDK_DEBUG=/path/log`: routing decisions (`live` / `resume` / `synth` / `fresh`).
- Thinking levels map to Claude effort (`low` … `max`) on adaptive-thinking models and to thinking
  budgets on older ones.
- Claude Code writes one-hour prompt-cache entries, so pi's cache warmer is not used.
  `cacheRetention: "none"` disables caching.

## Tests

- `npm test`: offline tests. They cover the helpers, plus event translation and routing against a
  scripted fake Claude Code session: tool loop, Claude Code's own continuations, mid-stream retry,
  abort, errors, live/resume/synth routing and the busy guard.
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
