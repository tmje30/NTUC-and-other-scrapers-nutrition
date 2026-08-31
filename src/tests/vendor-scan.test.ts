import {
	ceilingGramsFor,
	findSizeCeilingProp,
	gramsPerUnitFor,
	packWithinCeiling,
	pickCandidate,
	resolveSize,
	unitCountFromWeight,
	needsSizeInName,
	reputationPasses,
	searchTermsFor,
	sizeFor,
	unitKindAgrees,
	withinSizeCeiling,
	renderPriceMoves,
	type PriceMove,
} from "../core/vendor-scan.js";
import { reviewReasons } from "../core/vendor-review.js";
import { parseName } from "../core/parse.js";
import type { PlanTarget, UnitType } from "../core/notion.js";
import type { StoreProduct } from "../core/stores/types.js";
import { check, describe, eq } from "./harness.js";

/**
 * The vendor scan's judgement — what it searches for, what it accepts, and what it
 * refuses to write.
 *
 * ⚠️ This is the first writer in the project with **no human looking at the product**.
 * Every other surface is a button pressed against one visible match. So the two gates
 * here carry the weight that a person's glance carries elsewhere, and both fail silently:
 * a matcher let loose writes a plausible wrong product into a row nobody re-reads, and a
 * marketplace pick taken as the minimum writes the scam.
 */
describe("vendor scan — the search terms");

const targetFrom = (name: string, over: Partial<PlanTarget> = {}): PlanTarget =>
	({
		ingredientId: "id",
		name,
		search: parseName(name),
		category: "",
		unitType: "By Gram" as UnitType,
		tags: [],
		brandSpecific: false,
		qualityItem: false,
		organicWelfare: false,
		weeklyBuy: false,
		packPriceSgd: 0,
		packSize: 0,
		packWeightG: null,
		baselinePer100g: null,
		baselinePerUnit: null,
		monthlyAmount: 0,
		monthlyAmountG: 0,
		monthlyPacks: 0,
		monthlyCostSgd: 0,
		inActivePlan: false,
		...over,
	}) as PlanTarget;

/**
 * ⚠️ The brand is INCLUDED here, unlike in the daily scan. One named shop sells fifty
 * toothpastes, and "Repair & Protect" without "Sensodyne" is not a query. `evaluate()`
 * is still the gate, so widening the QUERY cannot widen what is accepted.
 */
const sensodyne = searchTermsFor(targetFrom("Toothpaste  - Multi Care [Sensodyne]"));
check("the brand leads the search term", sensodyne[0].toLowerCase().startsWith("sensodyne"));

/**
 * ⚠️ The fallback that made the difference between finding an item and not: a shop's
 * search engine treats the trailing variant as more words to satisfy. Measured — Guardian
 * returned NOTHING for "Sensitivity Gum Toothpaste - Original" and 23 products, including
 * the exact item, for the same query without "- Original".
 */
const withVariant = searchTermsFor(targetFrom("Sensitivity & Gum Toothpaste - Original"));
check("a trailing variant clause is retried without it", withVariant.some((t) => !/original/i.test(t)));
check("but the full term is tried FIRST", /original/i.test(withVariant[0]));

/**
 * ⚠️ **`searchTerm` can throw a word away silently.** `parseName("whey, essential
 * [MyProtein]")` yields `searchTerm: "whey"` — the clause after the comma survives in
 * neither `mustMatch` nor `properties` nor `ignored`. Asking MyProtein for "myprotein
 * whey" ranked *Impact Diet Whey* first and never returned **Essential Whey Protein**
 * at all, which is a product they sell. The row's own words have to be tried too.
 */
const essential = searchTermsFor(targetFrom("whey, essential  [MyProtein]"));
check("the dropped word is searched for eventually", essential.some((t) => /essential/i.test(t)));
check("and without the brackets a shop search chokes on", essential.some((t) => /essential/i.test(t) && !/[[\]]/.test(t)));
// ⚠️ A shop's own site search chokes on its own brand name: "whey essential MyProtein"
// returns nothing from MyProtein, "whey essential" returns the product.
check("the brand is dropped from that term", essential.some((t) => /essential/i.test(t) && !/myprotein/i.test(t)));

/**
 * ⚠️⚠️ **A widened term must never drop the only distinguishing word.** `whey [Atlas]`
 * strips to the bare "whey", which on Carousell matched *"optimum nutrition gold standard
 * 100 whey protein 5 lbs"* at $35 — a listing believed counterfeit — and would have been
 * filed as the Atlas price. Caught live before any write.
 */
