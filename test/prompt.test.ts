import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyClaudePrompt, claudePreamble } from "../src/prompt.ts";
import { childEnv, type SessionSpec } from "../src/session.ts";
import { resolveConfig } from "../src/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const options = () => ({
	cwd: "/w",
	selectedTools: ["read", "bash", "edit", "write", "web_search"],
	toolSnippets: { read: "Read file contents", bash: "Execute bash commands", edit: "Edit a file", write: "Write a file", web_search: "Search the web" },
	toolGuidelines: { edit: ["Use edit for precise changes"], web_search: ["Cite sources from web_search"] },
	promptGuidelines: ["Extension rule: never touch .env"],
	appendSystemPrompt: "",
	sections: {},
	contextFiles: [],
	skills: [],
}) as any;

describe("Claude-tuned system prompt", () => {
	it("lists the selected tools and keeps every tool and extension guideline", () => {
		const p = claudePreamble(options(), { readme: "/pi/README.md", docs: "/pi/docs", examples: "/pi/examples" });
		for (const s of ["- read: Read file contents", "- web_search: Search the web", "Use edit for precise changes", "Cite sources from web_search", "Extension rule: never touch .env"]) assert.ok(p.includes(s), s);
		assert.match(p, /pi/, "says plainly that it runs in pi");
		assert.ok(p.includes("/pi/docs"), "keeps a pointer to pi's docs");
		assert.ok(p.includes("in parallel"), "Claude-specific working guidance is present");
	});

	it("applies only to claude-sdk models and never overrides the user's own SYSTEM.md", () => {
		const event = { systemPromptOptions: options() };
		applyClaudePrompt(event, { provider: "openai-codex" }, "claude");
		assert.equal(event.systemPromptOptions.customPrompt, undefined);
		applyClaudePrompt(event, { provider: "claude-sdk" }, "pi");
		assert.equal(event.systemPromptOptions.customPrompt, undefined, "promptMode pi keeps pi's default prompt");
		applyClaudePrompt(event, { provider: "claude-sdk" }, "claude");
		assert.ok(event.systemPromptOptions.customPrompt?.length > 0);
		const own = { systemPromptOptions: { ...options(), customPrompt: "my SYSTEM.md" } };
		applyClaudePrompt(own, { provider: "claude-sdk" }, "claude");
		assert.equal(own.systemPromptOptions.customPrompt, "my SYSTEM.md");
	});
});

describe("honest identity", () => {
	it("never forwards an inherited Claude Code entrypoint", () => {
		const env = childEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1", PATH: "/bin" }, {} as SessionSpec);
		assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
		assert.equal(env.CLAUDECODE, undefined);
	});
});

describe("prompt mode config", () => {
	it("defaults to the Claude prompt; env or global config can select pi's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "p-"));
		const agentDir = mkdtempSync(join(tmpdir(), "a-"));
		assert.equal(resolveConfig({ cwd, agentDir, env: {} }).promptMode, "claude");
		assert.equal(resolveConfig({ cwd, agentDir, env: { PI_CLAUDE_SDK_PROMPT: "pi" } }).promptMode, "pi");
	});
});
