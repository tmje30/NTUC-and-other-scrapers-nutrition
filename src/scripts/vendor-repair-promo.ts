import "dotenv/config";
import { describeSlotDecision, recordVendorPrice } from "../core/ingredient-write.js";
import {
	ROUTES,
	notionClient,
	readScanRows,
	searchTermsFor,
	sizeFor,
	type ScanRow,
	type VendorRoute,
} from "../core/vendor-scan.js";
import { atShelfPrice } from "../core/stores/shelf-price.js";
import type { StoreProduct } from "../core/stores/types.js";
import type { VendorSlot } from "../core/vendor-slots.js";

/**
 * **Put back the shelf price where a promo price got recorded.**
 *
 *   npm run vendor-repair-promo                      # report only — writes NOTHING
 *   npm run vendor-repair-promo -- --only shengsiong
 *   npm run vendor-repair-promo -- --write           # repair the PROVEN ones
 *   npm run vendor-repair-promo -- --write --all     # also re-base every stale price
 *
 * ⚠️ **This is a one-off cleanup, not a scheduled job.** `vendor-scan` now maps every
 * module's results through `atShelfPrice`, so no new promo price can enter the price
 * book. What this fixes is the backlog left by the runs before that existed.
 *
 * Measured 2026-09-01 across the first cloud sweep's 52 picks: **14 were promo prices**,
 * and **6 of those were already recorded** — the scan re-confirmed them and reported
 * nothing, because agreeing with a wrong number looks exactly like agreeing with a right
 * one.
 *
 * ⚠️⚠️ **It deliberately writes a DEARER price, which nothing else here is allowed to
 * do.** That is the whole point. `dearerThanRecorded` protects the price book from a scan
 * that finds a worse match; against a promo it does the opposite, locking the offer price
 * in — a promo writes silently because it is cheaper, and the correction is then refused
 * because it is dearer. Guardian's Sensodyne Repair & Protect sat at $8.65 against a live,
 * not-on-sale $10.20 for exactly that reason, and the sweep had already been refusing to
 * fix it.
 *
 * The safety that stays: `recordVendorPrice` still only ever refreshes a slot that ALREADY
 * names this shop. This claims no free slot and evicts nobody.
 */

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const doWrite = argv.includes("--write");
/** Re-base every price that no longer matches the shelf, not just the provable promos. */
const repairStale = argv.includes("--all");
const only = (flag("only") ?? "").toLowerCase().split(",").filter(Boolean);
const wanted = (r: VendorRoute) =>
	!only.length || only.some((o) => r.option.toLowerCase().replace(/\s+/g, "").includes(o.replace(/\s+/g, "")));