const atlas = searchTermsFor(targetFrom("whey [Atlas]"));
check("a brand-only row is never searched by the bare noun", !atlas.some((t) => t.trim().toLowerCase() === "whey"));

describe("vendor scan — choosing a candidate");

const product = (over: Partial<StoreProduct> = {}): StoreProduct => ({
	store: "Guardian",
	name: "Sensodyne Sensitive Repair and Protect Toothpaste 100 g",
	priceSgd: 8.65,
	packWeightG: 100,
	volumetric: false,
	unitCount: null,
	pricePer100g: 8.65,
	dietaryAttributes: [],
	onSale: false,
	listPriceSgd: null,
	saleEndsAt: null,
	url: "https://example.test/x",
	...over,
});

const toothpaste = targetFrom("Toothpaste - Repair & Protect [Sensodyne]");

eq("a matching product is chosen", pickCandidate(toothpaste, [product()], { marketplace: false }).ok, true);

// A price with no size is not cheap or dear, it is unknown — and the whole price book
// rests on price-per-size.
eq(
	"a sizeless product is not a candidate",
	pickCandidate(toothpaste, [product({ packWeightG: null, pricePer100g: null })], { marketplace: false }).ok,
	false,
);

// ⚠️ A search HIT is not a match. Searching a shop for one product returns its whole
// aisle, and the matcher is what stops the aisle being written into the row.
eq(
	"an unrelated product from the same shop is refused",
	pickCandidate(toothpaste, [product({ name: "Colgate Total Charcoal Deep Clean 60g", packWeightG: 60, pricePer100g: 6.08 })], {
		marketplace: false,
	}).ok,
	false,
);

/**
 * ⚠️⚠️ **Never take the minimum on a marketplace — the minimum is usually the scam.**
 * Optimum Nutrition Gold Standard 5 lbs was listed at S$37, S$38 and S$110 in one search
 * against ~S$120 retail. A retailer's own catalogue has no such problem, so the two kinds
 * of shop are ranked by different rules and this pins both.
 */
const whey = targetFrom("Whey");
const wheyAt = (price: number, name = "optimum nutrition gold standard 100 whey protein 5 lbs") =>
	product({ store: "Carousell", name, priceSgd: price, packWeightG: 2268, pricePer100g: (price / 2268) * 100 });

const listings = [wheyAt(37), wheyAt(110), wheyAt(115), wheyAt(120)];
const asShop = pickCandidate(whey, listings, { marketplace: false });
const asMarket = pickCandidate(whey, listings, { marketplace: true });
check("a real shop's cheapest wins outright", asShop.ok && asShop.product.priceSgd === 37);
check("but a marketplace rejects the outlier", asMarket.ok && asMarket.product.priceSgd === 110);
check("and says how many it threw out", asMarket.ok && asMarket.rejected.length === 1);

/**
 * ⚠️⚠️ **The second guard, and the one that catches counterfeits the median cannot.**
 *
 * `cheapestPlausible` compares a listing against the OTHER LISTINGS, so a search whose
 * results are mostly fake sets a fake standard of normal and the whole set passes. Real
 * numbers, 2026-08-09: a bare "whey protein" search rejected nothing, while the same 5 lb
 * Gold Standard tub sat at **$35–$47 against an $85–$99 cluster** — 2.3× on an identical
 * SKU, every listing badged New.
 *
 * A price the user already recorded at another shop is immune to that, because it comes
 * from outside the search.
 */
describe("vendor scan — counterfeits, against a price already known");

const known = 3.8; // $/100g — the Shopee price actually recorded on the MyProtein whey row
const fake = wheyAt(35); //   $1.54/100g — 41% of it
const real = wheyAt(85); //   $3.75/100g — 99% of it

const guarded = pickCandidate(whey, [fake, real], { marketplace: true, reference: known });
check("a listing far under a known price is refused", guarded.ok && guarded.product.priceSgd === 85);
check("and is reported as rejected, not silently dropped", guarded.ok && guarded.rejected.length === 1);

// ⚠️ The under-floor listings are HANDED BACK, not discarded — deciding them needs a
// browser (the seller's reputation), which is not a pure function's business.
check("under-floor listings are offered back for the reputation check", guarded.ok && guarded.belowFloor.length === 1);
check("cheapest first, so the rescue tries the best price first", guarded.ok && guarded.belowFloor[0].priceSgd === 35);

