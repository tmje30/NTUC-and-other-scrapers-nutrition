import { Client } from "@notionhq/client";
import { config } from "./config.js";
import { INGREDIENTS_DS, ING_PROPS } from "./ingredients-schema.js";
import {
	DONT_SEARCH_TAGS,
	PARKED_TAG,
	TAGS_PROPERTY,
	isByWeight,
	multiSelectNames,
	normTag,
	packWeightOf,
	queryAll,
	selectName,
	titleText,
	type PlanTarget,
	type UnitType,
} from "./notion.js";
import { parseName } from "./parse.js";
import { evaluate, tokens } from "./match.js";
import { cheapestPlausible } from "./marketplace-size.js";
import {
	cheapestVendorSlot,
	readVendorSlots,
	resolveVendorSlotProps,
	type VendorSlot,
} from "./vendor-slots.js";
import type { StoreModule, StoreProduct } from "./stores/types.js";
import { guardian } from "./stores/guardian.js";
import { myprotein } from "./stores/myprotein.js";
import { carousellViaWorker } from "./stores/carousell-worker.js";
import { watsons } from "./stores/watsons.js";
import { iherb } from "./stores/iherb.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { shengsiongFile } from "./stores/shengsiong-file.js";
import { shengsiongViaWorker } from "./stores/shengsiong-worker.js";

/**
 * Fill the price book by asking the shops each row already names in `Vendor 1..4`.
 *
 * Every other writer in this project is a button: a person looked at one product and
 * pressed something. This is the first one that goes and looks by itself, so the
 * constraints it works under are tighter, and they are not new — they are the rules
 * `docs/vendor-scoping.md` wrote down for exactly this feature:
 *
 *   1. Match the vendor by NAME to find the index; never assume a slot.
 *   2. If no index names that shop, **write nothing** — reported, not silent.
 *   3. Never write `Vendor, Current ` (or anything else outside the slot) from a scan.
 *
 * Rule 2 is enforced in `recordVendorPrice`; this module's job is to decide what is
 * worth offering it.
 *
 * ⚠️ **It deliberately does NOT use `readGroceryTargets()`.** That reader serves the
 * deals pipeline and drops any row with no priced vendor slot ("no comparable baseline",
 * `notion.ts`) plus the `Suppliments`/`Filler` categories. Measured 2026-08-09: it
 * returns 26 targets, and **only one of the nine rows tagged with the three shops here
 * survives it**. That is circular — the row has no price, so the scan skips it, so it
 * never gets a price — and breaking that cycle is the entire point of this feature. So
 * this reads the database itself and keeps rows with no price at all.
 *
 * What it still honours are the two SUPPRESSION tags, because those say "do not go
 * looking for this", which applies to an automated search more than to anything else.
 */

/** A shop this scanner knows how to ask, keyed by its Notion `Vendor n` option name. */
export interface VendorRoute {
	/** Must match a live `Vendor n` select option — see `matchVendorOption`. */
	option: string;
	module: StoreModule;
	/**
	 * True for a marketplace, where the cheapest listing is usually the scam and the
	 * pick must come from `cheapestPlausible` rather than from the minimum.
	 */
	marketplace: boolean;
}

/**
 * Which Sheng Siong this scan speaks to. **Three answers, and picking the wrong one is
 * silent** — every one of them returns products, or plausibly nothing.
 *
 * | env | module | where it works |
 * | --- | --- | --- |
 * | *(default)* | `shengsiongFile` | anywhere — reads the committed scan file |
 * | `SHENGSIONG_LIVE=1` | `shengsiong` | Singapore only — the live DDP API |
 * | `SHENGSIONG_VIA_WORKER=1` | `shengsiongViaWorker` | **anywhere**, borrowing `ss-worker`'s Singapore placement |
 *
 * ⚠️⚠️ **The file is the wrong source for a vendor sweep, and this is the single decision
 * that decides whether a cloud sweep is real or theatre.** `data/shengsiong-latest.json`
 * holds only the ~60 terms the daily DEALS scan searched. A vendor-scan row whose term is
 * not one of them finds nothing — and finding nothing is indistinguishable from "not
 * stocked". That is the most likely explanation for the 2026-08-11 finding that **49 rows
 * tagged Sheng Siong had no price between them**, against 57 for NTUC.
 *
 * So a scheduled sweep in Actions MUST set `SHENGSIONG_VIA_WORKER=1`. Without it the job
 * runs daily, reports success, and writes nothing for the shop that is half the workload
 * (50 of the 120 row×vendor pairs). See `docs/daily-vendor-sweep-scope.md`.
 *
 * ⚠️ `run.ts` keeps the two-way switch on purpose: the daily deals scan is what PRODUCES
 * the file, so reading it there would be circular.
 */
const ss =
	process.env.SHENGSIONG_VIA_WORKER === "1"
		? shengsiongViaWorker
		: process.env.SHENGSIONG_LIVE === "1"
			? shengsiong
			: shengsiongFile;

/**
 * ⚠️ **`option` must be the live `Vendor n` select option, not the shop's own name.**
 * `matchVendorOption` compares exactly (normalised), so the supermarket whose module is
 * called `fairprice` is routed as **"NTUC"** — which is what the database says.
 *
 * NTUC and Sheng Siong are here even though the daily deals scan already searches them,
 * and that is the point: it searched them every day and threw the prices away. Measured
 * 2026-08-11, before this line existed: 49 rows name Sheng Siong and **not one of them
 * had a price recorded**, against 57 for NTUC. The shop the runner scrapes daily was the
 * biggest hole in the price book.
 */
