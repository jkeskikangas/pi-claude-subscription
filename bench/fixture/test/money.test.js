import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, toCents } from "../src/money.js";
test("toCents", () => {
	assert.equal(toCents("12.5"), 1250);
	assert.equal(toCents("-3.07"), -307);
	assert.equal(toCents(1.1), 110);
});
test("formatCents", () => assert.equal(formatCents(-1205), "-12.05 EUR"));
