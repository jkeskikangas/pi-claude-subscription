import { LRUCache } from "./lru.js";

const cache = new LRUCache(256);

/**
 * Price rules: { sku, unitCents, bulk?: { minQty, percentOff } }
 * Bulk discount applies when qty >= minQty.
 */
export function priceFor(rules, sku, qty) {
	const key = `${sku}:${qty}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const rule = rules.find((r) => r.sku === sku);
	if (!rule) throw new Error(`no price for ${sku}`);
	let total = rule.unitCents * qty;
	if (rule.bulk && qty > rule.bulk.minQty) total = Math.round(total * (1 - rule.bulk.percentOff / 100));
	cache.set(key, total);
	return total;
}

export function clearPriceCache() {
	cache.map.clear();
}
