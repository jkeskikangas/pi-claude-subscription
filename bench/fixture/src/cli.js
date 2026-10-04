#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseMovements } from "./csv.js";
import { Inventory } from "./inventory.js";
import { stockReport } from "./report.js";

export function main(argv, io = { out: (s) => process.stdout.write(s + "\n"), read: (p) => readFileSync(p, "utf8") }) {
	const [cmd, ...rest] = argv;
	if (cmd === "report") {
		const [itemsFile, movementsFile] = rest;
		const inv = new Inventory();
		for (const line of io.read(itemsFile).trim().split("\n").slice(1)) {
			const [sku, name, qty] = line.split(",");
			inv.addItem(sku, name, Number(qty));
		}
		if (movementsFile) inv.applyMovements(parseMovements(io.read(movementsFile)));
		io.out(stockReport(inv));
		return 0;
	}
	io.out("usage: stockroom report <items.csv> [movements.csv]");
	return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
