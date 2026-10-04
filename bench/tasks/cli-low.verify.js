import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.js";
const files = { "items.csv": "sku,name,qty\nC3,Clip,1\nB2,Bolt,4\nA1,Anchor,7\n", "mov.csv": "sku,qty,note\nA1,-5,sold\n" };
const run = (argv) => {
	const out = [];
	const code = main(argv, { out: (s) => out.push(s), read: (p) => files[p] });
	return { code, lines: out.join("\n").split("\n").filter(Boolean) };
};
test("verify: low", () => {
	assert.deepEqual(run(["low", "items.csv", "5"]), { code: 0, lines: ["B2", "C3"] });
	assert.deepEqual(run(["low", "items.csv", "5", "mov.csv"]), { code: 0, lines: ["A1", "B2", "C3"] });
	assert.deepEqual(run(["low", "items.csv", "1"]).lines, []);
	const u = run(["nope"]);
	assert.equal(u.code, 1);
	assert.match(u.lines.join(" "), /low/);
});
