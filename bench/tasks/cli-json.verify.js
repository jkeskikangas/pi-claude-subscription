import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.js";
const files = { "items.csv": "sku,name,qty\nB2,Bolt,4\nA1,Anchor,7\n", "mov.csv": "sku,qty,note\nA1,-2,sold\n" };
const run = (argv) => {
	const out = [];
	const code = main(argv, { out: (s) => out.push(s), read: (p) => files[p] });
	return { code, text: out.join("\n") };
};
test("verify: --json", () => {
	for (const argv of [["report", "--json", "items.csv", "mov.csv"], ["report", "items.csv", "mov.csv", "--json"]]) {
		const r = run(argv);
		assert.equal(r.code, 0);
		assert.deepEqual(JSON.parse(r.text), [{ sku: "A1", name: "Anchor", qty: 5 }, { sku: "B2", name: "Bolt", qty: 4 }]);
	}
	const t = run(["report", "items.csv"]);
	assert.match(t.text, /SKU\s+NAME\s+QTY/);
	assert.match(t.text, /A1\s+Anchor\s+7/);
});
