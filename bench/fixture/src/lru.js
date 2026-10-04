/** Least-recently-used cache with a fixed capacity. */
export class LRUCache {
	constructor(capacity) {
		if (!(capacity > 0)) throw new Error("capacity must be positive");
		this.capacity = capacity;
		this.map = new Map();
	}

	get(key) {
		if (!this.map.has(key)) return undefined;
		return this.map.get(key);
	}

	set(key, value) {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.capacity) {
			const oldest = this.map.keys().next().value;
			this.map.delete(oldest);
		}
		return this;
	}

	get size() {
		return this.map.size;
	}
}