export const ROUTES: VendorRoute[] = [
	{ option: "NTUC", module: fairprice, marketplace: false },
	{ option: "Sheng Siong", module: ss, marketplace: false },
	{ option: "Guardian", module: guardian, marketplace: false },
	{ option: "My Protein", module: myprotein, marketplace: false },
	// ⚠️ **Through `ss-worker`, and NOT because of geography** — this route only ever
	// runs from Singapore anyway. What Carousell refuses is the CLIENT: measured
	// 2026-08-17 from the laptop, Node's `fetch` gets 403 on `/search/` while `curl`
	// and the Worker's fetch both get 200. So the Worker is the transport that works
	// without a browser, and this shop stopped needing Chrome. `new-items.ts` made the
	// same swap that day and checked parity first: HTML 45 priced cards, CDP 47.
	// ⚠️ Needs `SCAN_SECRET` and a reachable `ss-worker`; a missing secret THROWS rather
	// than falling back to Chrome, so a broken config cannot hide behind a slower path
	// that happens to work. The CDP `carousell` export is untouched and is still what
	// `vendor-probe --browser` exercises.
	{ option: "Carousell", module: carousellViaWorker, marketplace: true },
	// ⚠️ **Laptop only.** Watsons needs a real HEADED Chrome (headless renders its footer
	// and nothing else), so this route cannot run in GitHub Actions — same constraint as
	// Carousell. Added 2026-08-11 for the 5 rows that named it and had no price at all:
	// the CeraVe lotion and four Sensodyne toothpastes, the same rows Guardian covers.
	{ option: "Watsons", module: watsons, marketplace: false },
	// ⚠️ Laptop only, same as Watsons and Carousell — plain fetch gets a 403 and headless
	// is detected. Expect FEW candidates: most of iHerb is capsules, whose titles state a
	// dose and a count but no pack weight, and those are dropped rather than guessed.
	{ option: "Iherb", module: iherb, marketplace: false },
];

/** One Ingredients row, with everything the scan needs to search and to write. */
export interface ScanRow {
	pageId: string;
	name: string;
	unitType: UnitType;
	/** Shaped for the existing matcher — see `targetFor`. */
	target: PlanTarget;
	slots: VendorSlot[];
	/** The routes this row actually asks for, in slot order. */
	routes: { route: VendorRoute; slot: VendorSlot }[];
	/** The biggest pack worth recording here, per `Size - Ceiling (g/ml)`. Null = no opinion. */
	sizeCeiling: number | null;
	/** The same ceiling as a WEIGHT, for candidates a shop lists by weight — `ceilingGramsFor`. */
	ceilingGrams: number | null;
	/** What one unit weighs on a By Unit row — `gramsPerUnitFor`. Null on a weighed row. */
	gramsPerUnit: number | null;
}

/**
 * The `Size - Ceiling (g/ml)` column — **the biggest pack this row will accept in its price
 * book.** Added to the schema by the user on 2026-08-13 after the scan recorded a **1 kg**
 * bag of white pepper as the NTUC price: honestly the cheapest per kilo, and not a pack
 * anyone buys pepper in. Sizes at or below it are fine; anything above is not offered.
 *
 * ⚠️ **It bounds the PRICE BOOK only** — the `Vendor n` slots, which exist for general
 * shopping and price comparison. The deals/discovery pipeline never sees it: a 5 kg sack
 * at half price is exactly the one-off purchase that page is for, and the user said so
 * explicitly. Nothing outside `vendor-scan` reads this.
 *
 * ⚠️ **`sizefloor` is kept as an alias and must not be dropped.** The column was created
 * as `Size - floor (g/ml)` and renamed to `Ceiling` the same day, because "floor" said the
 * opposite of what the number means. Same reasoning as `CATEGORY_ALIASES` and
 * `DONT_SEARCH_TAGS`: this database has already renamed a property out from under the code
 * once (`Catagory` → `Category`) and nothing errored — every read just returned `undefined`
 * for weeks. A bound that silently stops applying is the worst kind of bug here, because
 * the symptom is a 1 kg bag of pepper quietly reappearing in the price book.
 */
const SIZE_CEILING_PREFIXES = ["sizeceiling", "sizefloor"];

/**
 * Find the size-ceiling column, whatever its exact spacing and bracketing.
 *
 * Matched on a squashed name (letters and digits only) rather than verbatim, so
 * `Size - Ceiling (g/ml)`, `Size Ceiling (g)` and `Size-ceiling` are all the same column.
 * The prefixes are tried in order, so a workspace that somehow holds both spellings uses
 * the current one.
 */
export function findSizeCeilingProp(schema: Record<string, { type: string }>): string | null {
	const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
	for (const prefix of SIZE_CEILING_PREFIXES) {
		for (const [name, def] of Object.entries(schema ?? {})) {
			if (def?.type === "number" && squash(name).startsWith(prefix)) return name;
		}
	}
	return null;
}

/**
 * May this pack be recorded on a row whose ceiling is `ceiling`?
 *
 * ⚠️ **Compared against the number that would land in `Size[Vendor n]`** — `sizeFor`, not
 * `packWeightOf`. The column is labelled `(g/ml)` but a **By Unit** row states it in the
 * row's own units: the egg row carries 30, meaning thirty eggs, beside a recorded pack of
 * 10. Converting to grams there would compare thirty eggs against a tray's weight and
 * throw out every candidate. For By Gram / By ml rows the two are the same number anyway.
 *
 * ⚠️ **Inclusive.** The user's figure is the largest pack they WILL take, not the first one
 * they won't: the Milk (Low Fat) row states 2000 and its recorded NTUC pack is exactly
 * 2000 ml. An exclusive test would refuse the price already in the book.
 *
 * A candidate with no readable size gets no opinion, the same answer given everywhere else
 * — it will fail `unitKindAgrees` a few lines later if it truly has none.
 */
export function withinSizeCeiling(ceiling: number | null, size: number | null): boolean {
	if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return true;
	if (size == null || !Number.isFinite(size) || size <= 0) return true;
	return size <= ceiling;
}