// ⚠️ Without the reference the median is computed over the fakes themselves, which is
// exactly how they get through. This pins the weakness the second guard exists to cover.
const unguarded = pickCandidate(whey, [fake, wheyAt(37), wheyAt(38)], { marketplace: true, reference: null });
check("with no known price, a fake-dominated set is NOT caught", unguarded.ok && unguarded.product.priceSgd === 35);

// A genuine marketplace saving must still get through — this catches "too good to be
// real", not "a good deal".
const bargain = pickCandidate(whey, [wheyAt(55)], { marketplace: true, reference: known });
check("a real 35%-off find still passes", bargain.ok && bargain.product.priceSgd === 55);

// Every match refused ⇒ no candidate, with a reason naming the comparison.
const allFake = pickCandidate(whey, [fake, wheyAt(30)], { marketplace: true, reference: known });
check("an entirely under-floor result set yields no straight pick", !allFake.ok);
check("and says why, naming the comparison", !allFake.ok && /under 50% of the \$3\.80/.test(allFake.reason));
// ⚠️ …but they are still handed back, because the seller-reputation rescue is the caller's
// to run. "No straight pick" is not the same as "nothing here".
check("while still offering them for the rescue", allFake.belowFloor.length === 2);

/**
 * The rescue: a price under the floor is a question, and the seller's record answers it.
 * Both thresholds must be met — 4.5★ and 50 reviews, set by the user 2026-08-09.
 */
describe("vendor scan — the seller-reputation rescue");

check("an established seller clears the bar", reputationPasses({ rating: 5.0, reviews: 755 }));
check("exactly at the bar passes", reputationPasses({ rating: 4.5, reviews: 50 }));
check("too few reviews, however good the score", !reputationPasses({ rating: 5.0, reviews: 12 }));
check("plenty of reviews but too low a score", !reputationPasses({ rating: 4.2, reviews: 900 }));

/**
 * ⚠️⚠️ **Unknown is a refusal, never a pass.** The seller block is lazy-rendered and
 * often yields nothing at all — measured, it appeared on roughly one attempt in six. If
 * "could not read it" counted as clearing the bar, the flakiest possible outcome would
 * quietly become the most permissive one, on precisely the listings already flagged as
 * too cheap.
 */
check("an unreadable reputation does NOT rescue", !reputationPasses({ rating: null, reviews: null }));
check("half-read is still a refusal", !reputationPasses({ rating: 5.0, reviews: null }));
check("and the other half too", !reputationPasses({ rating: null, reviews: 900 }));

describe("vendor scan — what may be written at all");

/**
 * ⚠️ A scan must never write `Unit type ` — it is ROW-level and governs what every
 * `Size[Vendor n]` on the row counts. So a candidate measured in a different kind of unit
 * cannot be recorded: filing a weighed pack against a By-Unit row would have its grams
 * read as a piece count by every other vendor slot.
 */
eq("a weighed pack suits a By Gram row", unitKindAgrees("By Gram", product()), true);
eq("a weighed pack is refused by a By Unit row", unitKindAgrees("By Unit", product()), false);
eq(
	"a counted pack suits a By Unit row",
	unitKindAgrees("By Unit", product({ unitCount: 30, packWeightG: null })),
	true,
);
eq("and a counted pack writes its COUNT, not its weight", sizeFor("By Unit", product({ unitCount: 30, packWeightG: 1500 })), 30);
eq("while a weighed row writes grams", sizeFor("By Gram", product({ unitCount: 30, packWeightG: 1500 })), 1500);

/**
 * `Size - Ceiling (g/ml)` — the row's own limit on what the price book will record.
 *
 * Added by the user 2026-08-13 after the scan filed a **1 kg** bag of white pepper as the
 * NTUC price — the honest cheapest per kilo, and not a pack anyone buys pepper in. Sizes
 * at or below the number are fine; anything above is not offered.
 */
describe("vendor scan — the row's size ceiling");

eq("the 1 kg pepper that started this is refused at 100 g", withinSizeCeiling(100, 1000), false);
eq("a 100 g jar of pepper is fine", withinSizeCeiling(100, 100), true);
eq("and so is a smaller one — this is a ceiling, not a target", withinSizeCeiling(100, 50), true);

