import { Client } from "@notionhq/client";
import { config } from "./config.js";
import { parseName, type ParsedName } from "./parse.js";
import { cheapestVendorSlot, readVendorSlots, resolveVendorSlotProps } from "./vendor-slots.js";
import { parseWeightInText } from "./stores/weight.js";

/**
 * Reads the Ingredients data and resolves the "active plan" grocery targets the
 * scraper should search for.
 *
 * **The plan is whatever you tag `Main`.** In Meal prep, marking a meal's
 * `Current Plan` as "Main" puts that meal in the plan; the plan's ingredients
 * are the ingredients of those meals' sub-item lines, and each one's daily usage
 * is the sum of the `Amount Used ` on the lines that reference it. Monthly =
 * daily × 20, the same 20-day month the DB's own `Monthly[20]` figure uses.
 *
 * That makes the tag the switch, and the only one: re-tag your meals in Notion
 * and the next scan follows, with no config to change. Tag nothing and the plan
 * is empty — there is no second source to fall back on. Before 2026-08-04 this
 * read the Ingredients `Used 'N' Plan` formula with N from `ACTIVE_PLAN_NUMBER`
 * instead: the same ingredients by a longer route (the Main meals' lines ARE the
 * `Formula 'N'` lines), but retagging did nothing. Both are gone.
 *
 * Notion SDK v5: query via dataSources.query (see LEARNINGS 2026-07-27).
 */

// Stable data-source id (discovered via introspect; see LEARNINGS). Defined in
// `ingredients-schema.ts` and re-exported here so the scraper and the Chrome
// extension share one source of truth — the extension can't import this module
// (it would pull @notionhq/client into the browser bundle).
export { INGREDIENTS_DS } from "./ingredients-schema.js";
import { INGREDIENTS_DS } from "./ingredients-schema.js";

/**
 * Meal prep data source — the meal side of the plan. Not in
 * `ingredients-schema.ts` because the extension never touches it; only the plan
 * reader below does.
 */
export const MEAL_PREP_DS = "34b69a18-4fe7-8086-83fa-000b24c37d2b";

/**
 * The Meal prep column saying a meal is part of the plan being eaten now, and
 * the value that means yes.
 *
 * Looked up through `propByName`/`normTag` rather than by exact key because this
 * column has already changed shape once: it was a select until 2026-08-04 and is
 * now a string formula, and its Notion name carries a trailing space
 * (`"Current Plan "`). Neither a re-typed name nor another select→formula flip
 * should quietly empty the plan — see `planTagText`.
 */
const CURRENT_PLAN_PROP = "Current Plan";
const MAIN_VALUE = "Main";

/** Sub-item line properties the plan is built from. */
const SUB_ITEM_PROP = "Sub-item";
const LINE_INGREDIENTS_PROP = "Ingredients";
const LINE_AMOUNT_PROP = "Amount Used";

/**
 * Days of the plan in a month. Meal prep costs a plan over 20 days, not 30 —
 * `Used 'N' Plan` renders "Monthly[20]" — so daily × 20 is what reproduces the
 * DB's own monthly figures. Verified 2026-08-04: for all 33 plan ingredients
 * that carry a `Used '1' Plan` value, daily × 20 equals it exactly.
 */
const PLAN_DAYS_PER_MONTH = 20;

/**
 * The multi-select carrying an ingredient's search flags, and the one tag that
 * takes it out of the scan entirely. Named here rather than at each use site so
 * the reader (`readGroceryTargets`) and the writer (the page's "Not in use"
 * button) can never drift apart on the exact spelling Notion stores.
 */
export const TAGS_PROPERTY = "Select";
export const PARKED_TAG = "Not in Use ATM";

