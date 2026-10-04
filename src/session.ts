import { randomUUID } from "node:crypto";
import { type Query, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { MCP_PREFIX, MCP_SERVER, toolUseId } from "./convert.ts";
import { AsyncQueue } from "./util.ts";

export interface SessionSpec {
	cwd: string;
	model: string;
	systemPrompt: string;
	tools: Tool[];
	toolsHash: string;
	thinkingKey: string;
	thinking: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budgetTokens: number };
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	maxOutputTokens?: number;
	/** pi asked for no prompt caching (cacheRetention "none"). */
	noCache?: boolean;
	/** Resume this Claude Code session, cut after `at`. Omit for a fresh session. */
	resume?: { sessionId: string; at: string };
	pathToClaudeCodeExecutable?: string;
	debug?: (msg: string) => void;
}

type CallToolResult = { content: any[]; isError?: boolean };

/**
 * One Claude Code process in streaming-input mode, holding one conversation. pi owns the agent
 * loop: Claude Code's tool calls reach pi's tools through an in-process MCP server whose
 * handlers park until pi delivers the tool results on its next provider call.
 */
export class LiveSession {
	readonly spec: SessionSpec;
	readonly sessionId: string;
	readonly systemPrompt: string;
	model: string;
	/** Chain hash and length of the pi transcript this process has consumed. */
	chain: string;
	count: number;
	/** Tool calls of the last step that pi has not answered yet. */
	awaiting = new Set<string>();
	/** Tool calls Claude Code answered itself (unknown tool names); pi's results for them are ignored. */
	servedByClaude = new Set<string>();
	dead = false;
	lastUsed = Date.now();
	readonly events = new AsyncQueue<SDKMessage>();
	/** Resolves once the Claude Code process has exited. */
	readonly exited: Promise<void>;
	private markExited!: () => void;

	private readonly q: Query;
	private readonly input = new AsyncQueue<SDKUserMessage>();
	private readonly parked = new Map<string, { resolve: (r: CallToolResult) => void; reject: (e: Error) => void }>();
	private readonly ready = new Map<string, CallToolResult>();
	private stderrTail = "";

