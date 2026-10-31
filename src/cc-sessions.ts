import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { assistantBlocks, toolResultBlock, type TurnMessage, userTurnBlocks } from "./convert.ts";

function projectsRoot(): string {
	return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** Claude Code's per-project session directory: the working directory's realpath, sanitized. */
export function projectDir(cwd: string): string {
	let real = cwd;
	try {
		real = realpathSync(cwd);
	} catch {}
	return join(projectsRoot(), real.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Path of a session's transcript, wherever Claude Code filed it. */
export function sessionFile(cwd: string, sessionId: string): string | undefined {
	const name = `${sessionId}.jsonl`;
	const direct = join(projectDir(cwd), name);
	if (existsSync(direct)) return direct;
	try {
		for (const dir of readdirSync(projectsRoot())) {
			const f = join(projectsRoot(), dir, name);
			if (existsSync(f)) return f;
		}
	} catch {}
	return undefined;
}

/**
 * Legacy-anchor fallback: the uuid of the last transcript entry Claude Code wrote for API
 * message `messageId` (it stores one entry per content block). New anchors capture this uuid
 * from the SDK stream instead; this scan serves anchors persisted before that was possible.
 */
export function findMessageUuid(cwd: string, sessionId: string, messageId: string): string | undefined {
	const file = sessionFile(cwd, sessionId);
	if (!file) return undefined;
	let uuid: string | undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes(messageId)) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "assistant" && e.message?.id === messageId && !e.isSidechain) uuid = e.uuid;
		} catch {}
	}
	return uuid;
}

/**
 * The uuid of the last entry Claude Code recorded before API message `messageId`: the end of the
 * user turn it answered, including the context Claude Code attached to it.
 */
export function findTurnStart(cwd: string, sessionId: string, messageId: string): string | undefined {
	const file = sessionFile(cwd, sessionId);
	if (!file) return undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes(messageId)) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "assistant" && e.message?.id === messageId && !e.isSidechain) return typeof e.parentUuid === "string" ? e.parentUuid : undefined;
		} catch {}
	}
	return undefined;
}

/** An assistant message written into a transcript: `index` is its position in the messages given. */
export interface WrittenEntry {
	index: number;
	messageId: string;
	uuid: string;
}

/**
 * Write a Claude Code transcript for history that never ran through Claude Code (another
 * provider's turns, a compacted session, a session from before this extension). Returns the
 * session id and the uuid to resume at. `messages` must end with an assistant message.
 */
