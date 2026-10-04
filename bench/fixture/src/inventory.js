export class Inventory {
	constructor() {
		this.items = new Map(); // sku -> { sku, name, qty }
		this.history = [];
	}

	addItem(sku, name, qty = 0) {
		if (this.items.has(sku)) throw new Error(`duplicate sku ${sku}`);
		this.items.set(sku, { sku, name, qty });
	}

	move(sku, qty, note = "") {
		const item = this.items.get(sku);
		if (!item) throw new Error(`unknown sku ${sku}`);
		if (item.qty + qty < 0) throw new Error(`insufficient stock for ${sku}`);
		item.qty += qty;
		this.history.push({ sku, qty, note, at: this.history.length });
	}

	applyMovements(movements) {
		for (const m of movements) this.move(m.sku, m.qty, m.note);
	}

	quantity(sku) {
		return this.items.get(sku)?.qty ?? 0;
	}

	lowStock(threshold) {
		return [...this.items.values()].filter((i) => i.qty < threshold).map((i) => i.sku);
	}
}
