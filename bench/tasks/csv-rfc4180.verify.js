import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseMovements } from "../src/csv.js";
test("verify: rfc4180", () => {
	assert.deepEqual(parseCsv('a,"b\nc",d\r\ne,f,g\n'), [["a", "b\nc", "d"], ["e", "f", "g"]]);
	assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]]);
	assert.deepEqual(parseCsv('"x,y",2\n\n3,4'), [["x,y", "2"], ["3", "4"]]);
	assert.deepEqual(parseCsv('"a\r\nb",1\r\n'), [["a\r\nb", "1"]]);
	assert.deepEqual(parseCsv('1,,3'), [["1", "", "3"]]);
	assert.deepEqual(parseMovements('sku,qty,note\r\nA1,3,"multi\nline ""note"""\r\nB2,-1,\r\n'), [
		{ sku: "A1", qty: 3, note: 'multi\nline "note"' },
		{ sku: "B2", qty: -1, note: "" },
	]);
});
