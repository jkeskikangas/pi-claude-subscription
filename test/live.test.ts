// Live integration tests: real Claude Code + real API (Claude subscription). Run with
//   PI_CLAUDE_SDK_LIVE=1 node --experimental-strip-types --test test/live.test.ts
// Optionally route through bench/proxy.mjs (PROXY=http://127.0.0.1:8787) to assert cache behaviour.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeContext, Type, type AssistantMessage, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { claudeModels } from "../src/models.ts";
import { API, ClaudeSdkProvider } from "../src/provider.ts";

const LIVE = process.env.PI_CLAUDE_SDK_LIVE === "1";
const PROXY = process.env.PROXY;
const MODEL_ID = process.env.MODEL ?? "claude-sonnet-5-5";
const cfg = claudeModels().find((m) => m.id === MODEL_ID)!;
const model = { ...cfg, api: API, provider: "claude-sdk", baseUrl: "" } as unknown as Model<any>;
const cwd = mkdtempSync(join(tmpdir(), "pi-claude-subscription-test-"));
const registry = new AnchorRegistry(join(cwd, "anchors.jsonl"));
const SYSTEM = "You are a terse assistant in a test harness. Follow instructions exactly. Use tools when asked.";
const tools: Tool[] = [
	{ name: "read", description: "Read a file and return its contents.", parameters: Type.Object({ path: Type.String() }) },
	{ name: "bash", description: "Run a shell command.", parameters: Type.Object({ command: Type.String() }) },
];

let tagN = 0;
function provider(tag: string): ClaudeSdkProvider {
	if (PROXY) process.env.ANTHROPIC_BASE_URL = `${PROXY}/run/live-${tag}-${process.pid}-${tagN++}`;
	return new ClaudeSdkProvider({ registry, cwd: () => cwd, debug: process.env.DEBUG ? (m) => console.error(`[provider] ${m}`) : undefined });
}

async function call(p: ClaudeSdkProvider, messages: Message[], opts: { reasoning?: string; signal?: AbortSignal; onText?: () => void } = {}) {
	const ctx = normalizeContext({ systemPrompt: SYSTEM, tools, messages });
	const s = p.streamSimple(model, ctx, { reasoning: (opts.reasoning ?? "low") as any, signal: opts.signal });
	for await (const ev of s) if (ev.type === "text_delta") opts.onText?.();
	const msg = (await s.result()) as AssistantMessage;
	return { msg, route: p.lastRoute };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const results = (msg: AssistantMessage, out: (name: string, args: any) => string): Message[] =>
	msg.content
		.filter((c) => c.type === "toolCall")
		.map((c: any) => ({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: out(c.name, c.arguments) }], isError: false, timestamp: Date.now() }));
const text = (m: AssistantMessage) => m.content.map((c: any) => c.text ?? "").join("");

function proxyLog(): any[] {
	const tag = process.env.ANTHROPIC_BASE_URL?.split("/run/")[1];
	const file = join(import.meta.dirname, "..", "bench", "out", "proxy", `${tag}.jsonl`);
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.usage?.input_tokens != null) : [];
}