const money = (n: number) => `$${n.toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BETWEEN_SEARCHES_MS = 800;

/** Same figure, to the cent. Notion rounds prices to 2dp on the way in. */
const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * The product this slot is a record OF — not the best product on offer today.
 *
 * ⚠️ **Identity comes from the URL first, and the shop's own product name second.** A
 * repair must re-price the pack that was recorded; picking the cheapest match instead
 * would turn a price correction into a silent product substitution, which is the one
 * thing a pass that overrides the cheaper-only rule must not do.
 *
 * ⚠️ `itemNameValue` is compared exactly (trimmed, case-folded) because it was WRITTEN by
 * this project from the shop's own payload — it is not a human's wording, so a fuzzy match
 * would only ever loosen a comparison that is already exact.
 */
function productForSlot(slot: VendorSlot, products: StoreProduct[]): StoreProduct | null {
	const url = slot.urlValue.trim();
	if (url) {
		const byUrl = products.find((p) => p.url.trim() === url);
		if (byUrl) return byUrl;
	}
	const name = slot.itemNameValue.trim().toLowerCase();
	if (name) {
		const byName = products.find((p) => p.name.trim().toLowerCase() === name);
		if (byName) return byName;
	}
	return null;
}

type Verdict =
	| { kind: "agrees" }
	| { kind: "promo"; shelf: number; promo: number }
	| { kind: "stale"; shelf: number }
	| { kind: "resized"; recorded: number; now: number };

/**
 * What, if anything, is wrong with this slot's price.
 *
 * ⚠️ **`promo` is the only PROVEN verdict, and it is the only one `--write` repairs by
 * default.** It means the shop is running an offer right now and the recorded figure is
 * that offer's price to the cent — a coincidence that does not happen by accident.
 *
 * `stale` means the recorded price simply is not today's shelf price. That covers a promo
 * that has since ENDED (Guardian's Sensodyne, above) but it equally covers a shop that
 * genuinely raised its price, and nothing available today can tell those apart. So it is
 * reported and left alone unless `--all` says otherwise.
 *
 * ⚠️ **A pack that changed size is never repaired.** If the shop is selling a different
 * quantity under the same URL, this is no longer a promo question and re-pricing it would
 * write a price for one pack against the size of another.
 */
function verdictFor(row: ScanRow, slot: VendorSlot, raw: StoreProduct): Verdict {
	const recorded = slot.priceValue;
	if (recorded == null || recorded <= 0) return { kind: "agrees" };

	const nowSize = sizeFor(row.unitType, raw);
	if (slot.sizeValue != null && nowSize != null && Math.abs(nowSize - slot.sizeValue) > 0.001) {
		return { kind: "resized", recorded: slot.sizeValue, now: nowSize };
	}

	const shelf = atShelfPrice(raw).priceSgd;
	if (raw.onSale && sameMoney(recorded, raw.priceSgd) && !sameMoney(recorded, shelf)) {
		return { kind: "promo", shelf, promo: raw.priceSgd };
	}
	if (!sameMoney(recorded, shelf)) return { kind: "stale", shelf };
	return { kind: "agrees" };
}

// ---------------------------------------------------------------------------

const client = notionClient();
const routes = ROUTES.filter(wanted);
const { rows } = await readScanRows(client, routes);

console.log(
	`\n${rows.length} row(s) name a shop in scope — ${routes.map((r) => r.option).join(", ")}.` +
		`\n${doWrite ? `⚠️  --write: ${repairStale ? "PROMO and STALE" : "PROMO"} prices WILL be corrected in Notion.` : "Report only — nothing will be written."}` +
		`\n${"─".repeat(78)}`,
);

let checked = 0;
let promos = 0;
let stale = 0;
let resized = 0;
let unidentified = 0;
let repaired = 0;
let refused = 0;

for (const row of rows) {
	const lines: string[] = [];

	for (const { route, slot } of row.routes) {
		if (!wanted(route)) continue;
		// Nothing recorded is nothing to repair. Filling empty slots is `vendor-scan`'s
		// job and it applies its own gates; this pass exists only to correct what is
		// already written.
		if (slot.priceValue == null || slot.priceValue <= 0) continue;
		checked++;

		let products: StoreProduct[] = [];
		let failed: string | null = null;
		for (const [t, term] of searchTermsFor(row.target).entries()) {
			if (t) await sleep(BETWEEN_SEARCHES_MS);
			try {
				products = await route.module.search(term);
			} catch (e) {
				failed = (e as Error).message;
				break;
			}
			// The slot names one exact product; the first term that returns it is enough.
			if (productForSlot(slot, products)) break;
		}
		if (failed) {
			lines.push(`  ${route.option} — ✗ search failed: ${failed}`);
			unidentified++;
			continue;
		}

		const raw = productForSlot(slot, products);
		if (!raw) {
			// Not a failure worth acting on: a delisted product, or a shop that has since
			// reworded its own title. Reported so a slot quietly frozen in time is visible.
			lines.push(
				`  ${route.option} — ? the recorded product did not come back` +
					`\n      recorded: ${money(slot.priceValue)} "${slot.itemNameValue || "(no name recorded)"}"`,
			);
			unidentified++;
			continue;
		}

		const verdict = verdictFor(row, slot, raw);
		if (verdict.kind === "agrees") continue;

		if (verdict.kind === "resized") {
			resized++;
			lines.push(
				`  ${route.option} — ⚠️ the pack changed size (${verdict.recorded} → ${verdict.now}); left alone` +
					`\n      ${raw.name}`,
			);
			continue;
		}

		const shelf = verdict.shelf;
		if (verdict.kind === "promo") {
			promos++;
			lines.push(
				`  ${route.option} — 🏷️ PROMO PRICE RECORDED` +
					`\n      recorded ${money(slot.priceValue)}, which is exactly today's offer` +
					` (${Math.round((1 - verdict.promo / shelf) * 100)}% off ${money(shelf)})` +
					`\n      ${raw.name}\n      ${raw.url}`,
			);
		} else {
			stale++;
			lines.push(
				`  ${route.option} — ~ recorded ${money(slot.priceValue)}, shelf price is ${money(shelf)}` +
					` — a lapsed promo, or the shop put its price ${shelf > slot.priceValue ? "up" : "down"}` +
					`\n      ${raw.name}`,
			);
		}

		const repairThis = verdict.kind === "promo" || repairStale;
		if (!repairThis) {
			lines.push(`      → left alone. Re-run with --all to re-base it too.`);
			continue;
		}
		if (!doWrite) {
			lines.push(`      → would write ${money(shelf)} into ${slot.vendor}. Re-run with --write.`);
			continue;
		}

		const res = await recordVendorPrice(client, row.pageId, {
			vendor: route.option,
			priceSgd: shelf,
			// ⚠️ Price only. The size is unchanged by construction — `verdictFor` refuses
			// any pack whose size moved — and re-sending it would let a rounding difference
			// in the shop's own payload rewrite a figure this pass has no business touching.
			url: raw.url,
			itemName: raw.name,
		});
		const landed = res.slot != null && res.slot.kind !== "none";
		if (landed) {
			repaired++;
			lines.push(`      ✔ repaired — ${res.written.join(", ")}`);
		} else {
			refused++;
			lines.push(`      ✗ not written — ${describeSlotDecision(res.slot)}`);
		}
	}

	if (lines.length) console.log(`\n${row.name}\n${lines.join("\n")}`);
}

console.log(
	`\n${"─".repeat(78)}\n` +
		`${checked} recorded price(s) checked — ${promos} on a promo price, ${stale} otherwise stale, ` +
		`${resized} where the pack changed size, ${unidentified} whose product did not come back.\n` +
		(doWrite
			? `${repaired} repaired, ${refused} refused.\n`
			: `Nothing written (no --write).\n`),
);
