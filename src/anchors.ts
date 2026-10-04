import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where a conversation state lives in Claude Code's own session files: after the assistant
 * message `messageId` of session `sessionId`. Keyed by the pi transcript chain hash, so a pi
 * session that diverges from a live Claude Code process (abort, branch, restart) resumes the
 * exact bytes Claude Code sent before and keeps its prompt cache.
 */
export interface Anchor {
	sessionId: string;
	messageId: string;
	cwd: string;
}

const MAX_ENTRIES = 20_000;

export class AnchorRegistry {
	private map = new Map<string, Anchor>();
	private loaded = false;

	private readonly file: string;

	constructor(file = join(homedir(), ".pi", "agent", "claude-sdk", "anchors.jsonl")) {
		this.file = file;
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.file)) return;
		const lines = readFileSync(this.file, "utf8").split("\n");
		for (const line of lines) {
			if (!line) continue;
			try {
				const { k, s, m, c } = JSON.parse(line);
				this.map.set(k, { sessionId: s, messageId: m, cwd: c });
			} catch {}
		}
		if (lines.length > MAX_ENTRIES * 2) this.compact();
	}

	private compact(): void {
		const entries = [...this.map.entries()].slice(-MAX_ENTRIES);
		this.map = new Map(entries);
		writeFileSync(this.file, entries.map(([k, a]) => line(k, a)).join(""));
	}

	get(key: string): Anchor | undefined {
		this.load();
		return this.map.get(key);
	}

	put(key: string, anchor: Anchor): void {
		this.load();
		this.map.delete(key);
		this.map.set(key, anchor);
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, line(key, anchor));
		} catch {
			// Persistence is an optimization; the in-memory map still serves this process.
		}
	}
}

function line(k: string, a: Anchor): string {
	return `${JSON.stringify({ k, s: a.sessionId, m: a.messageId, c: a.cwd })}\n`;
}