/**
 * Permanently excluded from the scan by the user. Same effect as `PARKED_TAG` —
 * the row is never searched and never reaches the page — but the two are NOT
 * interchangeable:
 *
 *   `Not in Use ATM`  is written BY this tool (the page's "Not in use" button)
 *                     and is meant to be undone.
 *   `Don't Search`    is set by hand in Notion and is permanent. Nothing here
 *                     may ever write it, clear it, or offer a button that
 *                     undoes it — see `park.ts`.
 *
 * The option was briefly spelled "Don'r Search" (an `r`, not a `t`) and was
 * renamed in Notion on 2026-07-31. The old spelling is kept here deliberately:
 * it costs nothing, and a select option renamed by hand can just as easily be
 * mistyped again. Comparison also folds case, curly apostrophes and stray
 * spacing (see `normTag`), so a cosmetic edit in Notion cannot silently switch
 * the exclusion off — which, for a tag whose whole job is to suppress items,
 * would fail in the direction the user would notice last.
 */
export const DONT_SEARCH_TAGS = ["Don't Search", "Don'r Search"];

/** Fold case, apostrophe style and stray whitespace before comparing tag names. */
export function normTag(s: string): string {
	return s
		.toLowerCase()
		.replace(/[‘’ʼ´`]/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

// Categories that are NOT groceries (skip for v1; a supplement scraper is future).
const NON_GROCERY_CATEGORIES = new Set(["Suppliments", "Filler"]);

// "By ml" is a weight-based type: the whole system treats ml ≈ g (water
// density), so By-ml items are compared on price-per-100 exactly like By-Gram —
// only the display unit (ml/L vs g/kg) differs, driven by each product's
// `volumetric` flag. Keeping it separate from By-Gram lets the display know the
// baseline is a liquid even when a matched product's own unit is ambiguous.
export type UnitType = "By Gram" | "By ml" | "By Unit";

/** By-Gram and By-ml are both compared on price-per-100 (ml ≈ g). */
export function isByWeight(u: UnitType): boolean {
	return u === "By Gram" || u === "By ml";
}

/**
 * What one pack WEIGHS, as opposed to how many of it there are.
 *
 * ⚠️ **`size` is `Size[Vendor n]`, and it holds whatever `Unit type ` says it
 * holds** — grams, millilitres, or a count of eggs. Reading a count as grams is
 * how a $3.99 box of ten was filed as `$399.00/kg` on 2026-08-10 (that is
 * 3.99 ÷ 10 × 1000 — the price of a *thousand eggs*, wearing a "/kg" label).
 *
 * For a counted row the weight has to be written down in words, and the rule
 * (from the user, 2026-08-11) is: **the shop's own `Item Name [Vendor n]` first,
 * and the row's general `Name` when that says nothing.** Null when neither does —
 * meaning the thing is genuinely sold by the piece, and wants no weight invented:
 * a razor cartridge, a tissue roll, a stock cube.
 *
 * ⚠️ **The item name is asked first because it describes the pack being
 * divided.** It comes from the same slot as the price and the size, so the three
 * are guaranteed to be about one pack at one shop. The row's `Name` is global
 * across all four slots — "Bread, Wholemeal (600g)" stays 600 g while the cheapest
 * slot moves between shops selling 400 g and 600 g loaves — so it is the honest
 * fallback, not the first answer. They only ever disagree when both state a size.
 *
 * ⚠️ Pass the item name of the slot whose price you are dividing, and no other.
 * Borrowing Guardian's pack weight to divide FairPrice's price invents a figure
 * belonging to neither.
 *
 * One function because three readers need the same answer —
 * `readGroceryTargets` for the deal comparison, `readIngredientRows` for the
 * texted list, and `referencePer100g` for the vendor scan's counterfeit floor —
 * and a rule this quiet, implemented three times, drifts.
 */
export function packWeightOf(
	unitType: UnitType,
	size: number | null,
	name: string,
	slotItemName: string,
): number | null {
	if (isByWeight(unitType)) return size;
	return parseWeightInText(slotItemName)?.grams ?? parseName(name).size?.grams ?? null;
}

export interface PlanTarget {
	ingredientId: string;
	name: string;
	search: ParsedName;
	category: string;
	unitType: UnitType;
	/** `Select` multi-select tags on the row (e.g. "Brand Specific", "Weekly Buy"). */
	tags: string[];
	/** True when tagged `Brand Specific`: only the [bracketed] brand may match. */
	brandSpecific: boolean;
	/**
	 * True when tagged `Quality item`: reject budget products. A candidate whose
	 * NORMAL (non-sale) price per 100 is under 75% of what this item costs at full
	 * price is treated as a cheaper grade, not a bargain. Its discounted price may
	 * be as low as it likes — only the undiscounted price is judged.
	 */
	qualityItem: boolean;
	/** True when tagged `Organic/animal welfare`: only certified/welfare products. */
	organicWelfare: boolean;
	/**
	 * True when tagged `Weekly Buy`: bought on a rhythm rather than when the pack
	 * runs out, so buying more of it does not buy more silence. The cooldown after
	 * a Buy is a flat 5 days regardless of pack size — see `planCooldown`.
	 *
	 * ⚠️ It affects the COOLDOWN only. It is not a matching rule: a weekly item is
	 * searched, scored and priced exactly like any other.
	 */
	weeklyBuy: boolean;
	/** Whole-pack price (SGD) and pack size (grams for By Gram, count for By Unit). */
	packPriceSgd: number;
	packSize: number;
	/**
	 * The pack's weight in grams/ml, whatever the row is counted in. Same as
	 * `packSize` for By-Gram and By-ml rows; for a By-Unit row it comes from a size
	 * written into the row's `Name` — "Bread, Wholemeal (600g)" is bought in 20
	 * slices but sold by the shop by weight — or, failing that, from the cheapest
	 * slot's `Item Name [Vendor n]`.
	 *
	 * ⚠️ **Null means sold by the piece, and is a real answer.** Neither place
	 * stating a weight is how a razor cartridge, a tissue roll or a stock cube
	 * looks; those are compared per piece and want no weight invented for them.
	 *
	 * This is the figure to use for anything measured in grams: the per-100
	 * baseline, the pack label, the cooldown. `packSize` may be a piece count.
	 */
	packWeightG: number | null;
	/** Baseline to beat. Exactly one is set depending on unitType. */
	baselinePer100g: number | null;
	baselinePerUnit: number | null;
	/** Monthly consumption: grams (By Gram) or units (By Unit). 0 if not in the active plan. */
	monthlyAmount: number;
	/**
	 * Monthly consumption in grams/ml — `monthlyAmount` for weight-based rows, and
	 * `units × grams-per-unit` for a By-Unit row with a known pack weight. 0 when
	 * it can't be expressed in grams. Use this, never `monthlyAmount`, for sums
	 * that mix with a product's weight (monthly saving, cooldown length).
	 */
	monthlyAmountG: number;
	monthlyPacks: number;
	monthlyCostSgd: number;
	/** Whether this ingredient is used in the active plan (has monthly usage). */
	inActivePlan: boolean;
}

export function titleText(p: any): string {
	return (p?.title ?? []).map((r: any) => r.plain_text).join("").trim();
}
function numberOf(p: any): number | null {
	if (p?.type === "number") return p.number;
	if (p?.type === "formula" && p.formula?.type === "number") return p.formula.number;
	return null;
}
export function selectName(p: any): string {
	return p?.select?.name ?? "";
}
export function multiSelectNames(p: any): string[] {
	return (p?.multi_select ?? []).map((o: any) => o.name).filter(Boolean);
}
function formulaString(p: any): string {
	if (p?.type === "formula" && p.formula?.type === "string") return p.formula.string ?? "";
	return "";
}
function richText(p: any): string {
	return (p?.rich_text ?? []).map((r: any) => r.plain_text).join("").trim();
}
function relationIds(p: any): string[] {
	return (p?.relation ?? []).map((r: any) => r.id).filter(Boolean);
}

/**
 * Look a property up by name, ignoring case and stray spacing. Notion matches
 * keys exactly, and this schema is full of trailing spaces — see
 * `ingredients-schema.ts`. Used only where a rename would silently produce an
 * EMPTY result rather than an error (the plan tag), never where a wrong guess
 * could write to the wrong column.
 */
function propByName(props: Record<string, any>, name: string): any {
	const want = normTag(name);
	for (const [key, value] of Object.entries(props ?? {})) {
		if (normTag(key) === want) return value;
	}
	return undefined;
}

/**
 * Read a tag that may be stored as a select, a formula string, or plain text.
 * `Current Plan` has been two of those three already; which one it is says
 * nothing about what the user meant by it.
 */
function planTagText(p: any): string {
	if (p?.type === "select") return p.select?.name ?? "";
	if (p?.type === "formula") return formulaString(p);
	if (p?.type === "rich_text") return richText(p);
	return "";
}

export async function queryAll(client: Client, dataSourceId: string): Promise<any[]> {
	const out: any[] = [];
	let cursor: string | undefined;
	do {
		const res = (await client.dataSources.query({
			data_source_id: dataSourceId,
			page_size: 100,
			start_cursor: cursor,
		} as any)) as any;
		out.push(...res.results);
		cursor = res.has_more ? res.next_cursor : undefined;
	} while (cursor);
	return out;
}

/** One row wearing the parked tag, as the history page lists it. */
export interface ParkedIngredient {
	ingredientId: string;
	name: string;
	category: string;
	unitType: string;
	packPriceSgd: number | null;
	packSize: number | null;
	vendor: string;
	/** Every tag on the row — the page shows the others so a `Don't Search` is visible. */
	tags: string[];
}

/**
 * Ingredients tagged `Not in Use ATM` — the history page's "Not in use" section.
 *
 * The counterpart to the filter in `readGroceryTargets`, which drops these rows
 * so they are never searched. Dropping them there means they vanish completely:
 * an item you parked in March is simply gone, with no list to find it on and no
 * way back except remembering its name and un-tagging it in Notion by hand. This
 * is that list.
 *
 * Deliberately NOT filtered the way targets are — no price/size requirement, no
 * grocery-category check. A row can only be un-parked from a list it appears on,
 * and an unpriced or oddly-categorised row is exactly the kind that gets parked
 * and then lost.
 *
 * Rows also carrying `Don't Search` are excluded: that tag is permanent and set
 * by hand, nothing here may undo it, and offering a Reset button beside it would
 * promise something this tool must never do.
 */
export async function readParkedIngredients(client: Client): Promise<ParkedIngredient[]> {
	const rows = await queryAll(client, INGREDIENTS_DS);
	const out: ParkedIngredient[] = [];
	for (const row of rows) {
		const p = row.properties;
		const name = titleText(p["Name"]);
		if (!name) continue;

		const tags = multiSelectNames(p[TAGS_PROPERTY]);
		const hasTag = (t: string) => tags.some((x) => normTag(x) === normTag(t));
		if (!hasTag(PARKED_TAG)) continue;
		if (DONT_SEARCH_TAGS.some(hasTag)) continue; // permanent — no Reset button for it

		const baseline = readBaseline(p);

		out.push({
			ingredientId: row.id,
			name,
			category: selectName(p["Catagory"]),
			unitType: selectName(p["Unit type "]),
			packPriceSgd: baseline.priceSgd,
			packSize: baseline.size,
			vendor: baseline.vendor,
			tags,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * **What the user pays for this ingredient, and where** — read off the price book.
 *
 * ⚠️ **This replaced a direct read of three columns on 2026-08-09, and it had to.**
 * The baseline used to be `Price,SGD` + `Weight /Units of New Product ` +
 * `Vendor, Current `. The user has retired all three: the first no longer exists,
 * the other two are renamed `… - Delete? ` and are empty on every row. Left as it
 * was, this reader returned null for the price of every ingredient in the database,
 * `?? 0` turned that into $0, and the `packPriceSgd <= 0` guard below then dropped
 * **every target** — a silent, total failure of the daily scan.
 *
 * The baseline is now the **cheapest vendor slot**: the lowest
 * `Price [Vendor n] / Size[Vendor n] * 1000` among the slots that state both. That
 * is the same rule Notion's own `Price,SGD [Cheapest]`, `Cheapest Price/Kg ` and
 * `Cheapest Vendor ` formulas use, so the page and the database agree by
 * construction rather than by coincidence.
 *
 * Computed from the slots rather than read off those formulas because the scan
 * needs the price, the **size** and the **vendor** together, and reading three
 * separate formulas leaves them free to disagree. `Price,SGD [Cheapest]` is still
 * read as the fallback price for a row that states a price with no size.
 *
 * ⚠️ A `Size of Cheapest Vendor` formula was added by the user on 2026-08-09 and
 * does publish the size — so this could now read all three. It deliberately does
 * not, for the reason above. Verified equivalent on **95 of 95 live rows** that
 * day; re-check if either formula is edited.
 */
function readBaseline(p: Record<string, any>): {
	priceSgd: number | null;
	size: number | null;
	vendor: string;
	/**
	 * `Item Name [Vendor n]` for the slot the price came from — what THAT shop
	 * calls this product. Read because it is the second place a counted row's pack
	 * weight can be written; see `packWeightG` in `readGroceryTargets`.
	 */
	itemName: string;
} {
	// Resolved from the ROW rather than from a retrieved schema: a page's
	// `properties` carry the same names and `type`s, which is all the resolver
	// needs, and it saves this reader an extra API call per run.
	const slots = readVendorSlots(p, resolveVendorSlotProps(p as any));
	const cheapest = cheapestVendorSlot(slots);
	if (cheapest) {
		return {
			priceSgd: cheapest.slot.priceValue,
			size: cheapest.slot.sizeValue,
			// The tag can be blank on a slot that still holds a price — the formulas
			// ignore the tag too, and a price with no shop attached is worth more than
			// no price at all.
			vendor: cheapest.slot.vendorName,
			itemName: cheapest.slot.itemNameValue,
		};
	}
	// No slot states both halves. Notion's own formula may still have a price (it
	// reads the same slots, so in practice this means "price but no size"), and a
	// priced, sizeless row is exactly what the caller's guard is there to drop.
	return {
		priceSgd: numberOf(propByName(p, "Price,SGD [Cheapest]")),
		size: null,
		vendor: "",
		itemName: "",
	};
}

/** How much of one ingredient the Main-tagged meals get through. */
export interface PlanUsage {
	/** Sum of `Amount Used ` across the plan's lines that name this ingredient. */
	dailyAmount: number;
	/** `dailyAmount × PLAN_DAYS_PER_MONTH`. */
	monthlyAmount: number;
}

/**
 * The plan, read from the meals you tagged `Main`: ingredient id → usage.
 *
 * Meal prep is two levels — a parent row per meal ("1 BreakFast - Oat Meal"),
 * and under it one sub-item line per ingredient carrying `Amount Used `. The tag
 * sits on the PARENT, so the plan is every line under every Main-tagged meal.
 * An ingredient used in two meals gets both lines summed, which is why this
 * returns a map built by addition rather than a lookup.
 *
 * Lines with no `Amount Used ` count as 0 — in the plan, quantity unstated.
 * They stay in the map deliberately: they're food you're buying, so they belong
 * in the plan section of the page even though nothing can be said about how much
 * you get through (2 such lines on 2026-08-04).
 *
 * An empty map means nothing is tagged `Main` at all — see `readGroceryTargets`,
 * which treats that as "tag missing", not "plan empty".
 */
export async function readMainPlanUsage(client: Client): Promise<Map<string, PlanUsage>> {
	const rows = await queryAll(client, MEAL_PREP_DS);
	const byId = new Map<string, any>(rows.map((r) => [r.id, r]));

	// The tagged meals' lines. A Set because two Main meals could name the same
	// line, and a line must not be counted twice.
	const lineIds = new Set<string>();
	for (const row of rows) {
		const tag = planTagText(propByName(row.properties, CURRENT_PLAN_PROP));
		if (normTag(tag) !== normTag(MAIN_VALUE)) continue;
		for (const id of relationIds(propByName(row.properties, SUB_ITEM_PROP))) lineIds.add(id);
	}

	const usage = new Map<string, PlanUsage>();
	for (const id of lineIds) {
		const line = byId.get(id);
		if (!line) continue; // sub-item outside this data source
		const amount = numberOf(propByName(line.properties, LINE_AMOUNT_PROP)) ?? 0;
		for (const ingredientId of relationIds(propByName(line.properties, LINE_INGREDIENTS_PROP))) {
			const prev = usage.get(ingredientId)?.dailyAmount ?? 0;
			const dailyAmount = prev + amount;
			usage.set(ingredientId, {
				dailyAmount,
				monthlyAmount: dailyAmount * PLAN_DAYS_PER_MONTH,
			});
		}
	}
	return usage;
}

/**
 * All grocery ingredients with a comparable baseline — the whole inventory, not
 * just the active plan. Each is flagged `inActivePlan` and carries monthly usage
 * (0 when not in the plan). Callers split plan vs. other for the two page sections.
 */
export async function readGroceryTargets(): Promise<PlanTarget[]> {
	const client = new Client({ auth: config.notionToken() });

	const [ingredients, mainUsage] = await Promise.all([
		queryAll(client, INGREDIENTS_DS),
		readMainPlanUsage(client),
	]);

	// No tag, no plan. Nothing tagged `Main` means an empty plan section — the
	// scan still runs and every item lands under "other items on offer". There is
	// deliberately no second source to fall back on: the tag IS the plan, and a
	// fallback would keep publishing a stale plan while the page looked fine.
	if (mainUsage.size === 0) {
		console.error(
			`No Meal prep meal is tagged '${MAIN_VALUE}' in '${CURRENT_PLAN_PROP}' — plan section will be empty.`,
		);
	}

	const targets: PlanTarget[] = [];
	for (const row of ingredients) {
		const p = row.properties;
		const name = titleText(p["Name"]);
		if (!name) continue;

		const category = selectName(p["Catagory"]);
		if (NON_GROCERY_CATEGORIES.has(category)) continue; // groceries only

		// ⚠️ `Unit type ` now says what `Size[Vendor n]` counts (g, ml or pieces).
		// It used to qualify `Weight /Units of New Product `, which is on its way out;
		// the values and their meaning are unchanged, only the column they describe.
		const unitType = (selectName(p["Unit type "]) as UnitType) || "By Gram";
		const baseline = readBaseline(p);
		const packPriceSgd = baseline.priceSgd ?? 0;
		const packSize = baseline.size ?? 0;
		if (packPriceSgd <= 0 || packSize <= 0) continue; // no comparable baseline

		const search = parseName(name);

		// What the pack WEIGHS, as opposed to how many of it there are. A By-Unit row
		// counts pieces, so its weight has to be written down somewhere in words —
		// "(600g)" on a 20-slice loaf.
		//
		// TWO places state it, and the row's own `Name` is only the first (rule from
		// the user, 2026-08-11). The second is `Item Name [Vendor n]` — what the shop
		// calls the pack — which usually carries the weight whether or not the user
		// has repeated it in the title: "Fresh Eggs (10s) 550g".
		//
		// ⚠️ **Only the CHEAPEST slot's item name is read, never any other slot's.**
		// This weight is about to divide that slot's price (`baselinePer100g` below),
		// and the slots describe different packs at different shops — borrowing
		// Guardian's 550 g to divide FairPrice's price invents a per-100g figure that
		// is no shop's. Silent, plausible, and wrong in whichever direction the packs
		// happen to differ.
		//
		// ⚠️ **Null here is a legitimate answer, not a gap to fill.** A row that
		// states no weight in either place is sold by the PIECE only — razor
		// cartridges, tissue rolls, stock cubes — and is compared per piece, which is
		// the right comparison for them. Don't "fix" these by guessing a weight.
		const packWeightG = packWeightOf(unitType, packSize, name, baseline.itemName);

		// **Computed here rather than read from Notion's `Price per 100g `**, and it
		// stays that way even though that formula works again.
		//
		// It briefly did not: it was built on the retired baseline columns and read 0
		// on every row on 2026-08-09, which would have priced every weight-based
		// ingredient at nothing and made every deal on the page look like a loss. The
		// user repaired it the same day with a new `Size of Cheapest Vendor` formula,
		// which `price per g/unit [SGD]` now divides by.
		//
		// Two reasons this still doesn't read it. First, the By-Unit quirk it always
		// had: it counts per 100 UNITS there (a $2.40 loaf of 20 slices reads 12, i.e.
		// per 100 slices), so those rows have always needed the weight from the name —
		// "(600g)" on the loaf — which `packWeightG` is. Second, the scan needs the
		// price, the size AND the vendor from the SAME slot, and three separate
		// formulas can only agree by luck. One expression over one slot serves both
		// cases and cannot disagree with itself.
		//
		// Checked against the live database on 2026-08-09: the cheapest slot this
		// reader picks matches `Price,SGD [Cheapest]` and `Size of Cheapest Vendor` on
		// **95 of 95 rows**. Re-run that check if either formula is edited.
		const baselinePer100g = packWeightG ? (packPriceSgd / packWeightG) * 100 : null;
		const baselinePerUnit = unitType === "By Unit" ? packPriceSgd / packSize : null;

		// By-ml rows render the monthly line without a unit, so the row's own
		// `Unit type ` supplies it (see parseMonthlyUsage).
		const impliedUnit = unitType === "By Unit" ? "x" : unitType === "By ml" ? "ml" : "g";

		// Monthly usage — null when the ingredient is in no Main-tagged meal.
		// Packs and cost are computed from the pack this row describes rather than
		// read off Notion's `Used 'N' Plan` formula: the same numbers, minus that
		// formula's display rounding (it shows packs to 1 dp, so 0.36 packs of
		// rice printed as "0.4Pk").
		const main = mainUsage.get(row.id);
		const usage = main
			? {
					amount: main.monthlyAmount,
					unit: impliedUnit,
					packs: main.monthlyAmount / packSize,
					costSgd: (main.monthlyAmount / packSize) * packPriceSgd,
				}
			: null;

		// Usage in grams: a By-Unit row's plan figure is a piece count, so it's
		// converted at the pack's own grams-per-piece (600g ÷ 20 slices = 30g each).
		// Without this, "40 slices a month" would be read as 40 GRAMS a month by the
		// monthly-saving and cooldown sums — one loaf would buy a year of silence.
		const monthlyAmount = usage?.amount ?? 0;
		const monthlyAmountG = isByWeight(unitType)
			? monthlyAmount
			: packWeightG && packSize > 0
				? monthlyAmount * (packWeightG / packSize)
				: 0;
		const tags = multiSelectNames(p[TAGS_PROPERTY]);
		const hasTag = (name: string) => tags.some((t) => normTag(t) === normTag(name));
		// Out of the scan entirely: "Not in Use ATM" (parked by this tool, undoable)
		// or "Don't Search" (set by hand in Notion, permanent). Dropping them HERE
		// means they never become targets at all — so they are not searched, not
		// compared, and never appear on the page in any section.
		if (hasTag(PARKED_TAG) || DONT_SEARCH_TAGS.some(hasTag)) continue;

		targets.push({
			ingredientId: row.id,
			name,
			search,
			category,
			unitType,
			tags,
			brandSpecific: hasTag("brand specific"),
			qualityItem: hasTag("quality item"),
			organicWelfare: hasTag("organic/animal welfare"),
			weeklyBuy: hasTag("weekly buy"),
			packPriceSgd,
			packSize,
			packWeightG,
			baselinePer100g,
			baselinePerUnit,
			monthlyAmount,
			monthlyAmountG,
			monthlyPacks: usage?.packs ?? 0,
			monthlyCostSgd: usage?.costSgd ?? 0,
			inActivePlan: !!usage,
		});
	}
	return targets;
}
