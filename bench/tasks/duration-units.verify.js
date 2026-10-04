import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/duration.js";
test("verify: d and w", () => {
	assert.equal(parseDuration("2d"), 2 * 86_400_000);
	assert.equal(parseDuration("1w 1d 1h"), 8 * 86_400_000 + 3_600_000);
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.throws(() => parseDuration("3y"));
	assert.throws(() => parseDuration(""));
	assert.throws(() => parseDuration("5m extra"));
});
