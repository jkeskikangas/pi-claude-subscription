import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeContext, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { synthesizeSession } from "../src/cc-sessions.ts";
import { fingerprint, piToolName, readTranscript, toolUseId, userTurnBlocks } from "../src/convert.ts";
import { claudeModels, thinkingOptions } from "../src/models.ts";
import { AsyncQueue, stableStringify } from "../src/util.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content,
	api: "claude-agent-sdk",
	provider: "claude-sdk",
	model: "claude-sonnet-5-5",
	usage,
	stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
	timestamp: 1,
	...extra,
});
const user = (text: string, timestamp = 1): Message => ({ role: "user", content: text, timestamp });
const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];

describe("readTranscript", () => {
	it("drops failed assistant turns and the tool results answering them", () => {
		const ctx = normalizeContext({
			systemPrompt: "sys",
			tools,
			messages: [
				user("a"),
				assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }], { stopReason: "aborted" }),
				{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "aborted" }], isError: true, timestamp: 1 },
				user("b"),
			],
		});
		const t = readTranscript(ctx);
		assert.equal(t.systemPrompt, "sys");
		assert.deepEqual(t.messages.map((m) => m.role), ["user", "user"]);
		assert.equal(t.chain.length, 3);
	});

	it("chain hashes ignore timestamps and usage but not content", () => {
		const a = readTranscript(normalizeContext({ systemPrompt: "s", messages: [user("hi", 1)] }));
		const b = readTranscript(normalizeContext({ systemPrompt: "s", messages: [user("hi", 999)] }));
		const c = readTranscript(normalizeContext({ systemPrompt: "s", messages: [user("hi!", 1)] }));
		const d = readTranscript(normalizeContext({ systemPrompt: "s2", messages: [user("hi", 1)] }));
		assert.equal(a.chain[1], b.chain[1]);
		assert.notEqual(a.chain[1], c.chain[1]);
		assert.notEqual(a.chain[1], d.chain[1]);
	});

	it("fingerprints tool arguments independently of key order", () => {
		const x = assistant([{ type: "toolCall", id: "t", name: "read", arguments: { a: 1, b: { c: 2, d: 3 } } }]);
		const y = assistant([{ type: "toolCall", id: "t", name: "read", arguments: { b: { d: 3, c: 2 }, a: 1 } }]);
		assert.equal(fingerprint(x), fingerprint(y));
		assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
	});
});

describe("conversion", () => {
	it("puts tool results first and keeps user text and images", () => {
		const blocks = userTurnBlocks([
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "call|1", toolName: "read", content: [], isError: true, timestamp: 1 },
		]);
		assert.equal(blocks[0].type, "tool_result");
		assert.equal(blocks[0].is_error, true);
		assert.match(blocks[0].tool_use_id, /^[a-zA-Z0-9_-]+$/);
		assert.deepEqual(blocks[0].content, [{ type: "text", text: "(no output)" }]);
		assert.equal(blocks[1].text, "look");
		assert.equal(blocks[2].source.media_type, "image/png");
	});

	it("sanitizes foreign tool ids deterministically and keeps Anthropic ids", () => {
		assert.equal(toolUseId("toolu_01AbC"), "toolu_01AbC");
		assert.equal(toolUseId("call_1|fc_2"), toolUseId("call_1|fc_2"));
		assert.match(toolUseId("call_1|fc_2"), /^toolu_x[0-9a-f]{24}$/);
		assert.equal(piToolName("mcp__pi__bash"), "bash");
		assert.equal(piToolName("Bash"), "Bash");
	});
});

describe("synthesizeSession", () => {
	it("writes a parent-linked Claude Code transcript ending at the last assistant message", () => {
		process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccdir-"));
		const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
		const { sessionId, at } = synthesizeSession(cwd, "claude-sonnet-5-5", [
			user("q"),
			assistant([
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
				{ type: "toolCall", id: "call|x", name: "read", arguments: { path: "a" } },
			]),
			{ role: "toolResult", toolCallId: "call|x", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 1 },
			assistant([{ type: "text", text: "done" }], { api: "openai-responses", provider: "openai", model: "gpt" }),
		]);
		const dir = readdirOne(join(process.env.CLAUDE_CONFIG_DIR, "projects"));
		const lines = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		delete process.env.CLAUDE_CONFIG_DIR;
		assert.deepEqual(lines.map((l) => l.type), ["user", "assistant", "user", "assistant"]);
		assert.equal(lines[0].parentUuid, null);
		for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentUuid, lines[i - 1].uuid);
		assert.equal(at, lines[3].uuid);
		const toolUse = lines[1].message.content.find((c: any) => c.type === "tool_use");
		assert.equal(toolUse.name, "mcp__pi__read");
		assert.equal(lines[2].message.content[0].tool_use_id, toolUse.id);
		// Thinking from an earlier turn is not replayed (signature checks only apply to the current tool loop).
		assert.ok(lines[1].message.content.some((c: any) => c.type === "thinking"), "thinking in the trailing tool loop is kept");
	});
});

describe("AnchorRegistry", () => {
	it("persists anchors across instances", () => {
		const file = join(mkdtempSync(join(tmpdir(), "anch-")), "a.jsonl");
		new AnchorRegistry(file).put("k1", { sessionId: "s", messageId: "m", cwd: "/x" });
		assert.deepEqual(new AnchorRegistry(file).get("k1"), { sessionId: "s", messageId: "m", cwd: "/x" });
		assert.equal(new AnchorRegistry(file).get("nope"), undefined);
	});
});

describe("models", () => {
	it("derives the catalog from pi's Anthropic models", () => {
		const ids = claudeModels().map((m) => m.id);
		assert.ok(ids.includes("claude-sonnet-5-5"));
		assert.ok(!ids.some((id) => /-\d{8}$/.test(id)));
	});
	it("maps thinking levels", () => {
		assert.deepEqual(thinkingOptions("high", true), { thinking: { type: "adaptive" }, effort: "high" });
		assert.deepEqual(thinkingOptions(undefined, true), { thinking: { type: "disabled" } });
		assert.deepEqual(thinkingOptions("low", false), { thinking: { type: "enabled", budgetTokens: 4096 } });
	});
});

describe("AsyncQueue", () => {
	it("delivers in order, supports abort and close", async () => {
		const q = new AsyncQueue<number>();
		q.push(1);
		const p = q.next();
		assert.equal(await p, 1);
		const ac = new AbortController();
		const waiting = q.next(ac.signal);
		ac.abort();
		await assert.rejects(waiting);
		q.push(2);
		q.close();
		assert.equal(await q.next(), 2);
		assert.equal(await q.next(), undefined);
	});
});

import { readdirSync } from "node:fs";
function readdirOne(dir: string): string {
	return join(dir, readdirSync(dir)[0]);
}
