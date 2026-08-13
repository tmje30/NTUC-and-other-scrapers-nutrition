import { check, describe, eq } from "./harness.js";
import { findWeightGap } from "../core/compare.js";
import { formatWeightGaps, type WeightGapNote } from "../core/telegram.js";
import { parseName } from "../core/parse.js";
import type { PlanTarget } from "../core/notion.js";
import type { StoreProduct } from "../core/stores/types.js";

/**
 * "Found eggs, but only in weight" — the one silent drop the user can fix.
 *
 * The failure this guards is not a crash. It is a *right* product disappearing
 * with no trace: a By-Unit row with no weight in its name cannot be priced against
 * a shop that publishes only a pack weight, so `findDeal` skips it and the day
 * looks like a day with no eggs on offer. Every step behaves correctly and the
 * user is never told the one thing that would fix it.
 *
 * The cases below are mostly about the *opposite* risk, and that is deliberate:
 * advice to go and retype a Notion row is only worth giving when it will actually
 * work. A nudge on a row that already states a weight, or about a product that was
 * never the right product, costs the user a trip to Notion and buys nothing.
 */

describe("weight gap — the item that needs a size in its name");

const eggs = (over: Partial<PlanTarget> = {}): PlanTarget =>
	({
		name: "Eggs",
		ingredientId: "ing-eggs",
		unitType: "By Unit",
		inActivePlan: true,
		packPriceSgd: 3.9,
		packSize: 10,
		// The whole point of this fixture: a counted row with NO weight anywhere, so
		// `packWeightOf` returns null and `baselinePer100g` is never computed.
		packWeightG: null,
		baselinePer100g: null,
		baselinePerUnit: 0.39,
		monthlyAmount: 140,
		monthlyAmountG: 0,
		tags: [],
		vendors: ["Sheng Siong"],
		brandSpecific: false,
		// ⚠️ Built with the real `parseName`, not hand-written. A literal here missed
		// `categories` and `negatedProperties`, and `evaluate` threw on the first call
		// — a fixture that has drifted from the type it claims to be tests nothing.
		search: parseName("Eggs"),
		...over,
	}) as unknown as PlanTarget;

const product = (over: Partial<StoreProduct> = {}): StoreProduct =>
	({
		store: "Sheng Siong",
		name: "Eggs",
		priceSgd: 3.6,
		// Weight only, no count — precisely what the user described finding.
		packWeightG: 600,
		unitCount: null,
		pricePer100g: 0.6,
		volumetric: false,
		dietaryAttributes: [],
		onSale: false,
		listPriceSgd: null,
		saleEndsAt: null,
		url: "https://shengsiong.com.sg/product/eggs",
		...over,
	}) as StoreProduct;

// ── it fires on the case that prompted it ───────────────────────────────────────

const gap = findWeightGap(eggs(), [product()]);

check("a weight-only match on a weightless row is reported", gap != null);
eq("…naming the row the user must edit", gap?.target.name, "Eggs");
eq("…and the shop that priced it", gap?.product.store, "Sheng Siong");
eq("…carrying the shop's pack size as a worked example", gap?.exampleGrams, 600);
check("…in grams, not millilitres", gap?.volumetric === false);

// ── and stays quiet everywhere a nudge would be wrong ───────────────────────────

check(
	"a row that already states a weight is left alone",
	// Nothing to fix by renaming: the row has its per-100g baseline. If this product
	// still cannot be priced, that is the product's doing.
	findWeightGap(eggs({ packWeightG: 600, baselinePer100g: 0.65 } as Partial<PlanTarget>), [product()]) === null,
);

check(
	"a shop that gives a count needs no advice",
	// Priceable per piece already — the ordinary, working path for eggs.
	findWeightGap(eggs(), [product({ unitCount: 10 })]) === null,
);

check(
	"a pack with neither weight nor count is not the user's to fix",
	// No `pricePer100g`, so a weight in the name would change nothing.
	findWeightGap(eggs(), [product({ packWeightG: null, pricePer100g: null })]) === null,
);

check(
	"a product that isn't the right product earns no nudge",
	// Review band at best. Sending someone to edit Notion on the strength of a maybe
	// costs them the trip and leaves the match still failing.
	findWeightGap(eggs(), [product({ name: "Egg Noodles" })]) === null,
);

// ── which candidate gets named ──────────────────────────────────────────────────

eq(
	"the cheapest per 100 is the one shown",
	findWeightGap(eggs(), [
		product({ name: "Eggs", pricePer100g: 0.9, packWeightG: 400 }),
		product({ name: "Eggs", pricePer100g: 0.45, packWeightG: 800 }),
	])?.exampleGrams,
	800,
);

// ── the message ─────────────────────────────────────────────────────────────────

const note = (over: Partial<WeightGapNote> = {}): WeightGapNote => ({
	name: "Eggs",
	store: "Sheng Siong",
	size: 600,
	volumetric: false,
	...over,
});

const oneGap = formatWeightGaps([note()]);

check("the message says which item", oneGap.includes("<b>Eggs</b>"));
check("…and what to do about it", /Add one to the name/.test(oneGap));
check("…showing the bracket format packWeightOf actually reads", oneGap.includes("Eggs (600g)"));
check(
	"…as an example, never as an instruction to enter that number",
	// The shop's pack is not necessarily the user's, and the row's name is shared by
	// all four vendor slots. "e.g." is what keeps this honest.
	oneGap.includes("e.g."),
);

check(
	"a millilitre pack is not described as a weight",
	formatWeightGaps([note({ name: "Milk", size: 2000, volumetric: true })]).includes("Milk (2000ml)"),
);

check(
	"a shop that stated no size still gets a line",
	// Worth telling even without an example — the row is still the thing to fix.
	formatWeightGaps([note({ size: null })]).includes("<b>Eggs</b>"),
);

check("no gaps means not a single character added", formatWeightGaps([]) === "");

const many = formatWeightGaps([
	note({ name: "Eggs" }),
	note({ name: "Bread" }),
	note({ name: "Milk" }),
	note({ name: "Butter" }),
	note({ name: "Yoghurt" }),
]);
check("a long list is capped so the message stays readable", !many.includes("Yoghurt"));
eq("…and says how many were left out", /and (\d+) more items? need one too/.exec(many)?.[1], "2");

check(
	"a name with markup in it is escaped, not rendered",
	// Notion row names are free text and this message is parse_mode=HTML.
	formatWeightGaps([note({ name: "Eggs <b>big</b>" })]).includes("&lt;b&gt;big&lt;/b&gt;"),
);

// ── the advice has to actually work ─────────────────────────────────────────────

/**
 * ⚠️ **The whole feature rests on this and nothing else checks it.** The message
 * tells the user to append `(600g)` to a name that may already carry a property in
 * brackets — `Milk (Low Fat)` becomes `Milk (Low Fat) (2000ml)`. If `parseName`
 * read only the first bracket group, that advice would be confidently wrong: the
 * user would edit Notion, no size would appear, the item would keep vanishing, and
 * the message would keep telling them to do the thing they had already done.
 */
const appended = parseName("Milk (Low Fat) (2000ml)");
eq("a size appended after an existing property is read", appended.size?.grams, 2000);
check("…as a volume", appended.size?.volumetric === true);
eq("…without eating the property", appended.properties, ["low fat"]);
eq("…or changing what gets searched for", appended.searchTerm, "Milk");
eq("order does not matter either", parseName("Milk (2000ml) (Low Fat)").size?.grams, 2000);