/**
 * The ceiling expressed as a **weight**, so a shop that lists by weight can still be bounded.
 *
 * On a By Gram / By ml row the column is already grams or millilitres and comes back
 * unchanged. On a **By Unit** row it is a count, and a count cannot be compared against a
 * listing that only states a weight — which is most of them. Measured on the 2026-08-13
 * NTUC pass: `Stock cubes (120g)[Knorr]` and `Bread, Wholemeal, [FairPrice] (600g)` both
 * matched a real product and both were then thrown away as "measured by weight, but this
 * row is By Unit". The ceiling had nothing to say about either.
 *
 * So it is converted, by the user's own arithmetic (2026-08-13):
 *
 *   > By unit = 10, size = (350g), size ceiling = 30 units — which is 1050g, which would
 *   > be the weight ceiling.
 *
 * i.e. **`ceiling × (what the row's pack weighs ÷ how many are in it)`**. The weight comes
 * from the row's own `Name` — `egg  (Omega 3 Enriched) (550g)` — which is where this project
 * has always read the weight of a counted pack (`packWeightOf`), and the count from the
 * row's cheapest priced slot. Eggs: 550 g ÷ 10 = 55 g each, × 30 = a 1.65 kg ceiling.
 *
 * ⚠️ **Null rather than a guess whenever either half is missing.** A row whose Name states
 * no weight, or which has no priced slot to count against, gets no weight ceiling at all —
 * the count ceiling still applies to anything the shop does state a count for. Inventing a
 * grams-per-unit figure here would silently discard good candidates on exactly the rows
 * that have the least information to check the result against.
 */
export function ceilingGramsFor(
	unitType: UnitType,
	ceiling: number | null,
	packWeightG: number | null,
	packSize: number | null,
): number | null {
	if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return null;
	if (isByWeight(unitType)) return ceiling;
	const perUnit = gramsPerUnitFor(unitType, packWeightG, packSize);
	return perUnit == null ? null : ceiling * perUnit;
}

/**
 * What **one unit weighs** on a By Unit row: the weight its `Name` states, divided by the
 * count in its cheapest priced slot.
 *
 * `Stock cubes (120g)[Knorr]` recorded at 12 pcs ⇒ 10 g per cube. `egg (Omega 3 Enriched)
 * (550g)` at 10 pcs ⇒ 55 g per egg. This is not a new inference: `packWeightOf` has always
 * read a counted row's weight out of its `Name`, and `perLabel` already quotes the bread
 * row at `$4.00/kg` on exactly this arithmetic.
 *
 * Null on a weighed row (there are no units) and null whenever either half is missing.
 */
export function gramsPerUnitFor(
	unitType: UnitType,
	packWeightG: number | null,
	packSize: number | null,
): number | null {
	if (isByWeight(unitType)) return null;
	if (packWeightG == null || !Number.isFinite(packWeightG) || packWeightG <= 0) return null;
	if (packSize == null || !Number.isFinite(packSize) || packSize <= 0) return null;
	return packWeightG / packSize;
}

/**
 * How close to a whole number a derived count must land to be called clean.
 *
 * ⚠️ **Reporting only — it gates nothing.** The user's call, 2026-08-13, after the first
 * version queued FairPrice's 500 g loaf (16.67 slices) for a Telegram confirmation:
 *
 *   > it does not need to be exact. this is just a guide line to help guide a search and
 *   > calculate a ceiling weight
 *
 * Which is right, and the earlier design had the wrong idea of what this number is for. A
 * `Size[Vendor n]` on a counted row is a shopping aid — it decides roughly what a slice or
 * a cube costs, and it is compared against other slices and other cubes. Asking a human to
 * confirm 16.67 → 17 buys a rounding nobody will act on differently, at the cost of a
 * notification; and a review queue full of questions that did not need asking is one that
 * stops being read.
 *
 * So an inexact division is still written. All this decides is whether the console report
 * shows the raw figure beside it (`(16.7, rounded)`), which is how a wrong grams-per-unit
 * stays visible.
 */
export const DERIVED_COUNT_SLACK = 0.1;

/**
 * A **count** for a pack the shop only states a weight for.
 *
 * The user's point, 2026-08-13: the weight is right there in the title, and the row already
 * says what one unit weighs — so refusing the pack throws away information we have. It cost
 * two real rows on the 2026-08-13 NTUC pass, and one of them is the sharper example: the
 * top hit for `Stock cubes (120g)[Knorr]` was **the identical product at the identical
 * price** ($3.83, 120 g) that the row already records as 12 pcs, discarded for being
 * "measured by weight".
 *
 * `exact` says whether the division landed on a whole number (`DERIVED_COUNT_SLACK`). It is
 * **reporting detail and gates nothing** — an inexact count is written like any other, per
 * the user: *"it does not need to be exact"*. It only decides whether the report shows the
 * raw figure beside the rounded one.
 *
 * Returns null rather than a fraction below one: half a loaf is not a pack.
 */
export function unitCountFromWeight(
	gramsPerUnit: number | null,
	packWeightG: number | null,
): { count: number; exact: boolean } | null {
	if (gramsPerUnit == null || !Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) return null;
	if (packWeightG == null || !Number.isFinite(packWeightG) || packWeightG <= 0) return null;
	const raw = packWeightG / gramsPerUnit;
	const count = Math.round(raw);
	if (count < 1) return null;
	return { count, exact: Math.abs(raw - count) <= DERIVED_COUNT_SLACK };
}

/**
 * The number this candidate would put in `Size[Vendor n]`, and how confident we are in it.
 *
 * One gate for the whole write path, replacing a bare `unitKindAgrees` check. The order is
 * the important part: **a size the shop states always wins**, and the derivation is only
 * reached when there is nothing to state — so a shop that sells eggs by the dozen is still
 * recorded as twelve eggs, never as its weight divided by anything.
 *
 * ⚠️ It still cannot rescue a **counted** pack on a **weighed** row (a 4-pack of razors on
 * a By Gram row): that direction needs a weight the listing does not have, and inventing
 * one would misprice the row against every other vendor on it. `unitKindAgrees` remains the
 * rule; this only adds the one conversion the row itself supplies the constant for.
 */
