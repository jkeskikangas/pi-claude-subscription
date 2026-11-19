import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantBlocks, type TurnMessage, userTurnBlocks } from "./convert.ts";

/** `configDir` is the Claude Code config dir a provider runs with; omitted, the process-wide one. */
function projectsRoot(configDir?: string): string {
	return join(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** Claude Code's per-project session directory: the working directory's realpath, sanitized. */
export function projectDir(cwd: string, configDir?: string): string {
	let real = cwd;
	try {
		real = realpathSync(cwd);
	} catch {}
	return join(projectsRoot(configDir), real.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Path of a session's transcript, wherever Claude Code filed it. */
export function sessionFile(cwd: string, sessionId: string, configDir?: string): string | undefined {
	const name = `${sessionId}.jsonl`;
	const direct = join(projectDir(cwd, configDir), name);
	if (existsSync(direct)) return direct;
	try {
		for (const dir of readdirSync(projectsRoot(configDir))) {
			const f = join(projectsRoot(configDir), dir, name);
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
export function findMessageUuid(cwd: string, sessionId: string, messageId: string, configDir?: string): string | undefined {
	const file = sessionFile(cwd, sessionId, configDir);
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
export function synthesizeSession(cwd: string, model: string, messages: TurnMessage[], configDir?: string): { sessionId: string; at: string } {
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
	mkdirSync(projectDir(cwd, configDir), { recursive: true });
	writeFileSync(join(projectDir(cwd, configDir), `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
	return { sessionId, at: parent! };
}

/**
 * Agent SDK session store over the transcript files of one Claude Code config dir. The SDK's
 * session functions read the process environment for that dir; this lets them work on a
 * provider's own dir without touching `process.env`.
 */
export function configDirStore(cwd: string, configDir: string): SessionStore {
	const file = (key: SessionKey) => {
		const name = key.subpath ? join(key.sessionId, `${key.subpath}.jsonl`) : `${key.sessionId}.jsonl`;
		return (!key.subpath && sessionFile(cwd, key.sessionId, configDir)) || join(projectDir(cwd, configDir), name);
	};
	return {
		async load(key) {
			const f = file(key);
			if (!existsSync(f)) return null;
			return readFileSync(f, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as SessionStoreEntry);
		},
		async append(key, entries) {
			const f = file(key);
			mkdirSync(join(f, ".."), { recursive: true });
			appendFileSync(f, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
		},
	};
}
