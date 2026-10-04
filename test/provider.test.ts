// Offline tests for the provider's event translation and routing, driven by a fake Claude Code session
// that replays scripted SDK events.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeContext, Type, type AssistantMessage, type Message, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "../src/anchors.ts";
import { projectDir } from "../src/cc-sessions.ts";
import { resolveConfig } from "../src/config.ts";
import { anthropicChatModels, claudeModels } from "../src/models.ts";
import { API, ClaudeSdkProvider } from "../src/provider.ts";
import type { ClaudeSession, SessionSpec } from "../src/session.ts";
import { childEnv } from "../src/session.ts";
import { AsyncQueue } from "../src/util.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccdir-"));
const model = { ...claudeModels().find((m) => m.id === "claude-sonnet-5-5")!, api: API, provider: "claude-sdk", baseUrl: "" } as unknown as Model<any>;
const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];
const SYSTEM = "system prompt";

// ---- SDK event builders --------------------------------------------------------------------

type Block = { text: string } | { tool: string; id: string; args: object };
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheWrite,
});
const ev = (event: object) => ({ type: "stream_event", event, parent_tool_use_id: null });
function apiMessage(id: string, blocks: Block[], stop: string, u = usage(10, 5, 100, 1)): object[] {
	const out: object[] = [ev({ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage: { ...u, output_tokens: 1 } } })];
	blocks.forEach((b, index) => {
		if ("text" in b) {
			out.push(ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
			out.push(ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }));
		} else {
			out.push(ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: `mcp__pi__${b.tool}`, input: {} } }));
			out.push(ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.args) } }));
		}
		out.push(ev({ type: "content_block_stop", index }));
	});
	out.push(ev({ type: "message_delta", delta: { stop_reason: stop }, usage: u }));
	out.push(ev({ type: "message_stop" }));
	return out;
}
const result = { type: "result", subtype: "success", is_error: false };

// ---- Fake session ---------------------------------------------------------------------------

class FakeSession implements ClaudeSession {
	readonly sessionId: string;
	readonly systemPrompt: string;
	model: string;
	chain: string;
	count: number;
	awaiting = new Set<string>();
	servedByClaude = new Set<string>();
	dead = false;
	busy = false;
	lastUsed = Date.now();
	readonly events = new AsyncQueue<any>();
	readonly exited: Promise<void>;
	private markExited!: () => void;
	readonly sent: any[][] = [];
	readonly delivered: ToolResultMessage[] = [];
	interrupted = false;
	stderr = "";

	readonly spec: SessionSpec;
	private readonly script: object[][];

	constructor(spec: SessionSpec, chain: string, count: number, script: object[][]) {
		this.spec = spec;
		this.script = script;
		this.sessionId = spec.resume?.sessionId ?? `fake-${Math.random().toString(36).slice(2)}`;
		this.systemPrompt = spec.systemPrompt;
		this.model = spec.model;
		this.chain = chain;
		this.count = count;
		this.exited = new Promise((r) => (this.markExited = r));
	}
	private reply(): void {
		for (const e of this.script.shift() ?? []) this.events.push(e);
	}
	send(content: any[]): void {
		this.sent.push(content);
		this.reply();
	}
	deliver(r: ToolResultMessage): void {
		this.delivered.push(r);
		this.awaiting.delete(r.toolCallId);
		if (this.awaiting.size === 0) this.reply();
	}
	async setModel(m: string) {
		this.model = m;
	}
	async interrupt() {
		this.interrupted = true;
	}
	close(): void {
		this.dead = true;
		this.events.close();
		this.markExited();
	}
}

function harness(script: object[][], registry = new AnchorRegistry(join(mkdtempSync(join(tmpdir(), "anch-")), "a.jsonl"))) {
	const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
	const created: FakeSession[] = [];
	const provider = new ClaudeSdkProvider({
		registry,
		cwd: () => cwd,
		createSession: (spec, chain, count) => {
			const s = new FakeSession(spec, chain, count, script);
			created.push(s);
			return s;
		},
	});
	const call = async (messages: Message[], signal?: AbortSignal) => {
		const s = provider.streamSimple(model, normalizeContext({ systemPrompt: SYSTEM, tools, messages }), { reasoning: "medium" as any, signal });
		const msg = (await s.result()) as AssistantMessage;
		return { msg, route: provider.lastRoute };
	};
	return { provider, created, call, cwd, registry };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const toolResult = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 });
