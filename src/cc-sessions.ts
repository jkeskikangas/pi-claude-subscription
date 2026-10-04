import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantBlocks, type TurnMessage, userTurnBlocks } from "./convert.ts";

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
 * The uuid of the last transcript entry Claude Code wrote for API message `messageId`
 * (it stores one entry per content block). Resuming there keeps everything up to and
 * including that assistant message.
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
 * Write a Claude Code transcript for history that never ran through Claude Code (another
 * provider's turns, a compacted session, a session from before this extension). Returns the
 * session id and the uuid to resume at. `messages` must end with an assistant message.
 */
export function synthesizeSession(cwd: string, model: string, messages: TurnMessage[]): { sessionId: string; at: string } {
	const sessionId = randomUUID();
	const lines: string[] = [];
	let parent: string | null = null;
	const now = Date.now();
	const common = { isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd, sessionId };
	// Thinking signatures are only needed (and only checked) inside the trailing tool loop;
	// earlier thinking is dropped by the API anyway.
	let lastUserText = -1;
	messages.forEach((m, i) => {
		if (m.role === "user") lastUserText = i;
	});
	let i = 0;
	let n = 0;
	while (i < messages.length) {
		const uuid = randomUUID();
		const timestamp = new Date(now - (messages.length - i) * 1000).toISOString();
		const m = messages[i];
		if (m.role === "assistant") {
			const keepThinking = i > lastUserText && m.model === model && (m.api === "claude-agent-sdk" || m.api === "anthropic-messages");
			const content = assistantBlocks(m as AssistantMessage, keepThinking);
			lines.push(
				JSON.stringify({
					parentUuid: parent,
					...common,
					type: "assistant",
					message: {
						id: `msg_pi_${(n++).toString(36)}_${sessionId.slice(0, 8)}`,
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
	mkdirSync(projectDir(cwd), { recursive: true });
	writeFileSync(join(projectDir(cwd), `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
	return { sessionId, at: parent! };
}
