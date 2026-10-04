import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory } from "../src/inventory.js";
test("moves stock", () => {
	const inv = new Inventory();
	inv.addItem("A1", "Widget", 5);
	inv.move("A1", -2);
	assert.equal(inv.quantity("A1"), 3);
	assert.throws(() => inv.move("A1", -10));
});
