import { Client } from "@notionhq/client";
import { config } from "./config.js";
import { parseName, parseMonthlyUsage, type ParsedName } from "./parse.js";

/**
 * Reads the Ingredients data and resolves the "active plan" grocery targets the
 * scraper should search for.
 *
 * Plan membership + monthly usage come straight from the already-computed
 * `Used 'N' Plan` formula string on each ingredient (PRD: parse it, don't
 * recompute). N is set by config (ACTIVE_PLAN_NUMBER, default "1"). An empty
 * `Used 'N' Plan` means the ingredient isn't in plan N.
 *
 * NOTE: the `Current Plan` select the user added to Meal prep is NOT yet wired
 * into these formulas (only 5 rows tagged, no formula reads it), so we don't use
 * it for v1. See LEARNINGS 2026-07-27.
 *
 * Notion SDK v5: query via dataSources.query (see LEARNINGS 2026-07-27).
 */

// Stable data-source id (discovered via introspect; see LEARNINGS).
export const INGREDIENTS_DS = "34b69a18-4fe7-80e6-904e-000b208cf560";

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
	/** Whole-pack price (SGD) and pack size (grams for By Gram, count for By Unit). */
	packPriceSgd: number;
	packSize: number;
	/**
	 * The pack's weight in grams/ml, whatever the row is counted in. Same as
	 * `packSize` for By-Gram and By-ml rows; for a By-Unit row it comes from a size
	 * written into the name — "Bread, Wholemeal (600g)" is bought in 20 slices but
	 * sold by the shop by weight. Null when the row is counted and says no weight.
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

function titleText(p: any): string {
	return (p?.title ?? []).map((r: any) => r.plain_text).join("").trim();
}
function numberOf(p: any): number | null {
	if (p?.type === "number") return p.number;
	if (p?.type === "formula" && p.formula?.type === "number") return p.formula.number;
	return null;
}
function selectName(p: any): string {
	return p?.select?.name ?? "";
}
function multiSelectNames(p: any): string[] {
	return (p?.multi_select ?? []).map((o: any) => o.name).filter(Boolean);
}
function formulaString(p: any): string {
	if (p?.type === "formula" && p.formula?.type === "string") return p.formula.string ?? "";
	return "";
}

async function queryAll(client: Client, dataSourceId: string): Promise<any[]> {
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

/**
 * All grocery ingredients with a comparable baseline — the whole inventory, not
 * just the active plan. Each is flagged `inActivePlan` and carries monthly usage
 * (0 when not in the plan). Callers split plan vs. other for the two page sections.
 */
export async function readGroceryTargets(): Promise<PlanTarget[]> {
	const client = new Client({ auth: config.notionToken() });
	const planKey = `Used '${config.activePlanNumber()}' Plan`;

	const ingredients = await queryAll(client, INGREDIENTS_DS);

	const targets: PlanTarget[] = [];
	for (const row of ingredients) {
		const p = row.properties;
		const name = titleText(p["Name"]);
		if (!name) continue;

		const category = selectName(p["Catagory"]);
		if (NON_GROCERY_CATEGORIES.has(category)) continue; // groceries only

		const unitType = (selectName(p["Unit type "]) as UnitType) || "By Gram";
		const packPriceSgd = numberOf(p["Price,SGD"]) ?? 0;
		const packSize = numberOf(p["Weight /Units of New Product "]) ?? 0;
		if (packPriceSgd <= 0 || packSize <= 0) continue; // no comparable baseline

		const search = parseName(name);

		// What the pack WEIGHS, as opposed to how many of it there are. A By-Unit row
		// counts pieces, so its weight can only come from the name — "(600g)" on a
		// 20-slice loaf. Written by hand for exactly the items the shop prices by
		// weight and not by the piece.
		const packWeightG = isByWeight(unitType) ? packSize : (search.size?.grams ?? null);

		// Notion's "Price per 100g" is per 100 UNITS on a By-Unit row (a $2.40 loaf
		// of 20 slices reads 12, i.e. per 100 slices), so it can't be used as a
		// weight baseline. Where the name gave a weight, the baseline is computed
		// from it instead — which is what lets these rows be compared against
		// weight-priced products at all.
		const per100 = numberOf(p["Price per 100g "]);
		const baselinePer100g = isByWeight(unitType)
			? per100
			: packWeightG
				? (packPriceSgd / packWeightG) * 100
				: null;
		const baselinePerUnit = unitType === "By Unit" ? packPriceSgd / packSize : null;

		// Monthly usage from the Used 'N' Plan formula — null when not in the plan.
		// By-ml rows render the monthly line without a unit, so the row's own
		// `Unit type ` supplies it (see parseMonthlyUsage).
		const impliedUnit = unitType === "By Unit" ? "x" : unitType === "By ml" ? "ml" : "g";
		const usage = parseMonthlyUsage(formulaString(p[planKey]), impliedUnit);

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
