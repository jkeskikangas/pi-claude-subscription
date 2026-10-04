#!/usr/bin/env node
// Multi-turn session benchmark: the same scripted conversation in one long-lived process per
// harness (pi --mode rpc with this provider vs claude --input-format stream-json), as an
// interactive user would run it. Records per-turn wall time and per-request usage via the proxy.
//   node bench/session.mjs --arms pi,claude --reps 2
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
	options: {
		arms: { type: "string", default: "pi,claude" },
		reps: { type: "string", default: "2" },
		model: { type: "string", default: "claude-sonnet-5-5" },
		effort: { type: "string", default: "medium" },
		label: { type: "string", default: "session" },
		out: { type: "string", default: join(root, "bench/out/session-results.jsonl") },
	},
});
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8787";

const TURNS = [
	"Read the README and the source files, then give me a three-sentence overview of this project.",
	"median() in src/stats.js is wrong for even-length input and sorts numbers as strings. Fix it and add a test file test/stats.test.js covering both cases. Run the tests.",
	"Now add a `low` command to the CLI: `stockroom low <items.csv> <threshold> [movements.csv]` prints SKUs below the threshold, one per line, sorted, exit code 0. Mention it in the usage line. Run the tests.",
	"Bulk pricing should apply at qty >= minQty (it currently needs qty > minQty). Fix it, and make the price cache key include the rules so different rule sets don't share cached prices. Run the tests.",
	"Summarize all the changes you made in this session as a short bullet list.",
];

function verify(dir) {
	const checks = { median: "median.verify.js", low: "cli-low.verify.js", pricing: "pricing.verify.js" };
	const res = {};
	for (const [k, f] of Object.entries(checks)) {
		cpSync(join(root, "bench/tasks", f), join(dir, "test", `zz_${k}.test.js`));
		try {
			execFileSync("node", ["--test", `test/zz_${k}.test.js`], { cwd: dir, stdio: "pipe", timeout: 60_000 });
			res[k] = true;
		} catch {
			res[k] = false;
		}
		rmSync(join(dir, "test", `zz_${k}.test.js`));
	}
	try {
		execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 120_000 });
		res.suite = true;
	} catch {
		res.suite = false;
	}
	return res;
}

/** The environment of a plain terminal: no API key, no Claude Code identity inherited from a parent session. */
function cleanEnv() {
	const env = { ...process.env };
	for (const k of ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
	return env;
}

function lines(child, onEvent) {
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			try {
				onEvent(JSON.parse(line));
			} catch {}
		}
	});
}

async function runPi(dir, tag) {
	const agentDir = join(tmpdir(), "pi-claude-bench", "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	const child = spawn(
		join(root, "node_modules/.bin/pi"),
		["--mode", "rpc", "--no-extensions", "-e", join(root, "src/index.ts"), "--no-skills", "--no-session", "--model", `claude-sdk/${args.model}`, "--thinking", args.effort],
		{ cwd: dir, env: { ...cleanEnv(), ANTHROPIC_BASE_URL: `${PROXY}/run/${tag}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "inherit"] },
	);
	let waiter;
	lines(child, (ev) => {
		if (ev.type === "agent_settled" && waiter) waiter();
	});
	const turns = [];
	for (const text of TURNS) {
		const t0 = Date.now();
		const done = new Promise((r) => (waiter = r));
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: text })}\n`);
		await done;
		turns.push(Date.now() - t0);
	}
	child.kill();
	return turns;
}

async function runClaude(dir, tag) {
	const child = spawn(
		"claude",
		["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", args.model, "--effort", args.effort, "--setting-sources", "", "--strict-mcp-config", "--dangerously-skip-permissions"],
		{ cwd: dir, env: { ...cleanEnv(), ANTHROPIC_BASE_URL: `${PROXY}/run/${tag}` }, stdio: ["pipe", "pipe", "inherit"] },
	);
	let waiter;
	lines(child, (ev) => {
		if (ev.type === "result" && waiter) waiter();
	});
	const turns = [];
	for (const text of TURNS) {
		const t0 = Date.now();
		const done = new Promise((r) => (waiter = r));
		child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })}\n`);
		await done;
		turns.push(Date.now() - t0);
	}
	child.stdin.end();
	child.kill();
	return turns;
}

function requests(tag) {
	const file = join(root, "bench/out/proxy", `${tag}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))
		.filter((r) => r.path?.startsWith("/v1/messages") && r.usage?.input_tokens != null)
		.map((r) => ({ t: r.t, model: r.model, ms: r.ms, ttfbMs: r.ttfbMs, msgs: r.messages, ...r.usage, cache_creation: undefined }));
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const arms = args.arms.split(",");
for (let rep = 0; rep < Number(args.reps); rep++) {
	for (const arm of rep % 2 ? [...arms].reverse() : arms) {
		const tag = `sess-${stamp}-${arm}-r${rep}`;
		const dir = join(tmpdir(), "pi-claude-bench", tag);
		rmSync(dir, { recursive: true, force: true });
		cpSync(join(root, "bench/fixture"), dir, { recursive: true });
		execFileSync("sh", ["-c", "git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -qm fixture"], { cwd: dir });
		const t0 = Date.now();
		const turns = arm === "pi" ? await runPi(dir, tag) : await runClaude(dir, tag);
		const wallMs = Date.now() - t0;
		await new Promise((r) => setTimeout(r, 2000));
		const checks = verify(dir);
		const reqs = requests(tag);
		const rec = { label: args.label, tag, arm, rep, model: args.model, effort: args.effort, wallMs, turns, checks, requests: reqs };
		appendFileSync(args.out, `${JSON.stringify(rec)}\n`);
		const sum = (k) => reqs.reduce((a, r) => a + (r[k] ?? 0), 0);
		console.log(`${arm.padEnd(6)} r${rep} ${(wallMs / 1000).toFixed(1)}s turns=${turns.map((t) => (t / 1000).toFixed(1)).join("/")} checks=${JSON.stringify(checks)} req=${reqs.length} in=${sum("input_tokens")} cr=${sum("cache_read_input_tokens")} cw=${sum("cache_creation_input_tokens")} out=${sum("output_tokens")}`);
	}
}