describe("live Claude Code provider", { skip: !LIVE, timeout: 300_000 }, () => {
	it("runs a tool loop and multi-turn conversation on one live process, then resumes after a restart", async () => {
		const p = provider("multi");
		const h: Message[] = [user("Use the read tool on notes.txt, then tell me the code word in it, in one word.")];
		const a1 = await call(p, h);
		assert.equal(a1.route, "fresh");
		assert.equal(a1.msg.stopReason, "toolUse", a1.msg.errorMessage ?? "");
		const tc = a1.msg.content.find((c) => c.type === "toolCall") as any;
		assert.equal(tc.name, "read");
		h.push(a1.msg, ...results(a1.msg, () => "The code word is AURORA."));
		const a2 = await call(p, h);
		assert.equal(a2.route, "live");
		assert.equal(a2.msg.stopReason, "stop");
		assert.match(text(a2.msg), /aurora/i);
		h.push(a2.msg, user("Now reply with the code word reversed, lowercase, nothing else."));
		const a3 = await call(p, h);
		assert.equal(a3.route, "live");
		assert.match(text(a3.msg), /arorua/i);
		assert.ok(a3.msg.usage.cacheRead > 0, "second turn reads the cache");
		p.shutdown();

		// A new provider (pi restarted) resumes Claude Code's own session at the last anchor.
		const p2 = provider("restart");
		h.push(a3.msg, user("And the code word uppercase? Only the word."));
		const a4 = await call(p2, h);
		assert.equal(a4.route, "resume");
		assert.match(text(a4.msg), /AURORA/);
		if (PROXY) {
			const reqs = proxyLog();
			const first = reqs[0];
			assert.ok(first.usage.cache_read_input_tokens > first.usage.cache_creation_input_tokens, `resume keeps the cache: ${JSON.stringify(first.usage)}`);
		}
		p2.shutdown();
	});

	it("recovers after an abort by resuming at the last completed message", async () => {
		const p = provider("abort");
		const h: Message[] = [user("Say hi.")];
		const a1 = await call(p, h);
		h.push(a1.msg, user("Count from 1 to 300, one number per line, no other text."));
		const ac = new AbortController();
		const a2 = await call(p, h, { signal: ac.signal, onText: () => ac.abort() });
		assert.equal(a2.msg.stopReason, "aborted");
		h.push(a2.msg); // pi keeps the aborted message; the provider must skip it
		h.push(user("Never mind. Reply with just the word: banana"));
		const a3 = await call(p, h);
		assert.equal(a3.route, "resume", "aborted process is replaced by a resume");
		assert.match(text(a3.msg), /banana/i);
		p.shutdown();
	});

	it("keeps the cache of completed turns across an abort", { skip: !PROXY }, async () => {
		const p = provider("abortcache");
		const filler = Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");
		const h: Message[] = [user(`Remember this document, then just reply OK.\n${filler}`)];
		for (const q of ["Reply OK again.", "Reply OK once more."]) {
			const a = await call(p, h);
			h.push(a.msg, user(q));
		}
		const a3 = await call(p, h);
		h.push(a3.msg, user("Count from 1 to 300, one number per line."));
		const ac = new AbortController();
		const a4 = await call(p, h, { signal: ac.signal, onText: () => ac.abort() });
		h.push(a4.msg, user("Stop. Reply with just: done"));
		const a5 = await call(p, h);
		assert.equal(a5.route, "resume");
		const reqs = proxyLog();
		const completed = reqs[2]; // the last request that finished normally
		const last = reqs[reqs.length - 1];
		const completedPrefix = completed.usage.cache_read_input_tokens + completed.usage.cache_creation_input_tokens;
		assert.ok(last.usage.cache_read_input_tokens >= completedPrefix * 0.9, `resume after abort reads the completed prefix: ${JSON.stringify(last.usage)} vs ${completedPrefix}`);
		p.shutdown();
	});

	it("continues history from another provider by synthesizing a Claude Code session", async () => {
		const p = provider("synth");
		const foreign = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_abc|fc_123", name: "bash", arguments: { command: "cat secret.txt" } }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as AssistantMessage;
		const h: Message[] = [
			user("What is in secret.txt?"),
			foreign,
			{ role: "toolResult", toolCallId: "call_abc|fc_123", toolName: "bash", content: [{ type: "text", text: "the password is swordfish" }], isError: false, timestamp: Date.now() },
		];
		const a = await call(p, h);
		assert.equal(a.route, "synth");
		assert.equal(a.msg.stopReason, "stop", a.msg.errorMessage ?? "");
		assert.match(text(a.msg), /swordfish/i);
		p.shutdown();
	});

	it("serves tool-less one-shot requests (compaction, summaries)", async () => {
		const p = provider("notools");
		const ctx = normalizeContext({ systemPrompt: "Summarize the conversation in at most five words.", messages: [user("We fixed a null pointer bug in parser.ts and added a test.")] });
		const s = p.streamSimple(model, ctx, { reasoning: "low" as any });
		const msg = await s.result();
		assert.equal(msg.stopReason, "stop", msg.errorMessage ?? "");
		assert.ok(text(msg).length > 0);
		p.shutdown();
	});
});
