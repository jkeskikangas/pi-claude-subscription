import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AnchorRegistry } from "./anchors.ts";
import { findMessageUuid, synthesizeSession } from "./cc-sessions.ts";
import { piToolName, readTranscript, type Transcript, type TurnMessage, userTurnBlocks, fingerprint } from "./convert.ts";
import { thinkingOptions } from "./models.ts";
import { errorText, LiveSession, type SessionSpec } from "./session.ts";
import { sha } from "./util.ts";

export const API = "claude-agent-sdk";

export interface ProviderOptions {
	pathToClaudeCodeExecutable?: string;
	/** Live Claude Code processes kept for reuse (one per concurrent conversation). */
	maxSessions?: number;
	/** Close a process idle this long; the conversation resumes from disk on its next turn. */
	idleMs?: number;
	registry?: AnchorRegistry;
	debug?: (msg: string) => void;
	cwd?: () => string;
}

/** How a request was attached to Claude Code; exposed for tests and the debug log. */
export type Route = "live" | "resume" | "synth" | "fresh";

export class ClaudeSdkProvider {
	private sessions: LiveSession[] = [];
	private readonly registry: AnchorRegistry;
	private readonly opts: Required<Omit<ProviderOptions, "registry" | "pathToClaudeCodeExecutable" | "debug">> & ProviderOptions;
	private timer?: NodeJS.Timeout;
	lastRoute?: Route;

	constructor(opts: ProviderOptions = {}) {
		this.registry = opts.registry ?? new AnchorRegistry();
		this.opts = { maxSessions: 3, idleMs: 20 * 60_000, cwd: () => process.cwd(), ...opts };
	}

