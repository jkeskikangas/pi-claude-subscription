export function mean(xs) {
	if (xs.length === 0) return NaN;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort();
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : s[mid];
}

export function percentile(xs, p) {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[idx];
}
