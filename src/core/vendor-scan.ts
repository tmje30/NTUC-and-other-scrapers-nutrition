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
import { evaluate } from "./match.js";
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
import { carousell } from "./stores/carousell.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { shengsiongFile } from "./stores/shengsiong-file.js";

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
 * The same switch the daily scan uses (`run.ts`). Sheng Siong blocks datacenter IPs, so
 * the cloud reads the residential runner's committed file and only a local run with
 * `SHENGSIONG_LIVE=1` hits the live API. Two surfaces that can disagree about which
 * module a shop means is how one of them quietly stops seeing that shop.
 */
const ss = process.env.SHENGSIONG_LIVE === "1" ? shengsiong : shengsiongFile;

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
	{ option: "Carousell", module: carousell, marketplace: true },
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

		rows.push({
			pageId: page.id,
			name,
			unitType,
			target: targetFor({
				pageId: page.id,
				name,
				unitType,
				tags,
				baseline: {
					priceSgd: cheapest?.slot.priceValue ?? null,
					size: cheapest?.slot.sizeValue ?? null,
				},
			}),
			slots,
			routes: matched,
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
	| { ok: false; reason: string; considered: number; belowFloor: StoreProduct[] };

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
