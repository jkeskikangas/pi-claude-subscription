import assert from "node:assert/strict";
import { test } from "node:test";
import { LRUCache } from "../src/lru.js";
test("verify: get refreshes recency", () => {
	const c = new LRUCache(2);
	c.set("a", 1).set("b", 2);
	assert.equal(c.get("a"), 1);
	c.set("c", 3);
	assert.equal(c.get("b"), undefined);
	assert.equal(c.get("a"), 1);
	assert.equal(c.get("c"), 3);
	assert.equal(c.size, 2);
	const d = new LRUCache(1);
	d.set("x", 0);
	assert.equal(d.get("x"), 0);
	assert.equal(d.get("missing"), undefined);
});
