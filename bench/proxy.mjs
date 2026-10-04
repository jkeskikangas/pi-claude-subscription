#!/usr/bin/env node
// Logging reverse proxy for api.anthropic.com. Point a client at
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/run/<tag>
// and every /v1/messages call is logged to <outDir>/<tag>.jsonl with its usage, timing and a
// request fingerprint. Request bodies are dumped to <outDir>/<tag>/ when DUMP_BODIES=1.
// Authorization headers are forwarded but never written anywhere.
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 8787);
const outDir = process.env.OUT_DIR ?? "./bench/out/proxy";
const dump = process.env.DUMP_BODIES === "1";
const upstream = new URL(process.env.UPSTREAM ?? "https://api.anthropic.com");
mkdirSync(outDir, { recursive: true });

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
let seq = 0;

function summarizeRequest(body) {
	try {
		const j = JSON.parse(body);
		const system = Array.isArray(j.system) ? j.system.map((b) => b.text ?? "").join("\n") : (j.system ?? "");
		const tools = (j.tools ?? []).map((t) => t.name);
		return {
			model: j.model,
			stream: j.stream,
			maxTokens: j.max_tokens,
			thinking: j.thinking?.type,
			effort: j.output_config?.effort,
			systemChars: system.length,
			systemHash: sha(JSON.stringify(j.system ?? "")),
			toolsHash: sha(JSON.stringify(j.tools ?? [])),
			tools,
			messages: j.messages?.length,
			// Hash of every message but the last: equal hashes between consecutive calls mean the
			// conversation prefix was byte-stable (the precondition for a cache hit).
			prefixHashes: (j.messages ?? []).map((_, i, a) => sha(JSON.stringify(a.slice(0, i + 1)))),
			bodyBytes: body.length,
		};
	} catch {
		return { bodyBytes: body.length };
	}
}

function parseUsage(text, isStream) {
	const usage = {};
	let stopReason;
	const merge = (u) => {
		for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") usage[k] = v;
		if (u?.cache_creation) usage.cache_creation = u.cache_creation;
	};
	if (isStream) {
		for (const line of text.split("\n")) {
			if (!line.startsWith("data:")) continue;
			try {
				const ev = JSON.parse(line.slice(5));
				if (ev.type === "message_start") merge(ev.message?.usage);
				if (ev.type === "message_delta") {
					merge(ev.usage);
					stopReason = ev.delta?.stop_reason ?? stopReason;
				}
			} catch {}
		}
	} else {
		try {
			const j = JSON.parse(text);
			merge(j.usage);
			stopReason = j.stop_reason;
		} catch {}
	}
	return { usage, stopReason };
}

http
	.createServer((req, res) => {
		const m = req.url.match(/^\/run\/([^/]+)(\/.*)$/);
		const tag = m ? m[1] : "untagged";
		const path = m ? m[2] : req.url;
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const id = ++seq;
			const t0 = Date.now();
			const headers = { ...req.headers, host: upstream.host };
			delete headers["content-length"];
			headers["accept-encoding"] = "identity";
			headers["content-length"] = String(body.length);
			const isMessages = path.startsWith("/v1/messages") && !path.includes("count_tokens");
			const reqInfo = isMessages ? summarizeRequest(body.toString("utf8")) : {};
			if (dump && isMessages) {
				mkdirSync(join(outDir, tag), { recursive: true });
				writeFileSync(join(outDir, tag, `${String(id).padStart(5, "0")}.req.json`), body);
			}
			const up = https.request(
				{ host: upstream.host, port: 443, path, method: req.method, headers },
				(upRes) => {
					res.writeHead(upRes.statusCode, upRes.headers);
					const out = [];
					let ttfb;
					upRes.on("data", (c) => {
						ttfb ??= Date.now() - t0;
						out.push(c);
						res.write(c);
					});
					upRes.on("end", () => {
						res.end();
						const text = Buffer.concat(out).toString("utf8");
						const isStream = String(upRes.headers["content-type"] ?? "").includes("event-stream");
						const { usage, stopReason } = isMessages ? parseUsage(text, isStream) : {};
						const rec = {
							id,
							tag,
							t: new Date(t0).toISOString(),
							method: req.method,
							path,
							status: upRes.statusCode,
							ms: Date.now() - t0,
							ttfbMs: ttfb,
							...reqInfo,
							usage,
							stopReason,
							betas: req.headers["anthropic-beta"],
							// Billing route as Anthropic reports it (plan window vs overage); no credentials.
							billing: Object.fromEntries(Object.entries(upRes.headers).filter(([k]) => k.startsWith("anthropic-ratelimit-unified"))),
						};
						if (upRes.statusCode >= 400) rec.error = text.slice(0, 500);
						appendFileSync(join(outDir, `${tag}.jsonl`), JSON.stringify(rec) + "\n");
					});
				},
			);
			up.on("error", (e) => {
				res.writeHead(502);
				res.end(String(e));
				appendFileSync(join(outDir, `${tag}.jsonl`), JSON.stringify({ id, tag, path, error: String(e) }) + "\n");
			});
			up.end(body);
		});
	})
	.listen(port, "127.0.0.1", () => console.log(`proxy on http://127.0.0.1:${port} -> ${upstream.origin}, logs in ${outDir}`));