// ⚠️ INCLUSIVE, and the Milk (Low Fat) row is why: it states 2000 and its recorded NTUC
// pack is exactly 2000 ml. An exclusive test would refuse the price already in the book.
eq("a pack exactly at the ceiling is kept", withinSizeCeiling(2000, 2000), true);

// A row with no ceiling behaves exactly as it did before this column existed.
eq("no ceiling means no opinion", withinSizeCeiling(null, 10_000), true);
eq("and neither does a zero or a blank one", withinSizeCeiling(0, 10_000), true);
// Same rule as everywhere else in this project: an unreadable size is not a verdict.
eq("a sizeless candidate is not refused by the ceiling", withinSizeCeiling(100, null), true);

/**
 * ⚠️ The column is labelled `(g/ml)` but a **By Unit** row states it in the row's own
 * units — the egg row carries 30, meaning thirty eggs, beside a recorded pack of 10. The
 * comparison therefore runs against `sizeFor`, never `packWeightOf`; converting to grams
 * would weigh thirty eggs against a tray and throw out every candidate on the row.
 */
eq(
	"a By Unit row bounds a COUNT: 30 eggs is inside a ceiling of 30",
	withinSizeCeiling(30, sizeFor("By Unit", product({ unitCount: 30, packWeightG: 1500 }))),
	true,
);
eq(
	"…and 60 eggs is not, even though its weight never enters into it",
	withinSizeCeiling(30, sizeFor("By Unit", product({ unitCount: 60, packWeightG: 3000 }))),
	false,
);

/**
 * ⚠️ **A count cannot bound a listing that only states a weight**, and most listings only
 * state a weight. Measured on the 2026-08-13 NTUC pass: `Stock cubes (120g)[Knorr]` and
 * `Bread, Wholemeal, [FairPrice] (600g)` each matched a real product and each was then
 * discarded as "measured by weight, but this row is By Unit" — the ceiling never got a say.
 *
 * So it is converted, by the user's own arithmetic: **ceiling × (pack weight ÷ pack count)**.
 */
eq("the user's worked example: 30 units of a 350 g / 10 pack", ceilingGramsFor("By Unit", 30, 350, 10), 1050);
eq("the live egg row: 30 eggs at 550 g / 10", ceilingGramsFor("By Unit", 30, 550, 10), 1650);

// A weighed row's ceiling is already grams or millilitres — nothing to convert.
eq("a By Gram ceiling passes through untouched", ceilingGramsFor("By Gram", 100, 1000, 1000), 100);
eq("and so does a By ml one", ceilingGramsFor("By ml", 2000, null, null), 2000);

/**
 * ⚠️ **Null rather than a guess whenever either half is missing.** A row whose Name states
 * no weight, or which has no priced slot to count against, gets no weight ceiling — the
 * count ceiling still applies to anything a shop does state a count for. Inventing a
 * grams-per-unit figure would discard good candidates on precisely the rows with the least
 * information to check the result against.
 */
eq("no weight in the row's Name ⇒ no weight ceiling", ceilingGramsFor("By Unit", 30, null, 10), null);
eq("no priced pack to count against ⇒ no weight ceiling", ceilingGramsFor("By Unit", 30, 550, 0), null);
eq("and no ceiling at all ⇒ nothing to convert", ceilingGramsFor("By Unit", null, 550, 10), null);

/** The egg row as the scan actually holds it: ≤ 30 eggs, ≈ 1.65 kg. */
const eggRow = { unitType: "By Gram" as UnitType, sizeCeiling: 30, ceilingGrams: 1650 };
const eggs = { ...eggRow, unitType: "By Unit" as UnitType };

// The count answers on its own wherever a shop states one — no arithmetic needed.
check("a 30-egg tray is inside the count ceiling", packWithinCeiling(eggs, { unitCount: 30, packWeightG: null }));
check("a 60-egg tray is not", !packWithinCeiling(eggs, { unitCount: 60, packWeightG: null }));

// ⚠️ The weight is a FALLBACK, for the case the user raised: the shop lists the pack by
// weight, so "By unit does not work" and the derived ceiling is the only bound there is.
check("a 1.2 kg weighed pack falls back to the derived ceiling", packWithinCeiling(eggs, { unitCount: null, packWeightG: 1200 }));
check("a 3 kg one is refused by it", !packWithinCeiling(eggs, { unitCount: null, packWeightG: 3000 }));

