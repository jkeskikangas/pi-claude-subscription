#!/usr/bin/env node
// Summarize bench/out/session-results.jsonl: node bench/session-report.mjs [--label session]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { label: { type: "string" } } });
const rows = readFileSync(join(root, "bench/out/session-results.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l))
	.filter((r) => !args.label || r.label === args.label);

const price = (model) => ANTHROPIC_MODELS[Object.keys(ANTHROPIC_MODELS).find((k) => model?.startsWith(k)) ?? "claude-sonnet-5-5"].cost;
function totals(reqs) {
	const t = { requests: reqs.length, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
	for (const r of reqs) {
		const c = price(r.model);
		t.input += r.input_tokens;
		t.cacheRead += r.cache_read_input_tokens ?? 0;
		t.cacheWrite += r.cache_creation_input_tokens ?? 0;
		t.output += r.output_tokens ?? 0;
		// Proxy records keep only the total cache write; Claude Code writes one-hour entries (2× input).
		t.cost += (r.input_tokens * c.input + (r.cache_read_input_tokens ?? 0) * c.cacheRead + (r.cache_creation_input_tokens ?? 0) * c.input * 2 + (r.output_tokens ?? 0) * c.output) / 1e6;
	}
	return t;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const arms = [...new Set(rows.map((r) => r.arm))];
const s = Object.fromEntries(
	arms.map((a) => {
		const rs = rows.filter((r) => r.arm === a);
		const ts = rs.map((r) => totals(r.requests));
		return [
			a,
			{
				runs: rs.length,
				checks: `${rs.filter((r) => Object.values(r.checks).every(Boolean)).length}/${rs.length}`,
				wall: mean(rs.map((r) => r.wallMs)) / 1000,
				turns: rs[0].turns.map((_, i) => mean(rs.map((r) => r.turns[i])) / 1000),
				...Object.fromEntries(Object.keys(ts[0]).map((k) => [k, mean(ts.map((t) => t[k]))])),
			},
		];
	}),
);
const out = [`## 5-turn interactive session (${rows[0].model}, effort ${rows[0].effort}, ${s[arms[0]].runs} reps)\n`, `| metric | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---:").join("|")}|`];
const line = (name, f) => out.push(`| ${name} | ${arms.map((a) => f(s[a])).join(" | ")} |`);
line("all checks passed", (x) => x.checks);
line("session wall time (s)", (x) => fmt(x.wall, 1));
line("per-turn wall time (s)", (x) => x.turns.map((t) => fmt(t, 1)).join(" / "));
line("API requests", (x) => fmt(x.requests, 1));
line("cache read", (x) => fmt(x.cacheRead));
line("cache write", (x) => fmt(x.cacheWrite));
line("uncached input", (x) => fmt(x.input));
line("output", (x) => fmt(x.output));
line("API-equivalent cost", (x) => `$${fmt(x.cost, 3)}`);
console.log(out.join("\n"));
