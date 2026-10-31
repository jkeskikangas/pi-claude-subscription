# Changelog

## Unreleased

- **Fix:** a conversation whose pi history was edited after the resume point no longer loses messages. Extensions can change or remove earlier messages with context edits; the provider then resumed Claude Code at the last matching assistant message and sent the rest as one user turn, which silently dropped every assistant message in it (Claude Code received tool results for calls it never saw). Those messages are now written into the fork's transcript before it is resumed, and only the final user turn is sent. If no fork can be written, the session is synthesized instead of resuming the source session.
- **Fix:** a resume no longer ends at tool calls without results. When the messages after the anchor started with the results of its calls and continued with something else (a user message, or edited history), those results were sent along with the next turn, but Claude Code first repaired its transcript with "interrupted" results of its own, so the model saw its calls fail and then succeed. If Claude Code recorded exactly these results, the fork now ends after its own entries, including the context it attached, which also keeps them cached; otherwise pi's results are written into the fork. Because the fork then ends in a user turn, Claude Code adds its "No response requested." placeholder before the next message; the SDK offers no way to avoid that. A tail of only results is sent as before.
- **Fix:** history written into a transcript keeps the thinking of every assistant message from the same model, not only of the trailing tool loop. Claude Code sends earlier thinking with each request, so when the same messages were written once with and once without their thinking (the cut-off moves with each new user message), the request no longer matched the cached prefix and everything after the difference was written to the cache again. In one session that was ~75k tokens at the 1-hour write price.
- **Fix:** history edited right after a user message no longer forces a full rebuild. When no assistant message after the last user message was left to resume from, the provider synthesized the conversation and wrote all kept history to the cache again. It now records where each user turn ends in Claude Code's transcript and forks there. Messages written into a fork are also appended after the attachments Claude Code adds to a user turn (environment, date, ...) instead of the user entry itself, which had dropped those attachments and broke the cached prefix on every such resume.
- **Fix:** history the provider wrote into a transcript (a synthesized session, or messages written into a fork) can be resumed from again. No anchors were recorded for those messages, so a later edit inside that history synthesized the whole conversation again instead of forking at the last kept message. In one session three small edits rewrote ~105k tokens each.
- **Fix:** closing a session no longer sends one more request. Closing only ended Claude Code's input, and on Windows the process took seconds to exit; meanwhile its parked tool calls failed and Claude Code sent their errors to the model. The turn is now interrupted first (at most 2 seconds), then the session is closed.

## 0.2.4 — 2026-10-16

- **Change:** divergence now uses the Agent SDK's native session operations. Claude Code sessions record the transcript-entry uuid streamed with each assistant message, anchors persist that uuid, and a diverged or restarted conversation is copied with `forkSession` up to the anchored entry before the fork is resumed — instead of resuming the source session at a uuid found by scanning Claude Code's transcript files. Anchors persisted by older versions still resolve through that scan, and if forking fails the provider falls back to resuming the source session at the anchor.

## 0.2.3 — 2026-10-16

- **Fix:** the idle sweep no longer kills in-flight calls when `idleMinutes` is unconfigured. The extension passed `idleMs: undefined`, which overwrote the 20-minute default; every comparison against `undefined` is false, so each 60-second sweep closed whatever session was mid-response (reported as "Claude Code exited unexpectedly"). The provider now ignores explicitly-undefined options, and the extension only passes options that are set. Regression-tested with the extension's unconfigured option shape.

## 0.2.2 — 2026-10-16

- **Fix:** Claude Code processes no longer accumulate. A long pi session had hundreds of idle `claude` children, each still connected. The provider now tracks every process it starts, pooled or not, and keeps at most `maxSessions` running outside in-flight calls (least recently used close first). A failed model switch on a reused session closes it instead of leaving it marked busy. The idle sweep also ends a call that has had no event from Claude Code for `idleMinutes`, and `shutdown` closes every tracked process.

