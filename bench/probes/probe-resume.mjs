// Probe: resume a persisted session at an assistant tool_use entry and deliver the tool_result
// as a pushed user message. Usage: node probe-resume.mjs <sessionId> <assistantUuid> <toolUseId> <tag>
import { query } from "@anthropic-ai/claude-agent-sdk";

const [sessionId, at, toolUseId, tag = "probe-resume"] = process.argv.slice(2);
async function* input() {
	yield {
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "contents of a.txt: GOODBYE moon" }] }] },
		parent_tool_use_id: null,
	};
	await new Promise((r) => setTimeout(r, 20000));
}
const q = query({
	prompt: input(),
	options: {
		model: "claude-sonnet-5-5",
		systemPrompt: "You are a terse coding assistant.",
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		resume: sessionId,
		resumeSessionAt: at,
		title: "pi",
		permissionMode: "bypassPermissions",
		effort: "high",
		env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:8787/run/${tag}` },
	},
});
const t0 = Date.now();
for await (const m of q) {
	console.log(Date.now() - t0, m.type, m.subtype ?? "", JSON.stringify(m).slice(0, 250));
	if (m.type === "result") break;
}
q.close();