/**
 * ⚠️ **Count first, and never both.** A pack stating a count AND a weight is judged on the
 * count, because the count is what lands in `Size[Vendor n]`. Gating on the derived weight
 * as well would refuse a pack at exactly the stated ceiling whenever the shop's eggs happen
 * to run larger than the row's own — the ceiling would then mean something the user never
 * typed.
 */
check(
	"30 large eggs at 2 kg still pass: the count is the number being recorded",
	packWithinCeiling(eggs, { unitCount: 30, packWeightG: 2000 }),
);

/**
 * ⚠️ The schema is matched on a squashed name, for the reason `CATEGORY_ALIASES` exists:
 * this database renamed `Catagory` → `Category` out from under the code once, nothing
 * errored, and every read silently returned undefined for weeks.
 */
const schema = { "Size - Ceiling (g/ml)": { type: "number" }, "Size[Vendor 1]": { type: "number" } };
eq("the ceiling column is found by its live name", findSizeCeilingProp(schema), "Size - Ceiling (g/ml)");
eq("spacing and bracket drift does not lose it", findSizeCeilingProp({ "Size Ceiling (g)": { type: "number" } }), "Size Ceiling (g)");

/**
 * ⚠️⚠️ **The column's ORIGINAL name still resolves, and this test is the reason it must
 * stay that way.** It was created as `Size - floor (g/ml)` and renamed to `Ceiling` the
 * same day, because "floor" said the opposite of what the number means. Dropping the alias
 * would cost nothing visible — no error, no warning, just a 1 kg bag of pepper quietly
 * back in the price book.
 */
eq("the original 'floor' spelling still resolves", findSizeCeilingProp({ "Size - floor (g/ml)": { type: "number" } }), "Size - floor (g/ml)");
// …and the current spelling wins when a workspace somehow holds both.
eq(
	"the current name wins over the old one",
	findSizeCeilingProp({ "Size - floor (g/ml)": { type: "number" }, "Size - Ceiling (g/ml)": { type: "number" } }),
	"Size - Ceiling (g/ml)",
);

eq("a per-vendor size column is not mistaken for it", findSizeCeilingProp({ "Size[Vendor 1]": { type: "number" } }), null);
eq("nor is a same-named column of the wrong type", findSizeCeilingProp({ "Size - Ceiling (g/ml)": { type: "rich_text" } }), null);

/**
 * ⚠️ A pack inside a ceiling the user typed is not a pack to ask them about. `BULK_GRAMS`
 * is 2 kg — a guess about where "a shop" becomes "a caterer", made with no knowledge of
 * the item. The three whey rows state 10 kg and buy 2.5 kg tubs, so without this they'd
 * clear the filter and be queued for review anyway, every single run.
 */
const tub = product({ name: "Impact Whey Protein 2.5kg", packWeightG: 2500 });
check("a 2.5 kg tub is normally queued as catering size", reviewReasons(tub, { packGrams: 2500 }).some((r) => r.kind === "bulk"));
check(
	"but not on a row whose ceiling already allows it",
	!reviewReasons(tub, { packGrams: 2500, sizeCeilingOk: true }).some((r) => r.kind === "bulk"),
);
// ⚠️ …and the multipack test still runs. "12 × 1 L" is a statement about how the pack is
// SOLD, which a size ceiling has no opinion on — the case of milk stays a question.
check(
	"a multipack is still asked about inside a ceiling",
	reviewReasons(product({ name: "Milk 12 x 1L", packWeightG: 1000 }), { packGrams: 1000, sizeCeilingOk: true }).some(
		(r) => r.kind === "bulk",
	),
);

/**
 * A count for a pack the shop only weighs.
 *
 * ⚠️ The user's point, 2026-08-13: *"there are weights/size in the name which can be used
 * to scrape/discover"*. Refusing the pack throws away a number the row itself supplies the
 * constant for, and it cost two real rows on the NTUC pass — one of them badly. The top hit
 * for `Stock cubes (120g)[Knorr]` was **the identical product at the identical price**
 * ($3.83, 120 g) that the row already records as 12 pcs, discarded for being "measured by
 * weight, but this row is By Unit".
 */
describe("vendor scan — a count derived from a weight");

eq("the Knorr row: 120 g over 12 cubes is 10 g each", gramsPerUnitFor("By Unit", 120, 12), 10);
eq("a weighed row has no units to divide into", gramsPerUnitFor("By Gram", 500, 500), null);
eq("and a row with no stated weight has no constant", gramsPerUnitFor("By Unit", null, 12), null);

