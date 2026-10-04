import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	pathToClaudeCodeExecutable?: string;
	maxSessions?: number;
	idleMinutes?: number;
}

function readJson(file: string): Config | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

const intIn = (lo: number, hi: number) => (n: unknown): n is number => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const validMaxSessions = intIn(1, 16);
const validIdleMinutes = intIn(1, 24 * 60);

/**
 * The global config (pi's agent directory) and the environment may choose the Claude Code
 * executable. A project's `.pi/claude-sdk.json` may only tune harmless settings: pi loads a
 * folder's executable resources only after project trust, and this file is read without it.
 */
export function resolveConfig(where: { cwd: string; agentDir: string; env: Record<string, string | undefined> }): Config {
	const global = readJson(join(where.agentDir, "claude-sdk.json")) ?? {};
	const project = readJson(join(where.cwd, ".pi", "claude-sdk.json")) ?? {};
	return {
		...global,
		...(validMaxSessions(project.maxSessions) ? { maxSessions: project.maxSessions } : {}),
		...(validIdleMinutes(project.idleMinutes) ? { idleMinutes: project.idleMinutes } : {}),
		pathToClaudeCodeExecutable: where.env.PI_CLAUDE_SDK_CLAUDE_PATH ?? global.pathToClaudeCodeExecutable,
	};
}
