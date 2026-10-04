import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { Inventory } from "../src/inventory.js";
test("verify: transfer", () => {
	const inv = new Inventory();
	inv.addItem("A", "a", 5);
	inv.addItem("B", "b", 1);
	inv.transfer("A", "B", 3, "rebalance");
	assert.equal(inv.quantity("A"), 2);
	assert.equal(inv.quantity("B"), 4);
	assert.deepEqual(inv.history.map((h) => [h.sku, h.qty, h.note]), [["A", -3, "rebalance"], ["B", 3, "rebalance"]]);
	const before = JSON.stringify([...inv.items.values()]) + JSON.stringify(inv.history);
	assert.throws(() => inv.transfer("A", "B", 10, "x"));
	assert.throws(() => inv.transfer("A", "Z", 1, "x"));
	assert.throws(() => inv.transfer("Z", "A", 1, "x"));
	assert.equal(JSON.stringify([...inv.items.values()]) + JSON.stringify(inv.history), before);
});
test("verify: agent added transfer tests", () => {
	const mentions = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".js") && !f.startsWith("zz_verify")).some((f) => /transfer/.test(readFileSync(new URL(f, import.meta.url), "utf8")));
	assert.ok(mentions, "a test file exercises transfer()");
});