// The case that started this: identical pack, identical price, and the arithmetic is 12.000.
const knorr = unitCountFromWeight(10, 120);
check("Knorr's 120 g box comes back as 12 cubes", knorr?.count === 12);
check("…and the division is clean, so the report says nothing extra", knorr?.exact === true);

/**
 * ⚠️ **The bread loaf is the counter-example: a division that does not land clean.**
 * FairPrice lists that wholemeal loaf at 500 g; the row's own Name says 600 g over 20
 * slices, i.e. 30 g each. 500 ÷ 30 = 16.67 — so either the loaf shrank or the slices are
 * thinner.
 *
 * ⚠️ **It is still written.** An earlier design queued this for a Telegram confirmation and
 * the user reversed it (see the note at the foot of this suite); `exact: false` now only
 * makes the console report print `(16.7, rounded)` beside the figure, which is how a wrong
 * grams-per-unit stays visible without costing a notification.
 */
const loaf = unitCountFromWeight(30, 500);
check("the 500 g loaf rounds to 17 slices", loaf?.count === 17);
check("and is flagged inexact — for the report, not as a refusal", loaf?.exact === false);
// ⚠️ A percentage tolerance would have called it certain — it is only 2% off. Hence the
// absolute `DERIVED_COUNT_SLACK`: the question is whether the weight divides cleanly.
check("a 2% miss is still a miss", Math.abs(500 / 30 - 17) > 0.1);

eq("half a loaf is not a pack", unitCountFromWeight(30, 10), null);
eq("no constant, no conversion", unitCountFromWeight(null, 500), null);

/**
 * ⚠️ **A size the shop STATES always wins.** The derivation is only reached when there is
 * nothing to state, so a shop selling eggs by the dozen is recorded as twelve eggs — never
 * as its weight divided by anything.
 */
const eggRowFull = { unitType: "By Unit" as UnitType, gramsPerUnit: 55 };
const stated = resolveSize(eggRowFull, product({ unitCount: 12, packWeightG: 900 }));
check("a stated count is used as-is", stated?.size === 12);
check("and is not marked derived", stated?.derived === false);

const converted = resolveSize(eggRowFull, product({ unitCount: null, packWeightG: 550 }));
check("a weight-only pack is converted", converted?.size === 10);
check("and says so", converted?.derived === true && converted?.exact === true);

/**
 * ⚠️ **The reverse direction still has no answer.** A 4-pack of razor cartridges on a
 * By Gram row needs a weight the listing does not have, and inventing one would misprice
 * the row against every other vendor in its price book. `unitKindAgrees` remains the rule;
 * the conversion only adds the one direction the row supplies a constant for.
 */
eq(
	"a counted pack on a weighed row is still refused",
	resolveSize({ unitType: "By Gram", gramsPerUnit: null }, product({ unitCount: 4, packWeightG: null })),
	null,
);
eq(
	"and a By Unit row with no constant cannot convert either",
	resolveSize({ unitType: "By Unit", gramsPerUnit: null }, product({ unitCount: null, packWeightG: 500 })),
	null,
);

/**
 * ⚠️⚠️ **An inexact count is written, not queued.** The first version asked over Telegram
 * before recording 16.67 → 17, and the user's call (2026-08-13) was that this is the wrong
 * idea of what the number is for:
 *
 *   > it does not need to be exact. this is just a guide line to help guide a search and
 *   > calculate a ceiling weight
 *
 * A `Size[Vendor n]` on a counted row decides roughly what a slice costs and is compared
 * against other slices. Confirming a rounding nobody would act on differently costs a
 * notification, and a queue full of questions that did not need asking stops being read.
 * `exact` survives only to decide how the console report phrases itself.
 */
check(
	"an inexact derived count raises no review question",
	reviewReasons(product(), { packGrams: 500 }).length === 0,
);
check("and neither does an exact one", reviewReasons(product(), { packGrams: 120 }).length === 0);

/**
 * "This row is mislabelled" — the vendor-scan twin of the deals page's eggs nudge.
 *
 * ⚠️ The user's framing, 2026-08-13: *"the razor ex. there will never be weight on some
 * items, since they are only sold as x units. and will be labeled 'By unit' — if it is
 * mislabeled it should be flagged"*. So the test is not "does the row lack a weight" — a
 * genuinely countable row lacks one forever and must never be nagged — but **"did a shop
 * state a weight this row had no constant to meet"**.
 */