/**
 * Is a refusal one the **user** can fix, by typing a size into the Notion name?
 *
 * The vendor-scan twin of `findWeightGap`, which does the same job for the deals page — the
 * "found eggs, but only in weight" nudge. The user's framing, 2026-08-13:
 *
 *   > the razor ex. there will never be weight on some items, since they are only sold as
 *   > x units. and will be labeled 'By unit' if it is mislabeled - it should be flagged
 *
 * ⚠️ **Which is why the PRODUCT's weight is required, not just the row's absence of one.**
 * `Razor Cartridge Refill - Hydro 5` and `Bathroom Tissue Roll - 4 Ply` are genuinely
 * countable-only: no shop publishes a weight for either, so no candidate ever satisfies
 * this and neither row is ever nagged about a weight that does not exist. The flag fires
 * only where a shop *did* state a weight the row had no constant to meet — which is exactly
 * the mislabelled case, and exactly the one that `Stock cubes (120g)` fixes.
 *
 * ⚠️ Callers must apply it only to a candidate the matcher ACCEPTED — same discipline as
 * `findWeightGap`. Advice to go and retype a Notion row is worth giving only when it will
 * actually work; sent on a near-miss it costs a trip to Notion and buys nothing.
 */
export function needsSizeInName(
	row: { unitType: UnitType; gramsPerUnit: number | null },
	product: { packWeightG?: number | null },
): boolean {
	if (isByWeight(row.unitType)) return false;
	if (row.gramsPerUnit != null) return false;
	const grams = product.packWeightG ?? null;
	return grams != null && Number.isFinite(grams) && grams > 0;
}

export function resolveSize(
	row: { unitType: UnitType; gramsPerUnit: number | null },
	product: StoreProduct,
): { size: number; derived: boolean; exact: boolean } | null {
	if (unitKindAgrees(row.unitType, product)) {
		const size = sizeFor(row.unitType, product);
		if (size != null && size > 0) return { size, derived: false, exact: true };
	}
	if (isByWeight(row.unitType)) return null;
	const d = unitCountFromWeight(row.gramsPerUnit, product.packWeightG ?? null);
	return d ? { size: d.count, derived: true, exact: d.exact } : null;
}

/**
 * Is this candidate small enough for the row's price book?
 *
 * The count is asked first and answers on its own where a shop states one — 30 eggs against
 * a ceiling of 30 needs no arithmetic. **The weight is only a fallback**, for the case the
 * user raised: the shop lists a loaf, not slices, so "By unit does not work" and the
 * derived `ceilingGrams` is the only bound available.
 *
 * ⚠️ Deliberately not both. A pack that states a count AND a weight is judged on the count,
 * because that is the number that will land in `Size[Vendor n]`; adding the derived weight
 * as a second gate would refuse packs at the stated ceiling whenever the shop's eggs happen
 * to be larger than the row's.
 */
export function packWithinCeiling(
	row: { unitType: UnitType; sizeCeiling: number | null; ceilingGrams: number | null },
	product: { unitCount?: number | null; packWeightG?: number | null },
): boolean {
	const size = sizeFor(row.unitType, product as StoreProduct);
	if (size != null) return withinSizeCeiling(row.sizeCeiling, size);
	return withinSizeCeiling(row.ceilingGrams, product.packWeightG ?? null);
}

/**
 * A `PlanTarget` good enough for `evaluate()`, built from a row that may have no price.
 *
 * ⚠️ **`qualityItem` is dropped when the row has no baseline**, and that is not a
 * shortcut. That check rejects a candidate whose normal price is under 75% of what this
 * item costs — against a baseline of zero it would reject every candidate, and a gate
 * that silently rejects everything looks exactly like a shop having no stock.
 *
 * The plan-usage fields are zeroed: nothing here ranks by monthly saving, it only asks
 * "is this the same product?", which `evaluate` answers from the name and the tags.
 */
export function targetFor(row: {
	pageId: string;
	name: string;
	unitType: UnitType;
	tags: string[];
	baseline: { priceSgd: number | null; size: number | null };
}): PlanTarget {
	const search = parseName(row.name);
	const hasTag = (t: string) => row.tags.some((x) => normTag(x) === normTag(t));
	const packPriceSgd = row.baseline.priceSgd ?? 0;
	const packSize = row.baseline.size ?? 0;
	const packWeightG = isByWeight(row.unitType) ? (packSize || null) : (search.size?.grams ?? null);
	const hasBaseline = packPriceSgd > 0 && packSize > 0;

	return {
		ingredientId: row.pageId,
		name: row.name,
		search,
		category: "",
		// Not the routing list here: vendor-scan is ALREADY directed — it asks a shop
		// only because a slot names it — so this synthetic target carries no vendors
		// and nothing reads them on this path.
		vendors: [],
		unitType: row.unitType,
		tags: row.tags,
		brandSpecific: hasTag("Brand Specific"),
		qualityItem: hasBaseline && hasTag("Quality item"),
		organicWelfare: hasTag("Organic/animal welfare"),
		weeklyBuy: false,
		packPriceSgd,
		packSize,
		packWeightG,
		baselinePer100g: hasBaseline && packWeightG ? (packPriceSgd / packWeightG) * 100 : null,
		baselinePerUnit: hasBaseline && row.unitType === "By Unit" ? packPriceSgd / packSize : null,
		monthlyAmount: 0,
		monthlyAmountG: 0,
		monthlyPacks: 0,
		monthlyCostSgd: 0,
		inActivePlan: false,
	};
}

/**
 * Every row that names at least one of the shops we can ask.
 *
 * `routes` is built from what the ROW says, so a shop is only ever searched for an item
 * the user pointed at it — the "directed search" rule. A row naming no known shop simply
 * isn't returned.
 */
