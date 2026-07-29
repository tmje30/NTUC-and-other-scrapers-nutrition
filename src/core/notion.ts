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
const INGREDIENTS_DS = "34b69a18-4fe7-80e6-904e-000b208cf560";

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
	/** Whole-pack price (SGD) and pack size (grams for By Gram, count for By Unit). */
	packPriceSgd: number;
	packSize: number;
	/** Baseline to beat. Exactly one is set depending on unitType. */
	baselinePer100g: number | null;
	baselinePerUnit: number | null;
	/** Monthly consumption: grams (By Gram) or units (By Unit). 0 if not in the active plan. */
	monthlyAmount: number;
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

		const per100 = numberOf(p["Price per 100g "]);
		const baselinePer100g = isByWeight(unitType) ? per100 : null;
		const baselinePerUnit = unitType === "By Unit" ? packPriceSgd / packSize : null;

		// Monthly usage from the Used 'N' Plan formula — null when not in the plan.
		const usage = parseMonthlyUsage(formulaString(p[planKey]));

		targets.push({
			ingredientId: row.id,
			name,
			search: parseName(name),
			category,
			unitType,
			packPriceSgd,
			packSize,
			baselinePer100g,
			baselinePerUnit,
			monthlyAmount: usage?.amount ?? 0,
			monthlyPacks: usage?.packs ?? 0,
			monthlyCostSgd: usage?.costSgd ?? 0,
			inActivePlan: !!usage,
		});
	}
	return targets;
}