	readonly streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		void this.run(model, context, options, stream, output);
		return stream;
	};

	private log(msg: string): void {
		this.opts.debug?.(msg);
	}

	private async run(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream, output: AssistantMessage): Promise<void> {
		let session: LiveSession | undefined;
		let started = false;
		const fail = (reason: "error" | "aborted", message: string) => {
			output.stopReason = reason;
			output.errorMessage = message;
			if (!started) stream.push({ type: "start", partial: output });
			stream.push({ type: "error", reason, error: output });
			stream.end();
		};
		try {
			if (options?.maxTokens === 1) {
				// A cache-warming replay. Claude Code keeps its own one-hour cache; answer without
				// touching the live session (a replay of an older context would otherwise end it).
				output.stopReason = "length";
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "length", message: output });
				stream.end();
				return;
			}
			const t = readTranscript(context);
			if (t.messages.length === 0 || t.messages[t.messages.length - 1].role === "assistant") {
				return fail("error", "pi-claude-subscription: the transcript must end with a user message or tool results");
			}
			const thinking = thinkingOptions(options?.reasoning, !!(model as any).thinkingLevelMap);
			const spec = {
				cwd: this.opts.cwd(),
				model: model.id,
				systemPrompt: t.systemPrompt,
				tools: t.tools,
				toolsHash: t.toolsHash,
				thinkingKey: JSON.stringify([thinking, options?.cacheRetention === "none"]),
				noCache: options?.cacheRetention === "none",
				...thinking,
				maxOutputTokens: options?.maxTokens ?? model.maxTokens,
				pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
				debug: this.opts.debug,
			} satisfies SessionSpec;

			const attached = await this.attach(t, spec);
			session = attached.session;
			this.lastRoute = attached.route;
			this.log(`route=${attached.route} session=${session.sessionId} prefix=${attached.prefix}/${t.messages.length}`);

			const payload = await options?.onPayload?.({ sessionId: session.sessionId, route: attached.route, model: model.id, tail: t.messages.length - attached.prefix }, model);
			void payload; // The request body is built inside Claude Code; there is nothing to replace.

			// Hand pi's new messages to Claude Code.
			const tail = t.messages.slice(attached.prefix);
			const results = tail.filter((m): m is ToolResultMessage => m.role === "toolResult");
			const rest = tail.filter((m) => m.role !== "toolResult");
			if (attached.route === "live" && session.awaiting.size > 0) {
				// Mid-turn: a message typed while tools ran is queued first so Claude Code adds it at
				// this tool boundary, then the parked tool calls are released.
				const extra = userTurnBlocks(rest);
				if (extra.length > 0) session.send(extra, "next");
				for (const r of results) session.deliver(r);
			} else {
				session.send(userTurnBlocks(tail));
			}
			session.chain = t.chain[t.messages.length];
			session.count = t.messages.length;

			const step = await this.readStep(session, model, options, stream, output, () => {
				started = true;
			});
			if (step === "aborted") return fail("aborted", "Request was aborted");
			if (!step.ok) {
				// Claude Code is in an unknown state after a failure; the next call resumes from disk.
				this.drop(session);
				return fail("error", step.error);
			}

			// Record the new conversation state so a later divergence can resume right here.
			session.chain = sha(`${session.chain}\0${fingerprint(output)}`);
			session.count += 1;
			if (step.messageId && session.spec.tools.length > 0) {
				this.registry.put(session.chain, { sessionId: session.sessionId, messageId: step.messageId, cwd: session.spec.cwd });
			}
			session.awaiting = new Set(output.content.filter((c): c is ToolCall => c.type === "toolCall").map((c) => c.id));
			if (output.stopReason !== "toolUse") session.awaiting.clear();
			stream.push({ type: "done", reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">, message: output });
			stream.end();
			if (session.spec.tools.length === 0) this.drop(session);
		} catch (e) {
			if (session) this.drop(session);
			fail(options?.signal?.aborted ? "aborted" : "error", errorText(e, session?.stderr));
		} finally {
			this.scheduleSweep();
		}
	}

	/**
	 * Find or create the Claude Code process for this transcript. In order of preference:
	 * a live process that has consumed a prefix of it; a persisted Claude Code session resumed
	 * at the longest known prefix; a synthesized session; a fresh one.
	 */
	private async attach(t: Transcript, spec: SessionSpec): Promise<{ session: LiveSession; prefix: number; route: Route }> {
		const n = t.messages.length;
		for (const s of this.sessions) {
			if (s.dead || s.systemPrompt !== t.systemPrompt || s.spec.toolsHash !== t.toolsHash || s.spec.thinkingKey !== spec.thinkingKey) continue;
			if (s.count > n || t.chain[s.count] !== s.chain) continue;
			const tail = t.messages.slice(s.count);
			if (tail.some((m) => m.role === "assistant")) continue;
			const resultIds = new Set(tail.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => m.toolCallId));
			if (s.awaiting.size > 0 && ![...s.awaiting].every((id) => resultIds.has(id))) continue;
			if (s.awaiting.size === 0 && [...resultIds].some((id) => !s.servedByClaude.has(id))) continue;
			if (s.model !== spec.model) await s.setModel(spec.model);
			s.lastUsed = Date.now();
			return { session: s, prefix: s.count, route: "live" };
		}

		// Longest prefix ending in an assistant message that Claude Code has on disk.
		let resume: { sessionId: string; at: string } | undefined;
		let prefix = 0;
		let route: Route = "fresh";
		for (let k = n - 1; k >= 1 && spec.tools.length > 0; k--) {
			if (t.messages[k - 1].role !== "assistant") continue;
			const a = this.registry.get(t.chain[k]);
			if (!a || a.cwd !== spec.cwd) continue;
			// A live process on that session is stale by now. It must be gone before we resume:
			// Claude Code resumes a session that is still open as a copy, without its context
			// attachments, which changes the prompt prefix and loses the cache.
			for (const s of this.sessions) if (s.sessionId === a.sessionId) this.drop(s);
			await this.waitExited(a.sessionId);
			const at = findMessageUuid(a.cwd, a.sessionId, a.messageId);
			if (!at) {
				this.log(`anchor ${a.sessionId}/${a.messageId} not found on disk`);
				continue;
			}
			resume = { sessionId: a.sessionId, at };
			prefix = k;
			route = "resume";
			break;
		}
		if (!resume) {
			let last = -1;
			t.messages.forEach((m, i) => {
				if (m.role === "assistant") last = i;
			});
			if (last >= 0) {
				resume = synthesizeSession(spec.cwd, spec.model, t.messages.slice(0, last + 1));
				prefix = last + 1;
				route = "synth";
			}
		}
		const session = new LiveSession({ ...spec, resume }, t.chain[prefix], prefix);
		this.sessions.push(session);
		this.evict();
		return { session, prefix, route };
	}

	/**
	 * Consume Claude Code events until the current API response ends, emitting pi events.
	 * Returns the API message id, "aborted", or an error.
	 */
	private async readStep(
		session: LiveSession,
		model: Model<Api>,
		options: SimpleStreamOptions | undefined,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
		onStart: () => void,
	): Promise<{ ok: true; messageId?: string } | "aborted" | { ok: false; error: string }> {
		const signal = options?.signal;
		type Block = (TextContent | ThinkingContent | (ToolCall & { partialJson?: string })) & { index?: number };
		const blocks = output.content as Block[];
		let started = false;
		let messageId: string | undefined;
		let stopReason: string | undefined;
		const start = () => {
			if (started) return;
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		};
		const setUsage = (u: any) => {
			if (!u) return;
			if (u.input_tokens != null) output.usage.input = u.input_tokens;
			if (u.output_tokens != null) output.usage.output = u.output_tokens;
			if (u.cache_read_input_tokens != null) output.usage.cacheRead = u.cache_read_input_tokens;
			if (u.cache_creation_input_tokens != null) output.usage.cacheWrite = u.cache_creation_input_tokens;
			if (u.cache_creation?.ephemeral_1h_input_tokens != null) output.usage.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
			output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			output.usage.cost = calculateCost(model, output.usage);
		};
		const onAbort = () => void session.interrupt();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for (;;) {
				let m: any;
				try {
					m = await session.events.next(signal);
				} catch {
					this.drop(session);
					return "aborted";
				}
				if (m === undefined) return { ok: false, error: errorText(new Error("Claude Code exited unexpectedly"), session.stderr) };
				if (m.type === "pi_error") return { ok: false, error: m.error };
				if (m.type === "stream_event" && !m.parent_tool_use_id) {
					const ev = m.event;
					await options?.onProviderStreamEvent?.(ev, model);
					switch (ev.type) {
						case "message_start":
							// Claude Code retried a response that failed mid-stream: keep only the retry.
							if (blocks.length > 0) blocks.length = 0;
							messageId = ev.message.id;
							output.responseId = ev.message.id;
							output.responseModel = ev.message.model;
							setUsage(ev.message.usage);
							start();
							break;
						case "content_block_start": {
							start();
							const cb = ev.content_block;
							if (cb.type === "text") {
								blocks.push({ type: "text", text: "", index: ev.index });
								stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
							} else if (cb.type === "thinking") {
								blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: ev.index });
								stream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
							} else if (cb.type === "redacted_thinking") {
								blocks.push({ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: cb.data, redacted: true, index: ev.index });
								stream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
							} else if (cb.type === "tool_use") {
								blocks.push({ type: "toolCall", id: cb.id, name: piToolName(cb.name), arguments: {}, partialJson: "", index: ev.index });
								stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
							}
							break;
						}
						case "content_block_delta": {
							const i = blocks.findIndex((b) => b.index === ev.index);
							const b = blocks[i];
							if (!b) break;
							const d = ev.delta;
							if (d.type === "text_delta" && b.type === "text") {
								b.text += d.text;
								stream.push({ type: "text_delta", contentIndex: i, delta: d.text, partial: output });
							} else if (d.type === "thinking_delta" && b.type === "thinking") {
								b.thinking += d.thinking;
								stream.push({ type: "thinking_delta", contentIndex: i, delta: d.thinking, partial: output });
							} else if (d.type === "signature_delta" && b.type === "thinking") {
								b.thinkingSignature = (b.thinkingSignature ?? "") + d.signature;
							} else if (d.type === "input_json_delta" && b.type === "toolCall") {
								b.partialJson = (b.partialJson ?? "") + d.partial_json;
								stream.push({ type: "toolcall_delta", contentIndex: i, delta: d.partial_json, partial: output });
							}
							break;
						}
						case "content_block_stop": {
							const i = blocks.findIndex((b) => b.index === ev.index);
							const b = blocks[i];
							if (!b) break;
							delete b.index;
							if (b.type === "text") stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: output });
							else if (b.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: output });
							else if (b.type === "toolCall") {
								try {
									b.arguments = b.partialJson ? JSON.parse(b.partialJson) : {};
								} catch {
									b.arguments = {};
								}
								delete b.partialJson;
								stream.push({ type: "toolcall_end", contentIndex: i, toolCall: b, partial: output });
							}
							break;
						}
						case "message_delta":
							stopReason = ev.delta?.stop_reason ?? stopReason;
							setUsage(ev.usage);
							break;
						case "message_stop":
							for (const b of blocks) delete b.index;
							output.stopReason = mapStop(stopReason);
							return { ok: true, messageId };
					}
				} else if (m.type === "assistant" && m.error && !started) {
					const text = (m.message?.content ?? []).map((c: any) => c.text ?? "").join("");
					return { ok: false, error: text || `Claude Code error: ${m.error}` };
				} else if (m.type === "result" && (m.is_error || m.subtype !== "success")) {
					// Success results close turns whose last response was already streamed; only failures matter.
					return { ok: false, error: (m.errors ?? []).join("\n") || m.result || `Claude Code ${m.subtype}` };
				}
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private closing = new Map<string, Promise<void>>();

	private drop(s: LiveSession): void {
		s.close();
		this.sessions = this.sessions.filter((x) => x !== s);
		const exited = s.exited.finally(() => {
			if (this.closing.get(s.sessionId) === exited) this.closing.delete(s.sessionId);
		});
		this.closing.set(s.sessionId, exited);
	}

	private async waitExited(sessionId: string): Promise<void> {
		const p = this.closing.get(sessionId);
		if (p) await Promise.race([p, new Promise((r) => setTimeout(r, 10_000).unref())]);
	}

	private evict(): void {
		const live = this.sessions.filter((s) => !s.dead);
		this.sessions = live;
		while (this.sessions.length > this.opts.maxSessions) {
			const oldest = [...this.sessions].sort((a, b) => a.lastUsed - b.lastUsed)[0];
			this.drop(oldest);
		}
	}

	private scheduleSweep(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			const now = Date.now();
			for (const s of [...this.sessions]) if (s.awaiting.size === 0 && now - s.lastUsed > this.opts.idleMs) this.drop(s);
			if (this.sessions.length === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		}, 60_000);
		this.timer.unref();
	}

	shutdown(): void {
		for (const s of [...this.sessions]) this.drop(s);
	}
}

function mapStop(reason: string | undefined): StopReason {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		default:
			return "stop";
	}
}

export type { TurnMessage };