const text = (m: AssistantMessage) => m.content.map((c: any) => c.text ?? "").join("");

// ---- Event translation ----------------------------------------------------------------------

describe("event translation", () => {
	it("runs a tool loop on one live session", async () => {
		const h = harness([apiMessage("m1", [{ tool: "read", id: "toolu_1", args: { path: "a.txt" } }], "tool_use"), [...apiMessage("m2", [{ text: "done" }], "end_turn"), result]]);
		const hist: Message[] = [user("read a.txt")];
		const a1 = await h.call(hist);
		assert.equal(a1.route, "fresh");
		assert.equal(a1.msg.stopReason, "toolUse");
		assert.deepEqual(a1.msg.content, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } }]);
		hist.push(a1.msg, toolResult("toolu_1", "hello"));
		const a2 = await h.call(hist);
		assert.equal(a2.route, "live");
		assert.equal(h.created.length, 1);
		assert.equal(h.created[0].delivered[0].toolCallId, "toolu_1");
		assert.equal(text(a2.msg), "done");
		assert.equal(a2.msg.stopReason, "stop");
	});

	it("folds Claude Code's own continuation of a turn into the same message (F2)", async () => {
		const h = harness([
			[...apiMessage("m1", [{ text: "part one, " }], "max_tokens", usage(10, 50, 100, 2)), ...apiMessage("m2", [{ text: "part two" }], "end_turn", usage(3, 20, 120, 4)), result],
			[...apiMessage("m3", [{ text: "second answer" }], "end_turn"), result],
		]);
		const hist: Message[] = [user("long answer please")];
		const a1 = await h.call(hist);
		assert.equal(text(a1.msg), "part one, part two");
		assert.equal(a1.msg.stopReason, "stop");
		assert.equal(a1.msg.usage.output, 70);
		assert.equal(a1.msg.usage.input, 13);
		assert.equal(a1.msg.usage.cacheRead, 220);
		assert.equal(a1.msg.usage.cacheWrite, 6);
		assert.equal(a1.msg.usage.totalTokens, 3 + 20 + 120 + 4, "totalTokens is the context size of the last response, which pi uses for compaction");
		hist.push(a1.msg, user("next"));
		const a2 = await h.call(hist);
		assert.equal(a2.route, "live");
		assert.equal(text(a2.msg), "second answer", "the next turn gets its own response, not leftovers");
	});

	it("ends at a tool call even when it follows a continuation", async () => {
		const h = harness([[...apiMessage("m1", [{ text: "thinking out loud" }], "max_tokens"), ...apiMessage("m2", [{ tool: "read", id: "toolu_9", args: { path: "b" } }], "tool_use")]]);
		const a = await h.call([user("go")]);
		assert.equal(a.msg.stopReason, "toolUse");
		assert.deepEqual(a.msg.content.map((c) => c.type), ["text", "toolCall"]);
	});

	it("keeps only the retry when a response restarts mid-stream", async () => {
		const unfinished = apiMessage("m1", [{ text: "garbled" }], "end_turn").slice(0, 3); // start, block start, delta
		const h = harness([[...unfinished, ...apiMessage("m1b", [{ text: "clean" }], "end_turn"), result]]);
		const a = await h.call([user("hi")]);
		assert.equal(text(a.msg), "clean");
	});

	it("property: folded text and usage are the concatenation and sum of every response in the turn", async () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return Math.floor(seed / 65536) % n;
		};
		for (let round = 0; round < 25; round++) {
			const parts = Array.from({ length: 1 + rand(4) }, (_, i) => `p${round}.${i}:${"x".repeat(rand(5))} `);
			const outs = parts.map(() => 1 + rand(100));
			const events = parts.flatMap((p, i) => apiMessage(`m${i}`, [{ text: p }], i === parts.length - 1 ? "end_turn" : "max_tokens", usage(1, outs[i], 0, 0)));
			const h = harness([[...events, result]]);
			const a = await h.call([user("q")]);
			assert.equal(text(a.msg), parts.join(""));
			assert.equal(a.msg.usage.output, outs.reduce((x, y) => x + y, 0));
		}
	});

	it("reports an error result and drops the session", async () => {
		const h = harness([[{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }], [...apiMessage("m2", [{ text: "ok" }], "end_turn"), result]]);
		const a = await h.call([user("hi")]);
		assert.equal(a.msg.stopReason, "error");
		assert.match(a.msg.errorMessage ?? "", /boom/);
		assert.equal(h.created[0].dead, true);
	});

	it("aborts: interrupts Claude Code, closes the session and does not reuse it", async () => {
		const h = harness([[ev({ type: "message_start", message: { id: "m1", model: "x", usage: usage(1, 1) } })], [...apiMessage("m2", [{ text: "fresh" }], "end_turn"), result]]);
		const ac = new AbortController();
		const p = h.call([user("hi")], ac.signal);
		await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		const a = await p;
		assert.equal(a.msg.stopReason, "aborted");
		assert.equal(h.created[0].interrupted, true);
		assert.equal(h.created[0].dead, true);
		const b = await h.call([user("hi")]);
		assert.equal(h.created.length, 2);
		assert.equal(text(b.msg), "fresh");
	});
});

