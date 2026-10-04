import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/duration.js";
test("parses h/m/s", () => {
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.equal(parseDuration("90s"), 90_000);
});