describe("vendor scan — flagging a row that needs a size in its name");

const countedRow = { unitType: "By Unit" as UnitType, gramsPerUnit: null };

check(
	"a shop pricing a countable row by weight is flagged",
	needsSizeInName(countedRow, product({ unitCount: null, packWeightG: 600 })),
);

/**
 * ⚠️⚠️ **The razor case, and the whole reason the product's weight is required.** Nobody
 * publishes a weight for a 4-pack of cartridges or a 10-pack of tissue rolls — both rows
 * appeared in the live NTUC pass as "none with both a price and a readable size". If the
 * flag keyed on the ROW alone it would tell the user to go and type a weight that does not
 * exist, every run, forever.
 */
check("but a genuinely countable-only pack is not", !needsSizeInName(countedRow, product({ unitCount: 4, packWeightG: null })));

// Nothing to fix: the row already states a weight, so the conversion works and the pack
// was recorded rather than refused.
check(
	"a row that already has its constant is never flagged",
	!needsSizeInName({ unitType: "By Unit", gramsPerUnit: 30 }, product({ unitCount: null, packWeightG: 600 })),
);
// A weighed row has no units for a name-size to help with — the advice would not work.
check(
	"and a weighed row is not this problem",
	!needsSizeInName({ unitType: "By Gram", gramsPerUnit: null }, product({ unitCount: 4, packWeightG: null })),
);

describe("the price book's morning message — only what MOVED");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const move = (over: Partial<PriceMove> = {}): PriceMove => ({
	row: "whey, essential  [MyProtein]",
	vendor: "Carousell",
	recordedText: "$85.00 / 2500g",
	foundText: "$80.00 / 2500g",
	recordedPer1000: 34,
	foundPer1000: 32,
	perWord: "kg",
	...over,
});

// ⚠️⚠️ **Silence is the default and it is the point.** The sweep runs unattended every
// morning; on most days nothing moved, and a "nothing changed" notification is what
// trains someone to mute the bot — which costs them the deals digest too.
check("nothing moved sends NOTHING", renderPriceMoves([], 14) === null);
check("re-confirmations alone send nothing", renderPriceMoves([], 106) === null);

const cheaper = renderPriceMoves([move()], 2)!;
check("a reduction is reported", /1 price got cheaper/.test(cheaper));
// ⚠️ Price AND size on both sides, not just the per-kilo figure — same reason
// `dearerThanRecorded` quotes both: on a By-Unit row the per-kilo numbers can agree
// while the pack changes underneath them, and "$4.00/kg → $4.00/kg" is unanswerable.
check("it quotes both sides in full", cheaper.includes("$85.00 / 2500g = $34.00/kg"));
check("...and what it became", cheaper.includes("$80.00 / 2500g = $32.00/kg"));
check("re-confirmations are counted, not itemised", /2 others re-confirmed unchanged\./.test(cheaper));

// ⚠️ An empty slot being filled is news too. The 2026-08-11 report found 49 rows tagged
// Sheng Siong with no price between them — closing that gap is what the price book is for.
const first = renderPriceMoves([move({ recordedPer1000: null, recordedText: "" })], 0)!;
check("a first price is reported as new, not as a cut", /1 newly recorded/.test(first));
check("...and does not claim anything got cheaper", !/got cheaper/.test(first));
check("...and quotes it as a first price", first.includes("first price: $80.00 / 2500g = $32.00/kg"));

const both = renderPriceMoves([move(), move({ row: "Vitamin -C", recordedPer1000: null, recordedText: "" })], 3)!;
// Tags stripped: the headline bolds only the reduction, so the two halves are separated
// by `</b>` in the raw string and asserting on the rendered words is the honest test.
check("a mixed morning states both", /1 price got cheaper.*1 newly recorded/.test(both.replace(/<[^>]+>/g, "")));

// ⚠️⚠️ **A live row name contains an ampersand** — "Sensitivity & Gum Toothpaste" is one
// of the five Watsons rows. Unescaped it makes Telegram reject the whole message with
// parse_mode HTML, so the ONLY notification about a silent write would fail to send.
const amp = renderPriceMoves([move({ row: "Sensitivity & Gum Toothpaste - Original" })], 0, esc)!;
check("an ampersand in a row name is escaped", amp.includes("Sensitivity &amp; Gum Toothpaste"));
check("...and the raw ampersand is gone", !/&(?!amp;|lt;|gt;)/.test(amp));