// ---- Routing ----------------------------------------------------------------------------------

describe("routing", () => {
	it("resumes Claude Code's own transcript at the anchor after a restart", async () => {
		const h = harness([[...apiMessage("msg_A", [{ text: "first" }], "end_turn"), result]]);
		const hist: Message[] = [user("one")];
		const a1 = await h.call(hist);
		h.provider.shutdown();
		// What Claude Code would have persisted for that session.
		const sid = h.created[0].sessionId;
		mkdirSync(projectDir(h.cwd), { recursive: true });
		writeFileSync(join(projectDir(h.cwd), `${sid}.jsonl`), `${JSON.stringify({ type: "assistant", uuid: "uuid-A", isSidechain: false, message: { id: "msg_A" } })}\n`);
		const h2 = harness([[...apiMessage("msg_B", [{ text: "second" }], "end_turn"), result]], h.registry);
		(h2 as any).provider.opts.cwd = () => h.cwd;
		hist.push(a1.msg, user("two"));
		const a2 = await h2.call(hist);
		assert.equal(a2.route, "resume");
		assert.deepEqual(h2.created[0].spec.resume, { sessionId: sid, at: "uuid-A" });
		assert.equal(text(a2.msg), "second");
	});

	it("synthesizes a session for history from another provider", async () => {
		const h = harness([[...apiMessage("m", [{ text: "ok" }], "end_turn"), result]]);
		const foreign = { role: "assistant", content: [{ type: "text", text: "hi from gpt" }], api: "openai-responses", provider: "openai", model: "gpt", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } as AssistantMessage;
		const a = await h.call([user("hello"), foreign, user("continue")]);
		assert.equal(a.route, "synth");
		assert.ok(h.created[0].spec.resume?.at);
		assert.deepEqual(h.created[0].sent[0], [{ type: "text", text: "continue" }]);
	});

	it("never attaches a second concurrent request to a busy session (F4)", async () => {
		const h = harness([[], [...apiMessage("m2", [{ text: "b" }], "end_turn"), result]]);
		const ac = new AbortController();
		const first = h.call([user("same")], ac.signal);
		await new Promise((r) => setTimeout(r, 10));
		const second = await h.call([user("same")]);
		assert.equal(h.created.length, 2, "the busy session was not shared");
		assert.equal(text(second.msg), "b");
		ac.abort();
		await first;
	});
});

// ---- Configuration, environment, models ------------------------------------------------------

