#!/usr/bin/env node
// Summarize bench/out/results.jsonl: node bench/report.mjs [--label main] [--file results.jsonl]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { label: { type: "string" }, file: { type: "string", default: join(root, "bench/out/results.jsonl") } } });
const rows = readFileSync(args.file, "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))
	.filter((r) => !args.label || r.label === args.label);

/** API-equivalent USD at catalog prices; the subscription meters usage on the same token classes. */
function cost(byModel) {
	let usd = 0;
	for (const [model, u] of Object.entries(byModel)) {
		const id = Object.keys(ANTHROPIC_MODELS).find((k) => model?.startsWith(k)) ?? "claude-sonnet-5-5";
		const c = ANTHROPIC_MODELS[id].cost;
		usd += (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead + u.cacheWrite5m * c.cacheWrite + u.cacheWrite1h * c.input * 2) / 1e6;
	}
	return usd;
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

function summarize(rs) {
	const u = rs.map((r) => r.usage);
	const processed = u.map((x) => x.input + x.cacheRead + x.cacheWrite5m + x.cacheWrite1h);
	return {
		runs: rs.length,
		pass: rs.filter((r) => r.pass).length,
		wallMedian: median(rs.map((r) => r.wallMs)) / 1000,
		wallMean: mean(rs.map((r) => r.wallMs)) / 1000,
		requests: mean(u.map((x) => x.requests)),
		input: mean(u.map((x) => x.input)),
		cacheRead: mean(u.map((x) => x.cacheRead)),
		cacheWrite: mean(u.map((x) => x.cacheWrite5m + x.cacheWrite1h)),
		output: mean(u.map((x) => x.output)),
		processed: mean(processed),
		hit: mean(u.map((x, i) => x.cacheRead / (processed[i] || 1))),
		cost: mean(u.map((x) => cost(x.byModel))),
		sideModels: [...new Set(u.flatMap((x) => Object.keys(x.byModel)))].join(", "),
	};
}

const arms = [...new Set(rows.map((r) => r.arm))];
const tasks = [...new Set(rows.map((r) => r.task))];
const s = Object.fromEntries(arms.map((a) => [a, summarize(rows.filter((r) => r.arm === a))]));

const out = [];
out.push(`## Overall (${rows[0]?.model}, effort ${rows[0]?.effort}, ${tasks.length} tasks × ${s[arms[0]].runs / tasks.length} reps)\n`);
out.push(`| metric | ${arms.join(" | ")} |`);
out.push(`|---|${arms.map(() => "---:").join("|")}|`);
const line = (name, f) => out.push(`| ${name} | ${arms.map((a) => f(s[a])).join(" | ")} |`);
line("tasks passed", (x) => `${x.pass}/${x.runs}`);
line("wall time, median (s)", (x) => fmt(x.wallMedian, 1));
line("wall time, mean (s)", (x) => fmt(x.wallMean, 1));
line("API requests / run", (x) => fmt(x.requests, 1));
line("uncached input / run", (x) => fmt(x.input));
line("cache read / run", (x) => fmt(x.cacheRead));
line("cache write / run", (x) => fmt(x.cacheWrite));
line("output / run", (x) => fmt(x.output));
line("input processed / run", (x) => fmt(x.processed));
line("cache hit ratio", (x) => `${fmt(x.hit * 100, 1)}%`);
line("API-equivalent cost / run", (x) => `$${fmt(x.cost, 4)}`);
line("models called", (x) => x.sideModels);

out.push(`\n## Per task\n`);
out.push(`| task | ${arms.map((a) => `${a} pass`).join(" | ")} | ${arms.map((a) => `${a} wall s`).join(" | ")} | ${arms.map((a) => `${a} cost`).join(" | ")} |`);
out.push(`|---|${arms.map(() => "---:").join("|")}|${arms.map(() => "---:").join("|")}|${arms.map(() => "---:").join("|")}|`);
for (const t of tasks) {
	const ts = Object.fromEntries(arms.map((a) => [a, summarize(rows.filter((r) => r.arm === a && r.task === t))]));
	out.push(`| ${t} | ${arms.map((a) => `${ts[a].pass}/${ts[a].runs}`).join(" | ")} | ${arms.map((a) => fmt(ts[a].wallMedian, 1)).join(" | ")} | ${arms.map((a) => `$${fmt(ts[a].cost, 4)}`).join(" | ")} |`);
}
const fails = rows.filter((r) => !r.pass);
if (fails.length) {
	out.push(`\n## Failures\n`);
	for (const f of fails) out.push(`- ${f.arm} ${f.task} r${f.rep}: ${f.detail ?? `exit ${f.exit}`}`);
}
console.log(out.join("\n"));
