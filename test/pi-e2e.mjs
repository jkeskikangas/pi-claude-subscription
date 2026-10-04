// End-to-end through pi's own agent loop (pi --mode rpc, real tools, real Claude Code).
//   steer   - a steering message sent while bash runs reaches the model at that tool boundary
//   compact - pi's /compact (a tool-less summarization request) then continue the session
//   switch  - change the thinking level mid-session
//   image   - image input in a user prompt
// Usage: node test/pi-e2e.mjs <scenario>   (honours ANTHROPIC_BASE_URL for the bench proxy)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.argv[2] ?? "steer";
const cwd = mkdtempSync(join(tmpdir(), "pi-e2e-"));
writeFileSync(join(cwd, "data.txt"), "alpha\nbeta\ngamma\n");
const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
mkdirSync(agentDir, { recursive: true });
// Tiny keep-recent budget so /compact has something to summarize in a short session.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

const child = spawn(
	join(root, "node_modules/.bin/pi"),
	["--mode", "rpc", "--no-extensions", "-e", join(root, "src/index.ts"), "--no-skills", "--no-session", "--model", `claude-sdk/${process.env.MODEL ?? "claude-sonnet-5-5"}`, "--thinking", "low"],
	{ cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "inherit"] },
);
let buf = "";
const listeners = new Set();
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		try {
			const ev = JSON.parse(line);
			for (const l of listeners) l(ev);
		} catch {}
	}
});
let seq = 0;
const send = (cmd) => child.stdin.write(`${JSON.stringify({ id: `r${++seq}`, ...cmd })}\n`);
const waitFor = (pred, ms = 240_000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		const l = (ev) => {
			if (pred(ev)) {
				clearTimeout(t);
				listeners.delete(l);
				resolve(ev);
			}
		};
		listeners.add(l);
	});
const log = [];
listeners.add((ev) => {
	if (ev.type === "tool_execution_start") log.push(`tool:${ev.toolName}`);
	if (ev.type === "message_end" && ev.message?.role === "assistant")
		log.push(`assistant[${ev.message.stopReason}] ${ev.message.content.map((c) => c.text ?? c.type).join(" | ").slice(0, 160)}${ev.message.errorMessage ? ` ERR ${ev.message.errorMessage}` : ""}`);
});
async function prompt(message, extra = {}) {
	send({ type: "prompt", message, ...extra });
	await waitFor((e) => e.type === "agent_settled");
}
async function lastText() {
	send({ type: "get_last_assistant_text" });
	const r = await waitFor((e) => e.type === "response" && e.command === "get_last_assistant_text");
	return r.data?.text ?? "";
}

let ok = false;
try {
	if (scenario === "steer") {
		let steered = false;
		listeners.add((e) => {
			if (e.type === "tool_execution_start" && !steered) {
				steered = true;
				send({ type: "steer", message: "Additional requirement: end your final answer with the word KIWI." });
			}
		});
		await prompt("Run `sleep 3 && wc -l data.txt` with bash and tell me the line count.");
		const t = await lastText();
		ok = /3/.test(t) && /KIWI/.test(t);
	} else if (scenario === "compact") {
		await prompt("Read data.txt and remember its words. Reply with just OK.");
		send({ type: "compact" });
		const r = await waitFor((e) => e.type === "response" && e.command === "compact", 240_000);
		log.push(`compact: ${r.success} ${JSON.stringify(r.data ?? r.error).slice(0, 200)}`);
		await prompt("Which word in data.txt comes second? Answer from memory, one word.");
		ok = /beta/i.test(await lastText());
	} else if (scenario === "switch") {
		await prompt("Reply with just: one");
		send({ type: "set_thinking_level", level: "high" });
		await waitFor((e) => e.type === "response" && e.command === "set_thinking_level");
		await prompt("Reply with just: two");
		ok = /two/i.test(await lastText());
	} else if (scenario === "image") {
		// 8x8 red PNG
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
		await prompt("What single color fills this image? One word.", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
		ok = /red/i.test(await lastText());
	}
	console.log(log.join("\n"));
	console.log(`final: ${await lastText()}`);
} catch (e) {
	console.log(log.join("\n"));
	console.log(`error: ${e.message}`);
}
console.log(ok ? "PASS" : "FAIL");
child.kill();
process.exit(ok ? 0 : 1);