export async function readScanRows(
	client: Client,
	routes: VendorRoute[] = ROUTES,
): Promise<{ rows: ScanRow[]; skipped: { name: string; why: string }[] }> {
	const dsAny = (await client.dataSources.retrieve({ data_source_id: INGREDIENTS_DS } as any)) as any;
	const slotDefs = resolveVendorSlotProps(dsAny.properties ?? {});
	const ceilingProp = findSizeCeilingProp(dsAny.properties ?? {});

	const pages = await queryAll(client, INGREDIENTS_DS);
	const rows: ScanRow[] = [];
	const skipped: { name: string; why: string }[] = [];

	for (const page of pages) {
		const p = page.properties;
		const name = titleText(p[ING_PROPS.NAME]);
		if (!name) continue;

		const tags = multiSelectNames(p[TAGS_PROPERTY]);
		const hasTag = (t: string) => tags.some((x) => normTag(x) === normTag(t));
		// The two suppression tags, compared through `normTag` and never with `===` —
		// the option was once spelled `Don'r Search` and a tag that stops matching
		// silently is the worst kind of bug here.
		if (hasTag(PARKED_TAG) || DONT_SEARCH_TAGS.some(hasTag)) {
			skipped.push({ name, why: "tagged Not in Use ATM / Don't Search" });
			continue;
		}

		const slots = readVendorSlots(p, slotDefs);
		const matched: { route: VendorRoute; slot: VendorSlot }[] = [];
		for (const slot of slots) {
			if (!slot.vendorName) continue;
			const route = routes.find((r) => normTag(r.option) === normTag(slot.vendorName));
			if (route) matched.push({ route, slot });
		}
		if (!matched.length) continue;

		const unitType = (selectName(p[ING_PROPS.UNIT_TYPE]) as UnitType) || "By Gram";
		const cheapest = cheapestVendorSlot(slots);
		const target = targetFor({
			pageId: page.id,
			name,
			unitType,
			tags,
			baseline: {
				priceSgd: cheapest?.slot.priceValue ?? null,
				size: cheapest?.slot.sizeValue ?? null,
			},
		});
		const sizeCeiling =
			ceilingProp && typeof p[ceilingProp]?.number === "number" ? p[ceilingProp].number : null;

		rows.push({
			pageId: page.id,
			name,
			unitType,
			target,
			slots,
			routes: matched,
			sizeCeiling,
			ceilingGrams: ceilingGramsFor(unitType, sizeCeiling, target.packWeightG, target.packSize),
			gramsPerUnit: gramsPerUnitFor(unitType, target.packWeightG, target.packSize),
		});
	}
	return { rows, skipped };
}

/**
 * The search text sent to a directed vendor.
 *
 * ⚠️ **The brand is INCLUDED here, unlike in the daily scan**, and the divergence is
 * deliberate. The bracket standard keeps `[Brand]` out of the search text because at a
 * supermarket it over-narrows a general hunt for a cheaper equivalent. This is the
 * opposite situation: one named shop, one named product, and Guardian sells fifty
 * toothpastes — "Repair & Protect" without "Sensodyne" is not a query. The brand is
 * still not a *filter* here; `evaluate()` remains the gate, exactly as elsewhere.
 */
export function searchTermsFor(target: PlanTarget): string[] {
	const s = target.search;
	const clean = (x: string) => x.replace(/\s+/g, " ").trim();
	const withBrand = (text: string) => clean([s.brand, text].filter(Boolean).join(" "));

	const terms: string[] = [];
	const push = (t: string) => {
		if (t && !terms.includes(t)) terms.push(t);
	};

	push(withBrand(s.searchTerm));

	// ⚠️ Fallback: drop the trailing " - variant" clause and ask again.
	//
	// Not a guess — it is the shop's own dash, the one separator FairPrice and Sheng
	// Siong both use between a product and its variant, and which `generic-name.ts`
	// already splits on. A shop's search engine treats the variant as extra words to
	// satisfy: measured 2026-08-09, "Sensitivity Gum Toothpaste - Original" returned
	// **nothing** from Guardian while the same query without "- Original" returned 23
	// products including the exact item, listed at $8.65.
	//
	// This widens the search, never the acceptance: `evaluate()` still has to accept
	// whatever comes back, so a broader query cannot let a wrong product through.
	const beforeDash = s.searchTerm.split(/\s+[-–—]\s+/)[0];
	if (beforeDash && beforeDash !== s.searchTerm) push(withBrand(beforeDash));

	// ⚠️ **The row's own words, which `searchTerm` can silently throw away.**
	//
	// `parseName("whey, essential  [MyProtein]")` returns `searchTerm: "whey"` — the
	// clause after the comma is dropped entirely, appearing in neither `mustMatch` nor
	// `properties` nor `ignored`. So the shop was asked for "myprotein whey" and duly
	// ranked *Impact Diet Whey* first, while **Essential Whey Protein** — the actual
	// product, and one MyProtein sells — never came back at all. Measured 2026-08-09:
	// searching "whey essential" returns it as the top three hits.
	//
	// So the row's own words are tried as their own term. Broader than `searchTerm` by
	// construction, and still gated by `evaluate()`, which is what makes a wider net safe.
	//
	// ⚠️ **The bracketed BRAND is removed here, not just its brackets** — the opposite of
	// term 1, and both are needed. Term 1 adds the brand because Guardian sells fifty
	// toothpastes. This one drops it because a shop's own site search chokes on its own
	// name: measured, "whey essential MyProtein" returns **nothing** from MyProtein while
	// "whey essential" returns Essential Whey Protein as its top three hits.
	//
	// ⚠️⚠️ **And it is used ONLY when it adds a word `searchTerm` lacks.** Caught live
	// before it could write: `whey [Atlas]` strips to the bare term **"whey"**, which
	// matched *"optimum nutrition gold standard 100 whey protein 5 lbs"* at $35 — a
	// listing this project already believes is counterfeit — and would have filed it as
	// the Atlas price. A term that drops the only distinguishing word does not widen the
	// search, it erases the question.
	const bare = clean(target.name.replace(/\[[^\]]*\]/g, " ").replace(/[{}()[\],;]/g, " "));
	const words = (x: string) => new Set(x.toLowerCase().split(/\s+/).filter(Boolean));
	const already = words(s.searchTerm);
	if ([...words(bare)].some((w) => !already.has(w))) push(bare);

	push(clean(target.name));
	return terms.length ? terms : [target.name];
}

