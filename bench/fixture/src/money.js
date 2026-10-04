// Money is always handled as integer cents.
export function toCents(value) {
	if (typeof value === "number") return Math.round(value * 100);
	const m = String(value).trim().match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
	if (!m) throw new Error(`invalid amount: ${value}`);
	const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
	return m[1] ? -cents : cents;
}

export function formatCents(cents, currency = "EUR") {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

export function sumCents(values) {
	return values.reduce((a, b) => a + b, 0);
}
