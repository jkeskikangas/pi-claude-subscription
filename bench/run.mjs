#!/usr/bin/env node
// Benchmark: pi + this provider vs Claude Code, same model and effort, same tasks.
//   node bench/run.mjs --arms pi,claude --reps 2 [--tasks a,b] [--model claude-sonnet-5-5] [--effort medium]
// Needs bench/proxy.mjs running (PROXY, default http://127.0.0.1:8787). Every API call of a run
// is logged under its tag, so token numbers include side calls the harness makes on its own.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
	options: {
		arms: { type: "string", default: "pi,claude" },
		reps: { type: "string", default: "2" },
		tasks: { type: "string" },
		model: { type: "string", default: "claude-sonnet-5-5" },
		effort: { type: "string", default: "medium" },
		out: { type: "string", default: join(root, "bench/out/results.jsonl") },
		label: { type: "string", default: "" },
		timeout: { type: "string", default: "900" },
	},
});
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8787";
const proxyDir = join(root, "bench/out/proxy");
const allTasks = JSON.parse(readFileSync(join(root, "bench/tasks/tasks.json"), "utf8"));
const tasks = args.tasks ? allTasks.filter((t) => args.tasks.split(",").includes(t.id)) : allTasks;
const arms = args.arms.split(",");
const reps = Number(args.reps);
const runsDir = join(tmpdir(), "pi-claude-bench");
mkdirSync(runsDir, { recursive: true });
const piAgentDir = join(runsDir, "pi-agent");
mkdirSync(piAgentDir, { recursive: true });

function armCommand(arm, prompt, tag) {
	const env = { ...process.env, ANTHROPIC_BASE_URL: `${PROXY}/run/${tag}` };
	// Run every arm as from a plain terminal: no API key, and no Claude Code identity inherited
	// from a parent Claude Code session (it would change how Anthropic classifies the traffic).
	for (const k of ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
	if (arm === "pi" || arm === "pi-default") {
		if (arm === "pi-default") env.PI_CLAUDE_SDK_PROMPT = "pi";
		return {
			cmd: join(root, "node_modules/.bin/pi"),
			argv: ["--no-extensions", "-e", join(root, "src/index.ts"), "--no-skills", "--no-session", "--model", `claude-sdk/${args.model}`, "--thinking", args.effort, "-p", prompt],
			env: { ...env, PI_CODING_AGENT_DIR: piAgentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		};
	}
	if (arm === "claude") {
		// Claude Code as shipped, isolated from this machine's user/project settings, MCP servers and plugins.
		return {
			cmd: "claude",
			argv: ["-p", prompt, "--model", args.model, "--effort", args.effort, "--setting-sources", "", "--strict-mcp-config", "--dangerously-skip-permissions", "--output-format", "json"],
			env,
		};
	}
	throw new Error(`unknown arm ${arm}`);
}

function run(cmd, argv, opts) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), Number(args.timeout) * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err, ms: Date.now() - t0 });
		});
	});
}

function usageFor(tag) {
	const file = join(proxyDir, `${tag}.jsonl`);
	const totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, byModel: {}, errors: 0, overage: 0, extraUsage400: 0 };
	if (!existsSync(file)) return totals;
	for (const line of readFileSync(file, "utf8").trim().split("\n")) {
		const r = JSON.parse(line);
		if (!r.path?.startsWith("/v1/messages")) continue;
		if (r.status >= 400) totals.errors++;
		if (r.status === 400 && /extra usage/i.test(r.error ?? "")) totals.extraUsage400++;
		if (/overage|out_of_credits/.test(r.billing?.["anthropic-ratelimit-unified-representative-claim"] ?? "")) totals.overage++;
		const u = r.usage ?? {};
		if (u.input_tokens == null) continue;
		totals.requests++;
		const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
		const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - w1h;
		const row = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h, output: u.output_tokens ?? 0 };
		const m = (totals.byModel[r.model] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
		m.requests++;
		for (const k of Object.keys(row)) {
			totals[k] += row[k];
			m[k] += row[k];
		}
	}
	return totals;
}

function verify(dir, taskId) {
	cpSync(join(root, "bench/tasks", `${taskId}.verify.js`), join(dir, "test", "zz_verify.test.js"));
	try {
		execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 120_000 });
		return { pass: true };
	} catch (e) {
		const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		return { pass: false, detail: text.split("\n").filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 6).join(" | ") };
	}
}

const order = [];
for (let rep = 0; rep < reps; rep++) for (const task of tasks) for (const arm of rep % 2 ? [...arms].reverse() : arms) order.push({ rep, task, arm });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let i = 0;
for (const { rep, task, arm } of order) {
	i++;
	const tag = `bench-${stamp}-${arm}-${task.id}-r${rep}`;
	const dir = join(runsDir, tag);
	rmSync(dir, { recursive: true, force: true });
	cpSync(join(root, "bench/fixture"), dir, { recursive: true });
		execFileSync("sh", ["-c", "git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -qm fixture"], { cwd: dir });
	const { cmd, argv, env } = armCommand(arm, task.prompt, tag);
	const res = await run(cmd, argv, { cwd: dir, env });
	await new Promise((r) => setTimeout(r, 1500)); // let the proxy flush trailing side calls
	const v = verify(dir, task.id);
	const usage = usageFor(tag);
	const diffStat = execFileSync("git", ["diff", "--shortstat"], { cwd: dir, encoding: "utf8" }).trim();
	const rec = { label: args.label, tag, arm, task: task.id, rep, model: args.model, effort: args.effort, exit: res.code, wallMs: res.ms, ...v, usage, diffStat, stderrTail: res.code ? res.err.slice(-400) : undefined };
	appendFileSync(args.out, `${JSON.stringify(rec)}\n`);
	console.log(
		`[${i}/${order.length}] ${arm.padEnd(6)} ${task.id.padEnd(15)} r${rep} ${v.pass ? "PASS" : "FAIL"} ${(res.ms / 1000).toFixed(1)}s req=${usage.requests} in=${usage.input} cr=${usage.cacheRead} cw=${usage.cacheWrite5m + usage.cacheWrite1h} out=${usage.output}${v.pass ? "" : ` :: ${v.detail ?? ""}`}`,
	);
}