/** The first term to try. Kept for callers that want one string. */
export function searchTermFor(target: PlanTarget): string {
	return searchTermsFor(target)[0];
}

export type CandidateOutcome =
	| {
			ok: true;
			product: StoreProduct;
			per100: number;
			considered: number;
			rejected: StoreProduct[];
			/** Cheaper matches that failed the price floor, cheapest first — see `belowFloor`. */
			belowFloor: StoreProduct[];
	  }
	| {
			ok: false;
			reason: string;
			considered: number;
			belowFloor: StoreProduct[];
			/**
			 * ⚠️ The most plausible product that did NOT match — review band, never accept.
			 * Offered as a suggestion so a pair that finds nothing says WHAT it nearly found.
			 * See `bestNearMiss`.
			 */
			nearMiss?: StoreProduct | null;
	  };

/**
 * How far below a KNOWN price for the same ingredient a marketplace listing may sit
 * before it is treated as counterfeit rather than cheap.
 *
 * ⚠️ This is the second, independent guard on a marketplace, and it exists because the
 * first one can be fooled. `cheapestPlausible` compares a listing against the OTHER
 * LISTINGS, so when a search is dominated by fakes the median itself is fake and the
 * whole set passes — measured 2026-08-09: a bare "whey protein" search had so many
 * cheap listings that nothing was rejected, while a focused "gold standard" search put
 * the same 5 lb tub at **$35–$47 against a $85–$99 cluster**, a 2.3× gap on an identical
 * SKU with every listing badged New.
 *
 * A price the user has already recorded at another shop is not fooled that way. 45% is
 * deliberately generous — a genuine marketplace find IS meaningfully cheaper than retail,
 * and this is meant to catch "too good to be real", not "a good deal".
 */
const MIN_FRACTION_OF_KNOWN_PRICE = 0.5;

/**
 * A listing under the floor is not refused outright — it gets ONE way back in: the
 * seller's own reputation. Set by the user 2026-08-09.
 *
 * The reasoning is that a suspiciously cheap price is a question, not a verdict, and an
 * established seller with a long clean record is the answer to it. Both thresholds must
 * be met.
 *
 * ⚠️ **An unknown reputation never rescues anything** — see `reputationPasses`. The
 * listing page is lazy-rendered and often yields nothing, and "we could not check" must
 * not read as "we checked and it was fine" for a price we already flagged.
 *
 * ⚠️ Known limitation, worth re-reading before trusting a rescue: Carousell reviews are
 * not product-specific. The 5.0/755 seller inspected while building this had their visible
 * review on a *Polly Pocket toy*. Reputation measures whether a transaction completes
 * smoothly, not whether the goods are genuine — and a high-volume counterfeit seller
 * accumulates exactly this profile. This gate is therefore a second opinion on a price,
 * never a guarantee about a product.
 */
const MIN_SELLER_REVIEWS = 50;
const MIN_SELLER_RATING = 4.5;

/**
 * Does this seller clear the bar that lets an under-floor price back in?
 *
 * ⚠️ A **stated** zero ("N/A — No review yet") and an **unreadable** reputation both
 * refuse, but they are not the same fact and the report says which. The first is the
 * strongest warning the page offers — a brand-new account with no history, listing a
 * branded product at half price — and it was originally being thrown away as "could not
 * check", which is the most permissive reading of the least trustworthy seller there is.
 */
export function reputationPasses(rep: {
	rating: number | null;
	reviews: number | null;
}): boolean {
	if (rep.reviews == null || rep.rating == null) return false; // unknown ⇒ no rescue
	return rep.reviews >= MIN_SELLER_REVIEWS && rep.rating >= MIN_SELLER_RATING;
}

/** How a reputation reads in the report — the three cases kept distinct. */
export function describeReputation(rep: {
	rating: number | null;
	reviews: number | null;
	ageMonths?: number | null;
}): string {
	const age =
		rep.ageMonths == null
			? ""
			: rep.ageMonths >= 12
				? `, ${Math.floor(rep.ageMonths / 12)}y on Carousell`
				: `, only ${rep.ageMonths} month(s) on Carousell`;
	if (rep.reviews === 0) return `no reviews at all${age}`;
	if (rep.reviews == null && rep.rating == null) return "could not be read";
	return `${rep.rating ?? "?"}★ from ${rep.reviews ?? "?"} review(s)${age}`;
}

/** The thresholds, for the report — so a run explains itself without reading this file. */
export const REPUTATION_BAR = { reviews: MIN_SELLER_REVIEWS, rating: MIN_SELLER_RATING };

