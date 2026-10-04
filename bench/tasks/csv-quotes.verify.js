import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseMovements } from "../src/csv.js";
test("verify: doubled quotes", () => {
	assert.deepEqual(parseCsv('a,"say ""hi""",c'), [["a", 'say "hi"', "c"]]);
	assert.deepEqual(parseCsv('"x,y",2'), [["x,y", "2"]]);
	assert.deepEqual(parseCsv('""'), [[""]]);
	assert.deepEqual(parseMovements('sku,qty,note\nA1,3,"said ""hi"""'), [{ sku: "A1", qty: 3, note: 'said "hi"' }]);
});
