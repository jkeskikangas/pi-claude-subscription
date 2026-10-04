/**
 * Parse CSV text into an array of row arrays.
 * Supports quoted fields with embedded commas and doubled quotes ("" -> ").
 */
export function parseCsv(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const fields = [];
		let cur = "";
		let quoted = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (quoted) {
				if (ch === '"') quoted = false;
				else cur += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") {
				fields.push(cur);
				cur = "";
			} else cur += ch;
		}
		fields.push(cur);
		rows.push(fields);
	}
	return rows;
}

/** Parse stock movement rows: sku,qty,note */
export function parseMovements(text) {
	const [header, ...rows] = parseCsv(text);
	if (header.join(",") !== "sku,qty,note") throw new Error("unexpected header");
	return rows.map(([sku, qty, note]) => ({ sku, qty: Number(qty), note: note ?? "" }));
}
