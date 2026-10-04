import { formatCents } from "./money.js";

export function stockReport(inventory) {
	const lines = ["SKU        NAME                 QTY"];
	for (const item of [...inventory.items.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
		lines.push(`${item.sku.padEnd(10)} ${item.name.padEnd(20)} ${String(item.qty).padStart(3)}`);
	}
	return lines.join("\n");
}

export function valueReport(inventory, priceOf) {
	let total = 0;
	for (const item of inventory.items.values()) total += priceOf(item.sku) * item.qty;
	return `Total stock value: ${formatCents(total)}`;
}
