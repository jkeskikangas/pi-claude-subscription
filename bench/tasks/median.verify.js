import assert from "node:assert/strict";
import { test } from "node:test";
import { median, mean, percentile } from "../src/stats.js";
test("verify: median", () => {
	assert.equal(median([1, 2, 3, 4]), 2.5);
	assert.equal(median([10, 9, 2]), 9);
	assert.equal(median([5]), 5);
	assert.equal(median([-1, -10, 3, 100]), 1);
	assert.ok(Number.isNaN(median([])));
	const xs = [3, 1, 2];
	median(xs);
	assert.deepEqual(xs, [3, 1, 2]);
	assert.equal(mean([1, 2]), 1.5);
	assert.equal(percentile([1, 2, 3, 4], 50), 2);
});
