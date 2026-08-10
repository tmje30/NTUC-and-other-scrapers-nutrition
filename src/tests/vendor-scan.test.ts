import { pickCandidate, reputationPasses, searchTermsFor, sizeFor, unitKindAgrees } from "../core/vendor-scan.js";
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
