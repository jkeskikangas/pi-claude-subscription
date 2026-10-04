import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFor } from "../src/pricing.js";
test("verify: bulk boundary and rule-aware cache", () => {
	const rules = [{ sku: "A", unitCents: 100, bulk: { minQty: 10, percentOff: 10 } }];
	assert.equal(priceFor(rules, "A", 9), 900);
	assert.equal(priceFor(rules, "A", 10), 900);
	assert.equal(priceFor(rules, "A", 20), 1800);
	const other = [{ sku: "A", unitCents: 200 }];
	assert.equal(priceFor(other, "A", 10), 2000);
	assert.equal(priceFor(rules, "A", 10), 900);
	assert.throws(() => priceFor(rules, "B", 1));
});
