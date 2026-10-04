import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.js";
const files = {
	"items.csv": "sku,name,qty\nVA,Valve,12\nVB,Bracket,3\n",
	"prices.csv": "sku,unit,bulkMinQty,bulkPercentOff\nVA,1.50,10,10\nVB,2.00,,\n",
	"mov.csv": "sku,qty,note\nVA,-5,sold\n",
};
const run = (argv) => {
	const out = [];
	const code = main(argv, { out: (s) => out.push(s), read: (p) => files[p] });
	return { code, text: out.join("\n").trim() };
};
test("verify: value", () => {
	assert.deepEqual(run(["value", "items.csv", "prices.csv"]), { code: 0, text: "Total stock value: 22.20 EUR" });
	assert.deepEqual(run(["value", "items.csv", "prices.csv", "mov.csv"]), { code: 0, text: "Total stock value: 16.50 EUR" });
});