/**
 * The cheapest price already recorded for this row, per 100 g, ignoring one slot.
 *
 * The slot being written is excluded so a scan can never validate a candidate against
 * its own previous answer — otherwise one bad write becomes the reference that justifies
 * the next one.
 *
 * ⚠️ **It divides by what the pack WEIGHS, never by `Size[Vendor n]` directly**, and that
 * distinction is the whole function. `Size[Vendor n]` holds whatever `Unit type ` says it
 * holds — grams, millilitres, *or a count of eggs* — so the old `pricePer1000(...) / 10`
 * read a count of 10 as 10 grams and called $3.99 a box **$39.90/100g**, against a true
 * $0.73. That is 55× too high, and it was not cosmetic: this number becomes
 * `floor = reference * MIN_FRACTION_OF_KNOWN_PRICE`, so every genuine listing fell *below*
 * the counterfeit floor and was discarded — a counted row silently yielded no vendor
 * prices at all, with an authoritative-looking reason quoting the nonsense back.
 * See `docs/session-2026-08-11-price-per-kg.md`.
 *
 * ⚠️ **Each slot is divided by ITS OWN item name's weight**, never another slot's. The
 * slots describe different packs at different shops; borrowing Guardian's 550 g to divide
 * FairPrice's price invents a figure that is no shop's.
 *
 * A counted row with no stated weight anywhere contributes **nothing** rather than a
 * guess — null is a real answer here (a razor cartridge has no meaningful weight), and a
 * row with no weighable reference simply has no floor, which is the safe direction.
 */
export function referencePer100g(
	slots: VendorSlot[],
	excludeSlotN: number,
	row: { unitType: UnitType; name: string },
): number | null {
	let best: number | null = null;
	for (const slot of slots) {
		if (slot.n === excludeSlotN) continue;
		if (slot.priceValue == null || slot.priceValue <= 0) continue;
		const grams = packWeightOf(row.unitType, slot.sizeValue, row.name, slot.itemNameValue);
		if (grams == null || grams <= 0) continue;
		const per100 = (slot.priceValue / grams) * 100;
		if (best == null || per100 < best) best = per100;
	}
	return best;
}


/**
 * The one candidate worth recording, or why there isn't one.
 *
 * Two gates, in order, and neither is optional:
 *
 * 1. **`evaluate()`** — the project's own matcher, ACCEPT band only. A search hit is not
 *    a match: "impact whey protein" returns peanut butter, and a name the matcher would
 *    not publish as a deal has no business being written into the price book either.
 * 2. **The price rule**, which differs by shop kind. A real retailer's catalogue is
 *    trustworthy, so the cheapest per unit wins. On a **marketplace it does not** — the
 *    minimum is usually the scam (ON Gold Standard 5 lbs at S$37 against ~S$120 retail),
 *    so `cheapestPlausible` drops everything under ~55% of the median first.
 */
/**
 * **The best of the ones that didn't quite make it.**
 *
 * ⚠️ Review band only — `accept` is a match and belongs in the price book; anything
 * below the review threshold is not worth showing. Ranked by how well it matched, NOT
 * by price: a suggestion is a question about identity, and the cheapest near-miss is
 * usually the least like the thing asked for.
 *
 * ⚠️⚠️ Measured 2026-09-02: Sheng Siong stocks Meiji's *pasteurized* skimmed milk,
 * which is fresh milk but never prints the word, so `Milk (Fresh) (Skimmed)` searched
 * three terms across 85 results and reported nothing at all. The product was there the
 * whole time.
 */
export function bestNearMiss(target: PlanTarget, priced: StoreProduct[]): StoreProduct | null {
	// ⚠️⚠️ **A suggestion must at least NAME the thing.** The review band alone is too
	// loose to offer a product by: measured 2026-09-02, a `Banana (Fruit)` row whose Sheng
	// Siong search returned a single priced result offered "3 Mixed Cargo Rice" — nothing
	// in common with the row at all. One shared token with the row's own search term is a
	// low bar, and it is exactly the bar that junk fails.
	const wanted = new Set(tokens(target.search.searchTerm));
	const namesIt = (product: StoreProduct): boolean => {
		if (!wanted.size) return false;
		const have = new Set(tokens(`${product.name} ${product.brand ?? ""}`));
		for (const t of wanted) if (have.has(t)) return true;
		return false;
	};

	const scored = priced
		.filter(namesIt)
		.map((product) => ({ product, m: evaluate(target, product) }))
		.filter((x) => x.m.verdict === "review")
		.sort((a, b) => b.m.adjusted - a.m.adjusted);
	return scored[0]?.product ?? null;
}

export function pickCandidate(
	target: PlanTarget,
	products: StoreProduct[],
	{ marketplace, reference = null }: { marketplace: boolean; reference?: number | null },
): CandidateOutcome {
	const priced = products.filter((p) => p.pricePer100g != null && p.pricePer100g > 0);
	if (!priced.length) {
		return {
			ok: false,
			considered: products.length,
			belowFloor: [],
			reason: products.length
				? `${products.length} result(s), none with both a price and a readable size`
				: "no results",
		};
	}

	const matching = priced.filter((p) => evaluate(target, p).verdict === "accept");
	if (!matching.length) {
		return {
			ok: false,
			considered: priced.length,
			belowFloor: [],
			nearMiss: bestNearMiss(target, priced),
			reason: `${priced.length} priced result(s), none matched "${target.name}"`,
		};
	}

	if (!marketplace) {
		const best = [...matching].sort((a, b) => a.pricePer100g! - b.pricePer100g!)[0];
		return {
			ok: true,
			product: best,
			per100: best.pricePer100g!,
			considered: matching.length,
			rejected: [],
			belowFloor: [],
		};
	}

	// Guard 1 — against a price the user has already seen elsewhere. Applied FIRST so
	// the median below is taken over survivors: a search full of counterfeits otherwise
	// sets its own standard of normal. Skipped when the row has no recorded price yet,
	// which is the case this cannot help with.
	//
	// ⚠️ Under-floor listings are NOT discarded here — they are handed back as
	// `belowFloor`, cheapest first, so the caller can offer each one the reputation
	// rescue (`reputationPasses`). Deciding that needs a browser and a network round
	// trip, which is exactly what does not belong in a pure function.
	const floor = reference != null ? reference * MIN_FRACTION_OF_KNOWN_PRICE : null;
	const counterfeit = floor != null ? matching.filter((p) => p.pricePer100g! < floor) : [];
	const credible = floor != null ? matching.filter((p) => p.pricePer100g! >= floor) : matching;
	const belowFloor = [...counterfeit].sort((a, b) => a.pricePer100g! - b.pricePer100g!);
	if (!credible.length) {
		return {
			ok: false,
			considered: matching.length,
			belowFloor,
			reason:
				`all ${matching.length} match(es) were under ${Math.round(MIN_FRACTION_OF_KNOWN_PRICE * 100)}% of the ` +
				`$${reference!.toFixed(2)}/100g already recorded for this item`,
		};
	}

	// Guard 2 — against the other listings. The minimum on a marketplace is usually the
	// scam even when nothing external contradicts it.
	const withPer = credible.map((p) => ({ p, pricePer100g: p.pricePer100g! }));
	const { pick, rejected } = cheapestPlausible(withPer);
	if (!pick) {
		return {
			ok: false,
			considered: matching.length,
			belowFloor,
			reason: "every candidate was rejected as implausibly cheap",
		};
	}
	return {
		ok: true,
		product: pick.p,
		per100: pick.pricePer100g,
		considered: credible.length,
		rejected: [...counterfeit, ...rejected.map((r) => r.p)],
		belowFloor,
	};
}

