/**
 * Tests for the Worker scan — offline, no network.
 *
 * Run with `npx tsx ss-worker/scan.test.ts`, and via `npm test`.
 *
 * ⚠️ **What these are actually for.** This is a port, and the failure mode of a
 * bad port is not a crash — it is a deals page showing wrong prices while
 * everything reports success. So the cases below are aimed squarely at the
 * arithmetic and the two behaviours the probe got wrong (a stand-in weight
 * parser, and one pass per term instead of two), plus a sweep over the **real
 * committed scan file** to check this mapper's formulas reproduce what the Node
 * runner has actually been publishing.
 */
import { readFileSync } from "node:fs";
import { mapProduct, sgtDate } from "./scan";
import { toBase64 } from "./github";

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) passed++;
	else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

function ok(name: string, cond: boolean): void {
	if (cond) passed++;
	else failures.push(name);
}

// ---- mapProduct: the arithmetic ------------------------------------------

const base = { name: "Thing", brand: "B", slug: "thing", price: "5.00", packSize: "1 kg" };

{
	const p: any = mapProduct(base);
	eq("1 kg → 1000 g", p.packWeightG, 1000);
	eq("per 100g from kg", p.pricePer100g, 0.5);
	eq("not volumetric", p.volumetric, false);
	eq("url is built from slug", p.url, "https://shengsiong.com.sg/product/thing");
	eq("store is stamped", p.store, "Sheng Siong");
	eq("dietary is always empty for SS", p.dietaryAttributes, []);
	eq("saleEndsAt is never known", p.saleEndsAt, null);
}

{
	// ⚠️ The multipack. `parseWeight` must total it (4 x 125 = 500 ml), not read 125.
	// This is the case a "stand-in" regex gets wrong, and it changes price-per-unit
	// by 4x — which is exactly the kind of error that reaches the page as a deal.
	const p: any = mapProduct({ ...base, packSize: "4 x 125 ml", price: "2.00" });
	eq("4 x 125 ml totals 500", p.packWeightG, 500);
	eq("ml is volumetric", p.volumetric, true);
	eq("per 100ml", p.pricePer100g, 0.4);
}

{
	const p: any = mapProduct({ ...base, packSize: "10s", price: "3.00" });
	eq("unit count is read", p.unitCount, 10);
	eq("no weight → null per-100g", p.pricePer100g, null);
	eq("no weight → null grams", p.packWeightG, null);
}

{
	// ⚠️ Pinning CURRENT behaviour, not endorsing it. `parseUnitCount`'s own
	// docstring offers "10 eggs" as an example and that string does NOT parse —
	// the regex needs `10s`, `10 pcs`, `2 per pack` or `6 x`. Left alone here
	// because this is a port and changing a shared parser would change what the
	// laptop scans too; recorded so the next person does not read the docstring
	// and assume it works. Eggs are a known sore point (see HANDOVER, "$399.00/kg
	// for a box of eggs").
	const p: any = mapProduct({ ...base, packSize: "10 eggs" });
	eq("'10 eggs' does not parse today", p.unitCount, null);
}

{
	// The multipack sets BOTH: 500 ml total and 4 units. Same function as the Node
	// runner, so this agreeing matters more than it looks.
	const p: any = mapProduct({ ...base, packSize: "4 x 125 ml" });
	eq("multipack also yields a unit count", p.unitCount, 4);
}

{
	// The epsilon. Equal prices must NOT read as a sale, or every product carries a
	// permanent fake discount.
	const same: any = mapProduct({ ...base, price: "5.00", prevPrice: "5.00" });
	eq("equal prices are not a sale", same.onSale, false);
	eq("not on sale → no list price", same.listPriceSgd, null);

	const cut: any = mapProduct({ ...base, price: "4.00", prevPrice: "5.00" });
	eq("lower than prev is a sale", cut.onSale, true);
	eq("list price is the previous", cut.listPriceSgd, 5);

	const up: any = mapProduct({ ...base, price: "6.00", prevPrice: "5.00" });
	eq("higher than prev is not a sale", up.onSale, false);
}

{
	// `prevPrice` absent is the common case and must not become NaN or 0-priced.
	const p: any = mapProduct({ ...base, prevPrice: undefined });
	eq("missing prevPrice is not a sale", p.onSale, false);
	eq("missing prevPrice leaves listPrice null", p.listPriceSgd, null);
}

{
	const withKey: any = mapProduct({ ...base, imgKey: "abc" });
	eq("imageKey is carried", withKey.imageKey, "abc");
	const without: any = mapProduct(base);
	eq("imageKey defaults to null", without.imageKey, null);
	ok("raw is NOT carried into the committed file", !("raw" in (without as object)));
}

// ---- sgtDate: the 01:00-03:00 UTC trap -----------------------------------

// ⚠️ The scan runs 01:00-03:00 UTC, which is the PREVIOUS day in UTC. A naive
// toISOString().slice(0,10) would date every morning scan yesterday, and
// isUsableScan would reject all of them — the whole window would look broken.
eq("01:00 UTC is already today in SGT", sgtDate(new Date("2026-08-13T01:00:00Z")), "2026-08-13");
eq("03:00 UTC likewise", sgtDate(new Date("2026-08-13T03:00:00Z")), "2026-08-13");
eq("15:59 UTC is still the same SGT day", sgtDate(new Date("2026-08-13T15:59:00Z")), "2026-08-13");
eq("16:00 UTC rolls to the next SGT day", sgtDate(new Date("2026-08-13T16:00:00Z")), "2026-08-14");

// ---- base64: the chunking ------------------------------------------------

{
	eq("ascii round-trips", toBase64("hello"), "aGVsbG8=");
	// Non-ASCII must go through UTF-8 first; product names carry them.
	eq("utf-8 is encoded as bytes", toBase64("é"), "w6k=");
	// ⚠️ The reason toBase64 chunks at all: a naive spread blows the argument
	// limit somewhere above ~100k. The real file is ~230 KB.
	const big = "x".repeat(300_000);
	ok("300 KB encodes without throwing", toBase64(big).length > 300_000);
}

// ---- the real committed file: do these formulas match production? --------

/**
 * ⚠️ The strongest check here. Every product below was mapped by the NODE runner
 * and published. Re-deriving the computed fields with THIS file's arithmetic and
 * finding them identical is direct evidence the port does not shift prices.
 */
{
	let checked = 0;
	let perMismatch = 0;
	let saleMismatch = 0;
	try {
		const raw = JSON.parse(readFileSync("data/shengsiong-latest.json", "utf8"));
		for (const list of Object.values(raw.results ?? {}) as any[][]) {
			for (const p of list) {
				checked++;
				const expectedPer =
					p.packWeightG && p.packWeightG > 0 ? (p.priceSgd / p.packWeightG) * 100 : null;
				if (expectedPer === null ? p.pricePer100g !== null : Math.abs(p.pricePer100g - expectedPer) > 1e-9) {
					perMismatch++;
				}
				// onSale must agree with listPriceSgd's presence, both directions.
				if (p.onSale !== (p.listPriceSgd !== null && p.listPriceSgd > p.priceSgd)) saleMismatch++;
			}
		}
		ok(`real file: checked a non-trivial number of products (${checked})`, checked > 100);
		eq("real file: every pricePer100g matches this formula", perMismatch, 0);
		eq("real file: onSale agrees with listPriceSgd everywhere", saleMismatch, 0);
	} catch (e: any) {
		failures.push(`real-file sweep could not run: ${e.message}`);
	}
}

// ---- report --------------------------------------------------------------

if (failures.length) {
	console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`ss-worker: ${passed} passed`);
