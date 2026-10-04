import { appendFileSync } from "node:fs";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.ts";
import { anthropicChatModels, claudeModels } from "./models.ts";
import { API, ClaudeSdkProvider } from "./provider.ts";

export const PROVIDER = "claude-sdk";

/**
 * pi extension: Claude models through the Claude Agent SDK, authenticated by the local Claude
 * Code login (Pro/Max subscription). pi keeps its own agent loop, tools, prompt and compaction;
 * Claude Code is used only as the authenticated model transport.
 */
export default function (pi: ExtensionAPI) {
	const config = resolveConfig({ cwd: process.cwd(), agentDir: getAgentDir(), env: process.env });
	const debugPath = process.env.PI_CLAUDE_SDK_DEBUG;
	const provider = new ClaudeSdkProvider({
		pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
		maxSessions: config.maxSessions,
		idleMs: config.idleMinutes ? config.idleMinutes * 60_000 : undefined,
		debug: debugPath ? (msg) => appendFileSync(debugPath, `${new Date().toISOString()} ${msg}\n`) : undefined,
	});

	const register = (models = claudeModels()) =>
		pi.registerProvider(PROVIDER, {
			name: "Claude (subscription via Agent SDK)",
			// Claude Code authenticates itself; pi only needs a non-empty key to treat the provider as configured.
			apiKey: "claude-code-login",
			api: API as any,
			baseUrl: "claude-agent-sdk://local",
			models,
			streamSimple: provider.streamSimple,
		});
	register();

	// Pick up Claude models newer than the bundled snapshot from pi's own catalog.
	let refreshed = false;
	pi.on("session_start", (_event, ctx) => {
		if (refreshed) return;
		refreshed = true;
		try {
			const live = anthropicChatModels(ctx.modelRegistry.getAll());
			const known = new Set(claudeModels().map((m) => m.id));
			if (live.some((m) => !/-\d{8}$/.test(m.id) && !known.has(m.id))) register(claudeModels(live));
		} catch {
			// The snapshot stays registered.
		}
	});

	pi.on("session_shutdown", () => provider.shutdown());
	process.once("exit", () => provider.shutdown());
}
