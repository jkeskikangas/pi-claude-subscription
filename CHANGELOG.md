# Changelog

## 0.1.0 — 2026-10-04

- First release: the `claude-sdk` provider for pi ≥ 1.0. Claude models run on your Claude subscription through the Claude Agent SDK, with pi's own prompt, tools, agent loop and compaction.
- One live Claude Code process per conversation. pi's tools are served through an in-process MCP server, and tool results are matched by `tool_use` id.
- Native mid-turn steering, and abort/restart recovery that resumes Claude Code's own transcript at a hashed anchor so the prompt cache keeps hitting.
- Foreign or compacted history is replayed as a synthesized Claude Code session. Requests without tools (compaction, summaries) run without a session file.
- Benchmark harness (`bench/`) and results against Claude Code.