	constructor(spec: SessionSpec, chain: string, count: number) {
		this.spec = spec;
		this.model = spec.model;
		this.systemPrompt = spec.systemPrompt;
		this.chain = chain;
		this.count = count;
		this.sessionId = spec.resume?.sessionId ?? randomUUID();
		this.exited = new Promise((r) => {
			this.markExited = r;
		});

		const persist = spec.tools.length > 0;
		const env: Record<string, string | undefined> = {
			...process.env,
			// Subscription auth: never let an inherited API key switch Claude Code to API billing.
			ANTHROPIC_API_KEY: undefined,
			ANTHROPIC_AUTH_TOKEN: undefined,
			CLAUDECODE: undefined,
			CLAUDE_AGENT_SDK_CLIENT_APP: "pi-claude-subscription/0.1.0",
			// pi owns context management: no compaction, no output-size cap on tool results.
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
			MAX_MCP_OUTPUT_TOKENS: "10000000",
			MCP_TOOL_TIMEOUT: String(7 * 24 * 3600 * 1000),
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
			CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
			...(process.env.PI_CLAUDE_SDK_EXTRA_ENV ? JSON.parse(process.env.PI_CLAUDE_SDK_EXTRA_ENV) : {}),
			...(spec.noCache ? { DISABLE_PROMPT_CACHING: "1" } : {}),
			...(spec.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxOutputTokens) } : {}),
		};

		this.q = query({
			prompt: this.input,
			options: {
				cwd: spec.cwd,
				model: spec.model,
				systemPrompt: spec.systemPrompt,
				tools: [],
				mcpServers: spec.tools.length > 0 ? { [MCP_SERVER]: { type: "sdk", name: MCP_SERVER, instance: this.mcpServer(spec.tools) } } : {},
				allowedTools: spec.tools.map((t) => MCP_PREFIX + t.name),
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: [],
				strictMcpConfig: true,
				includePartialMessages: true,
				verbatimPrompts: process.env.PI_CLAUDE_SDK_VERBATIM !== "0",
				persistSession: persist,
				title: "pi",
				thinking: spec.thinking,
				...(spec.effort ? { effort: spec.effort } : {}),
				...(spec.resume ? { resume: spec.resume.sessionId, resumeSessionAt: spec.resume.at } : { sessionId: this.sessionId }),
				...(spec.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: spec.pathToClaudeCodeExecutable } : {}),
				env,
				stderr: (d) => {
					this.stderrTail = (this.stderrTail + d).slice(-2000);
				},
			},
		});
		void this.pump();
	}

	private mcpServer(tools: Tool[]): McpServer {
		const server = new McpServer({ name: MCP_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
		const list = tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: { type: "object", ...(JSON.parse(JSON.stringify(t.parameters ?? {})) as object) },
		}));
		server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list as any }));
		server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
			const id = (req.params as any)?._meta?.["claudecode/toolUseId"] as string | undefined;
			if (!id) return { content: [{ type: "text", text: "pi bridge: tool call without a tool_use id" }], isError: true };
			const done = this.ready.get(id);
			if (done) {
				this.ready.delete(id);
				return done as any;
			}
			return new Promise<CallToolResult>((resolve, reject) => this.parked.set(id, { resolve, reject })) as any;
		});
		return server;
	}

	private async pump(): Promise<void> {
		try {
			for await (const m of this.q) {
				if (m.type === "user" && !m.parent_tool_use_id && Array.isArray(m.message.content)) {
					// A tool_result Claude Code produced without asking pi (e.g. an unknown tool name).
					for (const b of m.message.content as any[]) {
						if (b.type === "tool_result" && !this.parkedOrDelivered(b.tool_use_id)) this.servedByClaude.add(b.tool_use_id);
					}
				}
				this.events.push(m);
			}
		} catch (e) {
			this.events.push({ type: "pi_error", error: errorText(e, this.stderrTail) } as any);
		} finally {
			this.dead = true;
			this.events.close();
			for (const p of this.parked.values()) p.reject(new Error("Claude Code session ended"));
			this.parked.clear();
			this.markExited();
		}
	}

	private delivered = new Set<string>();
	private parkedOrDelivered(id: string): boolean {
		return this.parked.has(id) || this.delivered.has(id) || this.ready.has(id);
	}

	/** Start a user turn (or continue after tool results when resuming). */
	send(content: any[], priority?: "now" | "next" | "later"): void {
		this.lastUsed = Date.now();
		this.input.push({
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
			...(priority ? { priority } : {}),
		} as SDKUserMessage);
	}

	/** Answer a parked (or soon to be issued) MCP tool call with pi's result. */
	deliver(result: ToolResultMessage): void {
		const id = toolUseId(result.toolCallId);
		this.awaiting.delete(id);
		if (this.servedByClaude.has(id)) return;
		this.delivered.add(id);
		const r: CallToolResult = {
			content: result.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType })),
			...(result.isError ? { isError: true } : {}),
		};
		if (r.content.length === 0) r.content.push({ type: "text", text: "(no output)" });
		const p = this.parked.get(id);
		if (p) {
			this.parked.delete(id);
			p.resolve(r);
		} else this.ready.set(id, r);
	}

	async setModel(model: string): Promise<void> {
		if (model === this.model) return;
		await this.q.setModel(model);
		this.model = model;
	}

	async interrupt(): Promise<void> {
		try {
			await this.q.interrupt();
		} catch {}
	}

	close(): void {
		if (this.dead) return;
		this.dead = true;
		this.input.close();
		try {
			this.q.close();
		} catch {}
	}

	get stderr(): string {
		return this.stderrTail;
	}
}

export function errorText(e: unknown, stderr = ""): string {
	const msg = e instanceof Error ? e.message : String(e);
	return stderr.trim() ? `${msg}\n${stderr.trim().split("\n").slice(-5).join("\n")}` : msg;
}
