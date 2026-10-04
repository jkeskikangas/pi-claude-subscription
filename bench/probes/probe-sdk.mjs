// Probe: what does the Agent SDK send when given a custom system prompt and only MCP tools?
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const tag = process.argv[2] ?? "probe-sdk";
const server = createSdkMcpServer({
	name: "pi",
	version: "1.0.0",
	tools: [
		tool("read", "Read a file", { path: z.string() }, async ({ path }, extra) => (console.log("EXTRA", JSON.stringify(extra?._meta), Object.keys(extra??{})), {
			content: [{ type: "text", text: `contents of ${path}: hello world` }],
		})),
	],
});

async function* input() {
	yield { type: "user", message: { role: "user", content: "Read the file a.txt with the read tool, then tell me what it says." }, parent_tool_use_id: null };
	await new Promise((r) => setTimeout(r, 15000));
}

const q = query({
	prompt: input(),
	options: {
		model: "claude-sonnet-5-5",
		systemPrompt: "You are a terse coding assistant.",
		tools: [],
		mcpServers: { pi: server },
		allowedTools: ["mcp__pi__read"],
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		includePartialMessages: true,
		permissionMode: "bypassPermissions",
		...JSON.parse(process.env.EXTRA ?? "{}"),
		env: { ...process.env, ...JSON.parse(process.env.XENV ?? "{}"), ANTHROPIC_BASE_URL: `http://127.0.0.1:8787/run/${tag}` },
	},
});
const t0 = Date.now();
for await (const m of q) {
	if (m.type === "stream_event") continue;
	console.log(Date.now() - t0, m.type, m.subtype ?? "", JSON.stringify(m).slice(0, 300));
	if (m.type === "result") break;
}
q.close();