## 0.2.1 — 2026-10-11

- **Add:** `claude-haiku-5-5` in the bundled model snapshot, regenerated from pi 1.1.0's Anthropic catalog. pi checks `enabledModels` and `--model` against the snapshot at startup, before the session-start refresh, so listing the model there no longer warns "No models match pattern".

## 0.2.0 — 2026-10-04

- **Add:** a Claude-tuned system prompt prefix for `claude-sdk` models. It is applied on pi's `before_agent_start`, keeps every tool and extension guideline plus pi's context files, skills and working directory, and never overrides a user's `SYSTEM.md`. Set `promptMode: "pi"` or `PI_CLAUDE_SDK_PROMPT=pi` for pi's default prompt.
- **Fix:** the Claude Code child process no longer inherits `CLAUDE_CODE_ENTRYPOINT` or `CLAUDECODE` from a parent Claude Code session, so it always declares itself as an Agent SDK app.
- **Bench:** every arm runs with a scrubbed environment (no API key, no inherited Claude Code identity). The proxy records Anthropic's unified rate-limit headers (billing route) per request. A `pi-default` arm uses pi's default prompt. Results before 0.2.0 were measured with an inherited Claude Code entrypoint; their billing routing was not representative, while token, time and correctness numbers are unaffected.

## 0.1.2 — 2026-10-04

- **Security:** a project's `.pi/claude-sdk.json` can no longer set `pathToClaudeCodeExecutable`. pi reads that file without project trust, so an untrusted folder could pick the program to launch. The executable now comes only from the agent-directory config (pi's `getAgentDir()`) or `PI_CLAUDE_SDK_CLAUDE_PATH`. Project values for `maxSessions` (1–16) and `idleMinutes` (1–1440) must be integers.
- **Fix:** Claude Code sometimes continues a turn on its own: after hitting the output limit, after an empty response, or after a cut-off stream. Those continuations are now folded into the same pi message, with their usage summed, instead of leaking into the next request. A response that restarts mid-stream keeps only the retry.
- **Fix:** a session is marked busy the moment a request selects or creates it. A concurrent request can no longer share it, and neither a resume, eviction nor the idle sweep closes it.
- **Fix:** `totalTokens` reports the context size of the turn's latest response, which pi uses for compaction. The other usage fields still sum over the turn.
- **Fix:** `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` are removed from Claude Code's environment, alongside the API-key variables.
- **Fix:** refreshing models from pi's registry keeps only Anthropic chat models.
- **Remove:** the experiment-only `PI_CLAUDE_SDK_EXTRA_ENV` and `PI_CLAUDE_SDK_VERBATIM` switches.
- **Tests:** offline provider tests driven by a scripted fake Claude Code session, including a property test for continuation folding.

## 0.1.1 — 2026-10-04

- Fix: the extension failed to load when installed from npm ("Cannot find module '@earendil-works/pi-ai/providers/anthropic.models'"). pi's extension loader aliases only package roots, so the model catalog is now a bundled snapshot (`src/catalog.ts`, regenerated by `scripts/gen-catalog.mjs`). Claude models newer than the snapshot are picked up from pi's own registry when a session starts.
- Tests: a unit test fails on any subpath import of a pi package in `src/`.

## 0.1.0 — 2026-10-04

- First release: the `claude-sdk` provider for pi ≥ 1.0. Claude models run on your Claude subscription through the Claude Agent SDK, with pi's own prompt, tools, agent loop and compaction.
- One live Claude Code process per conversation. pi's tools are served through an in-process MCP server, and tool results are matched by `tool_use` id.
- Native mid-turn steering, and abort/restart recovery that resumes Claude Code's own transcript at a hashed anchor so the prompt cache keeps hitting.
- Foreign or compacted history is replayed as a synthesized Claude Code session. Requests without tools (compaction, summaries) run without a session file.
- Benchmark harness (`bench/`) and results against Claude Code.
