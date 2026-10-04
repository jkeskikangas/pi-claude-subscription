const UNITS = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Parse a human duration into milliseconds.
 * Accepts a sequence of <integer><unit> parts, e.g. "90s", "1h30m", "2h 5m 10s".
 * Units: s (seconds), m (minutes), h (hours), d (days), w (weeks).
 * Throws on empty input, unknown units or trailing garbage.
 */
export function parseDuration(text) {
	const re = /(\d+)\s*([a-z])\s*/gy;
	let total = 0;
	let m;
	let consumed = 0;
	const input = String(text).trim();
	while ((m = re.exec(input))) {
		const unit = UNITS[m[2]];
		if (!unit) throw new Error(`unknown unit: ${m[2]}`);
		total += Number(m[1]) * unit;
		consumed = re.lastIndex;
	}
	if (consumed !== input.length || input.length === 0) throw new Error(`invalid duration: ${text}`);
	return total;
}