describe("busy sessions", () => {
	it("a resume never closes a session another call is reading (R5)", async () => {
		const h = harness([[...apiMessage("msg_A", [{ text: "first" }], "end_turn"), result], [], [...apiMessage("msg_C", [{ text: "other branch" }], "end_turn"), result]]);
		const a1 = await h.call([user("one")]);
		const ac = new AbortController();
		const pending = h.call([user("one"), a1.msg, user("two")], ac.signal); // stays busy: no reply scripted
		await new Promise((r) => setTimeout(r, 10));
		const b = await h.call([user("one"), a1.msg, user("branch")]);
		assert.equal(h.created[0].dead, false, "the busy session survived");
		assert.equal(h.created.length, 2);
		assert.equal(text(b.msg), "other branch");
		ac.abort();
		await pending;
	});

	it("is busy from the moment it is selected, even while the model switch is pending (R2)", async () => {
		const h = harness([[...apiMessage("m1", [{ text: "a" }], "end_turn"), result], [...apiMessage("m2", [{ text: "b" }], "end_turn"), result], [...apiMessage("m3", [{ text: "c" }], "end_turn"), result]]);
		const a1 = await h.call([user("one")]);
		let release!: () => void;
		h.created[0].setModel = (m: string) => new Promise<void>((r) => (release = () => ((h.created[0].model = m), r())));
		const opus = { ...model, id: "claude-opus-5-5" } as Model<any>;
		const hist = [user("one"), a1.msg, user("two")];
		const first = h.provider.streamSimple(opus, normalizeContext({ systemPrompt: SYSTEM, tools, messages: hist }), { reasoning: "medium" as any }).result();
		await new Promise((r) => setTimeout(r, 10));
		const second = h.provider.streamSimple(opus, normalizeContext({ systemPrompt: SYSTEM, tools, messages: hist }), { reasoning: "medium" as any }).result();
		await new Promise((r) => setTimeout(r, 10));
		release();
		await Promise.all([first, second]);
		assert.equal(h.created.length, 2, "the second call did not share the session being switched");
	});

	it("eviction and the idle sweep skip busy sessions (R3)", async () => {
		const h = harness([[], [], [...apiMessage("m", [{ text: "c" }], "end_turn"), result]]);
		(h.provider as any).opts.maxSessions = 1;
		const ac = new AbortController();
		const a = h.call([user("a")], ac.signal);
		const b = h.call([user("b")], ac.signal);
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.created.length, 2);
		assert.equal(h.created.filter((s) => s.dead).length, 0, "no in-flight session was evicted");
		ac.abort();
		await Promise.all([a, b]);
	});
});

describe("configuration (F1)", () => {
	it("takes the Claude Code executable only from the agent directory or the environment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "proj-"));
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "claude-sdk.json"), JSON.stringify({ pathToClaudeCodeExecutable: "/tmp/evil", maxSessions: 5 }));
		assert.equal(resolveConfig({ cwd, agentDir, env: {} }).pathToClaudeCodeExecutable, undefined, "project config cannot pick the executable");
		assert.equal(resolveConfig({ cwd, agentDir, env: {} }).maxSessions, 5, "harmless project settings still apply");
		for (const bad of [{ maxSessions: "lots", idleMinutes: -1 }, { maxSessions: 0.5, idleMinutes: 1e9 }, { maxSessions: 1e6 }]) {
			writeFileSync(join(cwd, ".pi", "claude-sdk.json"), JSON.stringify(bad));
			assert.deepEqual(resolveConfig({ cwd, agentDir, env: {} }), { pathToClaudeCodeExecutable: undefined, promptMode: "claude" }, `ignored: ${JSON.stringify(bad)}`);
		}
		assert.deepEqual(resolveConfig({ cwd, agentDir, env: {} }), { pathToClaudeCodeExecutable: undefined, promptMode: "claude" }, "invalid project values are ignored");
		writeFileSync(join(agentDir, "claude-sdk.json"), JSON.stringify({ pathToClaudeCodeExecutable: "/opt/claude" }));
		assert.equal(resolveConfig({ cwd, agentDir, env: {} }).pathToClaudeCodeExecutable, "/opt/claude");
		assert.equal(resolveConfig({ cwd, agentDir, env: { PI_CLAUDE_SDK_CLAUDE_PATH: "/usr/bin/claude" } }).pathToClaudeCodeExecutable, "/usr/bin/claude");
	});
});

describe("child environment (F5, F6)", () => {
	const spec = { maxOutputTokens: 1000 } as SessionSpec;
	it("removes every switch that would move Claude Code off the subscription", () => {
		const env = childEnv(
			{ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1" },
			spec,
		);
		for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) assert.equal(env[k], undefined, k);
		assert.equal(env.PATH, "/bin");
		assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1000");
	});
	it("ignores the removed experiment switches", () => {
		const env = childEnv({ PI_CLAUDE_SDK_EXTRA_ENV: '{"ANTHROPIC_API_KEY":"k"}' }, spec);
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
	});
});

describe("model refresh (F7)", () => {
	it("keeps only Anthropic chat models", () => {
		const base = { reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 };
		const picked = anthropicChatModels([
			{ ...base, id: "claude-new-6", name: "New", provider: "anthropic" },
			{ ...base, id: "claude-new-6", name: "New", provider: "anthropic", type: "chat" },
			{ ...base, id: "claude-img", name: "Img", provider: "anthropic", type: "image" },
			{ ...base, id: "claude-cls", name: "Cls", provider: "anthropic", type: "classifier" },
			{ ...base, id: "gpt-x", name: "G", provider: "openai" },
		] as any);
		assert.deepEqual(picked.map((m) => m.id), ["claude-new-6", "claude-new-6"]);
	});
});
