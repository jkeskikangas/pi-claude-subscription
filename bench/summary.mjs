// One summary row per benchmark label (used in RESULTS.md).
import { readFileSync } from "node:fs";
import { ANTHROPIC_MODELS as M } from "@earendil-works/pi-ai/providers/anthropic.models";
const rows = readFileSync(new URL("out/results.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const runs = [["main-sonnet55-medium", "8 tasks × 3, Sonnet 5.5 medium"], ["hard-sonnet55-medium", "3 harder tasks × 3, Sonnet 5.5 medium"], ["all-opus55-high", "11 tasks × 1, Opus 5.5 high"]];
const cost = (b) => Object.entries(b).reduce((s, [m, u]) => {
	const c = M[Object.keys(M).find((k) => m.startsWith(k))].cost;
	return s + (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead + u.cacheWrite5m * c.cacheWrite + u.cacheWrite1h * c.input * 2) / 1e6;
}, 0);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const proc = (r) => mean(r.map((x) => x.usage.input + x.usage.cacheRead + x.usage.cacheWrite5m + x.usage.cacheWrite1h));
const usd = (r) => mean(r.map((x) => cost(x.usage.byModel)));
for (const [l, name] of runs) {
	const p = rows.filter((x) => x.label === l && x.arm === "pi");
	const c = rows.filter((x) => x.label === l && x.arm === "claude");
	console.log(`| ${name} | ${p.filter((x) => x.pass).length}/${p.length} / ${c.filter((x) => x.pass).length}/${c.length} | ${(med(p.map((x) => x.wallMs)) / 1000).toFixed(1)}s / ${(med(c.map((x) => x.wallMs)) / 1000).toFixed(1)}s | ${Math.round(proc(p)).toLocaleString("en-US")} / ${Math.round(proc(c)).toLocaleString("en-US")} (${(proc(c) / proc(p)).toFixed(1)}×) | $${usd(p).toFixed(3)} / $${usd(c).toFixed(3)} (${(usd(c) / usd(p)).toFixed(1)}×) |`);
}