/**
 * Does this candidate's size mean the same thing as the row's `Unit type `?
 *
 * ⚠️ The scan must never write `Unit type ` (it is row-level and governs every slot), so
 * a candidate measured in a different kind of unit cannot be recorded at all: putting
 * millilitres into a row whose `Unit type ` says grams silently misprices it against
 * every other vendor on the row.
 *
 * By Gram vs By ml is a real distinction the row makes, but g and ml are interchangeable
 * for the 1:1 arithmetic this project already does everywhere, so only a **By Unit** row
 * genuinely conflicts with a weighed pack.
 */
export function unitKindAgrees(unitType: UnitType, product: StoreProduct): boolean {
	if (unitType === "By Unit") return product.unitCount != null && product.unitCount > 0;
	return product.packWeightG != null && product.packWeightG > 0;
}

/** The size to write, in whatever the row's `Unit type ` counts. */
export function sizeFor(unitType: UnitType, product: StoreProduct): number | null {
	return unitType === "By Unit" ? (product.unitCount ?? null) : (product.packWeightG ?? null);
}

export function notionClient(): Client {
	return new Client({ auth: config.notionToken() });
}

/**
 * One slot whose recorded price actually MOVED this run.
 *
 * ⚠️ **A write is not news; a change is.** The sweep rewrites a slot even when the shop
 * is charging exactly what it charged yesterday — that refreshes the URL and item name,
 * which is worth doing and worth saying nothing about. Reporting every write would make
 * the daily message a wall of unchanged numbers, and a message nobody reads is worse
 * than no message, because muting the bot costs the deals digest with it.
 */
export interface PriceMove {
	/** The Ingredients row, for the line the user reads. */
	row: string;
	/** The shop, named as the `Vendor n` option. */
	vendor: string;
	/** What the slot held, e.g. `$85.00 / 2500g`. Empty when the slot had no price. */
	recordedText: string;
	/** What it holds now, same shape. */
	foundText: string;
	/** `pricePer1000` of the old value — **null means the slot was empty**, which is a
	 *  first price rather than a reduction, and is reported as such. */
	recordedPer1000: number | null;
	foundPer1000: number;
	/** What `pricePer1000` means on this row: `kg`, `L`, or `1000 pcs`. */
	perWord: string;
}

/**
 * The morning message about the price book — or **null when there is nothing to say**.
 *
 * ⚠️ **Silence is the default and it is deliberate.** The sweep runs unattended every
 * day; on most days every price is the same as yesterday's and the honest report is
 * nothing at all. `null` here means "send no message", not "send an empty one".
 *
 * ⚠️ **An empty slot being filled is news too**, not just a reduction. A row that has
 * never had a price at this shop is exactly the gap the price book exists to close — the
 * 2026-08-11 report found 49 rows tagged Sheng Siong with no price between them — so a
 * first price is reported alongside the reductions rather than folded into the silent
 * "re-confirmed" count.
 *
 * `reconfirmed` is stated but never itemised: it is the reassurance that the sweep ran
 * and looked at things, in one number, which is all it is worth.
 */
export function renderPriceMoves(
	moves: PriceMove[],
	reconfirmed: number,
	esc: (s: string) => string = (s) => s,
): string | null {
	const cheaper = moves.filter((m) => m.recordedPer1000 != null);
	const first = moves.filter((m) => m.recordedPer1000 == null);
	if (!cheaper.length && !first.length) return null;

	const money = (n: number, per: string) => `$${n.toFixed(2)}/${per}`;
	const headline = [
		cheaper.length ? `<b>${cheaper.length} price${cheaper.length === 1 ? "" : "s"} got cheaper</b>` : "",
		first.length ? `${first.length} newly recorded` : "",
	]
		.filter(Boolean)
		.join(" · ");

	const line = (m: PriceMove) =>
		m.recordedPer1000 == null
			? `• ${esc(m.row.trim())} — ${esc(m.vendor)}, first price: ${esc(m.foundText)} = ${money(m.foundPer1000, m.perWord)}`
			: // ⚠️ Price AND size on both sides, not just the per-kilo figure — the same
				// reason `dearerThanRecorded` quotes both: on a By-Unit row the per-kilo
				// numbers can agree while the pack changes underneath them, and a line
				// reading "$4.00/kg → $4.00/kg" is unanswerable.
				`• ${esc(m.row.trim())} — ${esc(m.vendor)} ${esc(m.recordedText)} = ${money(m.recordedPer1000!, m.perWord)}` +
				` → <b>${esc(m.foundText)} = ${money(m.foundPer1000, m.perWord)}</b>`;

	return (
		`🧾 ${headline}\n` +
		[...cheaper, ...first].map(line).join("\n") +
		(reconfirmed ? `\n\n${reconfirmed} other${reconfirmed === 1 ? "" : "s"} re-confirmed unchanged.` : "")
	);
}
