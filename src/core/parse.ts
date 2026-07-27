/**
 * Deterministic parsers — no LLM. Two jobs:
 *  1. Ingredient Name  → search term + must-match keyword constraints.
 *  2. "Used 'N' Plan" formula string → monthly usage (amount, packs, cost).
 *
 * Formats verified against live Notion data (see LEARNINGS 2026-07-27).
 */

/**
 * Words that, if present in the Name, become a hard constraint a candidate
 * store product must also satisfy. Multi-word entries are matched as phrases.
 * Tune against real store results (PRD: false matches fixed by editing Names).
 */
export const MUST_MATCH_KEYWORDS = [
	"organic",
	"fresh",
	"frozen",
	"enriched",
	"wholegrain",
	"whole grain",
	"wholemeal",
	"whole meal",
	"skinless",
	"skimmed",
	"low fat",
	"low gi",
	"raw",
	"unbreaded",
	"peeled",
	"light",
	"brown",
] as const;

export interface ParsedName {
	/** Cleaned keyword to search the store for. */
	searchTerm: string;
	/** Lower-cased keywords the candidate product must also contain. */
	mustMatch: string[];
	/** The original name, untouched. */
	original: string;
}

export function parseName(raw: string): ParsedName {
	const original = raw;
	const lower = raw.toLowerCase();

	const mustMatch = MUST_MATCH_KEYWORDS.filter((kw) => {
		// whole-word / phrase match
		const re = new RegExp(`(^|[^a-z])${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-z]|$)`, "i");
		return re.test(lower);
	}).map((k) => k.toLowerCase());

	// Strip parenthetical/bracketed qualifiers: "(Seara)", "[california gold]".
	let s = raw.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");

	// Take the part before the first comma as the base noun
	// ("Bread, Wholemeal, Sunshine" → "Bread"; keywords recovered separately).
	s = s.split(",")[0];

	// Collapse whitespace and stray punctuation.
	const searchTerm = s
		.replace(/[^\p{L}\p{N}\s'-]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

	return { searchTerm, mustMatch, original };
}

export type UsageUnit = "g" | "x";

export interface MonthlyUsage {
	/** Monthly quantity in grams (unit "g") or units (unit "x"). */
	amount: number;
	unit: UsageUnit;
	/** Packs per month, as the DB computed it. */
	packs: number;
	/** Monthly cost in SGD, per the DB. */
	costSgd: number;
}

const MONTHLY_RE =
	/([\d.]+)\s*(g|x)\s*\/\s*([\d.]+)\s*Pk\s*\|\s*Monthly[^|]*\|\s*([\d.]+)\s*SGD/i;

/**
 * Parse the monthly line of a "Used 'N' Plan" value. Returns null if the string
 * is empty (ingredient not in this plan) or doesn't match the expected shape.
 */
export function parseMonthlyUsage(usedPlan: string | null | undefined): MonthlyUsage | null {
	if (!usedPlan) return null;
	const m = usedPlan.match(MONTHLY_RE);
	if (!m) return null;
	return {
		amount: Number(m[1]),
		unit: m[2].toLowerCase() as UsageUnit,
		packs: Number(m[3]),
		costSgd: Number(m[4]),
	};
}