export function synthesizeSession(cwd: string, model: string, messages: TurnMessage[], written?: WrittenEntry[]): { sessionId: string; at: string } {
	const sessionId = randomUUID();
	const { lines, last } = transcriptLines(cwd, sessionId, model, messages, null, written);
	mkdirSync(projectDir(cwd), { recursive: true });
	writeFileSync(join(projectDir(cwd), `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
	return { sessionId, at: last! };
}

/**
 * Claude Code records the tool results it was given right after an assistant entry, followed by
 * the context it attached to that turn. When `results` are exactly the results recorded after
 * entry `at`, return the uuid of the last entry before Claude Code's next assistant message:
 * forking there keeps the bytes Claude Code sent, and so its prompt cache, through that turn.
 */
export function findEndOfResults(cwd: string, sessionId: string, at: string, results: ToolResultMessage[]): string | undefined {
	const file = sessionFile(cwd, sessionId);
	if (!file || results.length === 0) return undefined;
	// File order: with parallel calls each result hangs off its own tool_use entry, so the results
	// do not form one parent chain, but Claude Code writes them right after the assistant entries.
	const entries: any[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line);
			if (!e.isSidechain && typeof e.uuid === "string") entries.push(e);
		} catch {}
	}
	let from = entries.findIndex((e) => e.uuid === at);
	if (from < 0) return undefined;
	// Claude Code writes one entry per content block; skip the rest of the anchor's message.
	const messageId = entries[from].message?.id;
	while (messageId && entries[from + 1]?.type === "assistant" && entries[from + 1].message?.id === messageId) from++;
	const recorded: string[] = [];
	let last: string | undefined;
	for (const e of entries.slice(from + 1)) {
		if (e.type === "assistant") break;
		if (e.type === "user") {
			const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
			// Anything but tool results (user text, a steering message) means it differs from pi's turn.
			if (blocks.length === 0 || blocks.some((b: any) => b?.type !== "tool_result")) return undefined;
			for (const { tool_use_id, content, is_error } of blocks) {
				const text = typeof content === "string" ? [{ type: "text", text: content }] : content;
				recorded.push(JSON.stringify({ type: "tool_result", tool_use_id, content: text, ...(is_error ? { is_error: true } : {}) }));
			}
		}
		last = e.uuid;
	}
	const expected = results.map((r) => JSON.stringify(toolResultBlock(r))).sort();
	recorded.sort();
	return recorded.length === expected.length && recorded.every((r, i) => r === expected[i]) ? last : undefined;
}

/**
 * Append history that Claude Code never ran to the end of an existing transcript, such as a fork
 * whose pi history continues differently. Returns the uuid to resume at, or undefined when the
 * transcript or its last message entry cannot be found.
 */
export function appendToSession(cwd: string, sessionId: string, model: string, messages: TurnMessage[], written?: WrittenEntry[]): string | undefined {
	const file = sessionFile(cwd, sessionId);
	if (!file) return undefined;
	let parent: string | undefined;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line);
			// Attachments (environment, date, ...) are part of the turn Claude Code sends: append after them.
			if ((e.type === "user" || e.type === "assistant" || e.type === "attachment") && !e.isSidechain && typeof e.uuid === "string") parent = e.uuid;
		} catch {}
	}
	if (!parent) return undefined;
	const { lines, last } = transcriptLines(cwd, sessionId, model, messages, parent, written);
	appendFileSync(file, `${lines.join("\n")}\n`);
	return last ?? undefined;
}

function transcriptLines(
	cwd: string,
	sessionId: string,
	model: string,
	messages: TurnMessage[],
	start: string | null,
	written?: WrittenEntry[],
): { lines: string[]; last: string | null } {
	const lines: string[] = [];
	let parent: string | null = start;
	const now = Date.now();
	const common = { isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd, sessionId };
	// Keep thinking on every assistant message of this model: Claude Code sends earlier thinking too,
	// so a re-written transcript must match the one written before or the prompt cache misses.
	let i = 0;
	let n = 0;
	while (i < messages.length) {
		const uuid = randomUUID();
		const timestamp = new Date(now - (messages.length - i) * 1000).toISOString();
		const m = messages[i];
		if (m.role === "assistant") {
			const keepThinking = m.model === model && (m.api === "claude-agent-sdk" || m.api === "anthropic-messages");
			const content = assistantBlocks(m as AssistantMessage, keepThinking);
			const id = `msg_pi_${(n++).toString(36)}_${uuid.slice(0, 8)}`;
			written?.push({ index: i, messageId: id, uuid });
			lines.push(
				JSON.stringify({
					parentUuid: parent,
					...common,
					type: "assistant",
					message: {
						id,
						type: "message",
						role: "assistant",
						model,
						content: content.length > 0 ? content : [{ type: "text", text: "(empty)" }],
						stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
						stop_sequence: null,
						usage: { input_tokens: 0, output_tokens: 0 },
					},
					uuid,
					timestamp,
				}),
			);
			i++;
		} else {
			let j = i;
			while (j < messages.length && messages[j].role !== "assistant") j++;
			const content = userTurnBlocks(messages.slice(i, j));
			lines.push(
				JSON.stringify({
					parentUuid: parent,
					...common,
					type: "user",
					message: { role: "user", content: content.length > 0 ? content : [{ type: "text", text: "(empty)" }] },
					uuid,
					timestamp,
				}),
			);
			i = j;
		}
		parent = uuid;
	}
	return { lines, last: parent };
}
