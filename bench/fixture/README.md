# stockroom

Inventory bookkeeping helpers: items, stock movements, pricing, reports and a small CLI.

- `src/money.js` – integer-cents money helpers
- `src/duration.js` – parse human durations ("1h30m") used for reservation holds
- `src/csv.js` – CSV import of stock movements
- `src/lru.js` – LRU cache used by the price lookup
- `src/pricing.js` – price rules and discounts
- `src/inventory.js` – the Inventory class
- `src/report.js` – text reports
- `src/stats.js` – small statistics helpers
- `src/cli.js` – command line entry point

Run tests with `npm test`.
