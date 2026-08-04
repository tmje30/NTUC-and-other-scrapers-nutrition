import type { Deal } from "../core/compare.js";
import { renderDealsPage } from "../core/site.js";
import { check, describe, eq } from "./harness.js";

/**
 * The deals page's markup, rendered from the real renderer with fabricated deals.
 *
 * No Notion and no network — the point is the HTML, not the data. What it guards
 * is the set of things that are invisible until someone taps them: the flag the
 * **+ Macros** toggle rewrites, the free-panel figures riding in the payload, and
 * the `has macro` tag agreeing with them.
 *
 * ⚠️ The toggle rewrites `"findMacros":false` in the one-tap JSON **and** the
 * URL-encoded `"findMacros": false` in the two-tap issue body. A string replace can
 * only rewrite a value that is actually present, which is why the flag is always
 * serialised even though it is always false at build time. If either spelling
 * drifts, the toggle silently stops arming one of the two roads — and the one it
 * stops arming is the one nobody notices.
 */
describe("deals page — the card's buttons and payloads");

const PANEL =
	`<table><tr><th>Per Serving (32g)</th><th></th></tr>` +
	`<tr><td>Protein</td><td>7.3g</td></tr><tr><td>Total Fat</td><td>16.5g</td></tr>` +
	`<tr><td>Carbohydrate</td><td>5.4g</td></tr><tr><td>Dietary Fibre</td><td>1.7g</td></tr></table>`;

const target = (over: Record<string, unknown> = {}) =>
	({
		name: "Peanut Butter, Smooth",
		ingredientId: "ing-1",
		packPriceSgd: 8.2,
		packSize: 500,
		packWeightG: 500,
		monthlyAmount: 400,
		monthlyAmountG: 400,
		unitType: "By Gram",
		inActivePlan: true,
		search: { searchTerm: "peanut butter", mustMatch: [], properties: [], keywords: [] },
		...over,
	}) as any;

const product = (over: Record<string, unknown> = {}) =>
	({
		store: "FairPrice",
		name: "Skippy Peanut Butter Spread - Creamy",
		priceSgd: 5.65,
		packWeightG: 500,
		volumetric: false,
		unitCount: null,
		pricePer100g: 1.13,
		dietaryAttributes: [],
		onSale: true,
		listPriceSgd: 6.65,
		saleEndsAt: null,
		url: "https://www.fairprice.com.sg/product/skippy-peanut-butter-creamy-500g-47440",
		nutritionHtml: PANEL,
		...over,
	}) as any;

const deal = (t: unknown, p: unknown, savingPct: number) =>
	({ target: t, product: p, savingPct, baseline: 1.64, productPrice: 1.13, dimension: "weight" }) as unknown as Deal;

const withPanel = deal(target(), product(), 31);
const noPanel = deal(
	target({ name: "Silken Tofu", ingredientId: "ing-2", search: { searchTerm: "tofu", mustMatch: [], properties: [], keywords: [] } }),
	product({ store: "Sheng Siong", name: "Fortune Japanese Silken Tofu", nutritionHtml: null, onSale: false, listPriceSgd: null }),
	12,
);
// Outside the active plan: the usage line is empty, and the tag has to carry that
// row on its own — it used to be rendered only when `inActivePlan`, which silently
// dropped the tag for every "other item on offer".
const offPlan = deal(
	target({ name: "Rolled Oats", ingredientId: "ing-3", inActivePlan: false, search: { searchTerm: "oats", mustMatch: [], properties: [], keywords: [] } }),
	product({ name: "Quaker Oats Instant", nutritionHtml: null, onSale: false, listPriceSgd: null }),
	13,
);

const html = renderDealsPage([withPanel, noPanel, offPlan], [], new Date(), [], {
	repo: "tmje30/NTUC-and-other-scrapers-nutrition",
});

check("the grocery button says Buy", />Buy<\/(a|button)>/.test(html));
check("the rail exists", html.includes('class="rail"'));
check("Add to Ingredients is present", html.includes(">Add</a>"));
check("Replace is present", html.includes(">Replace</a>"));
check("the Macros toggle is present", html.includes("data-macro-toggle"));
check("the toggle script is on the page", html.includes("RAW_OFF"));

check("the one-tap flag is serialised and false", html.includes("&quot;findMacros&quot;:false"));
check("the two-tap flag is present url-encoded", html.includes(encodeURIComponent('"findMacros": false')));

check("a panelled product is tagged has macro", html.includes(">has macro<"));
check("a panel-less product is tagged no macro", html.includes(">no macro<"));
eq("exactly one has-macro tag for the one panelled deal", (html.match(/>has macro</g) ?? []).length, 1);
eq("and two no-macro tags", (html.match(/>no macro</g) ?? []).length, 2);

// The free figures must ride in the payload — that is what makes a `has macro`
// card cost nothing. 7.3 g over a 32 g serving is 22.81 per 100 g.
check("the free panel figures travel in the payload", html.includes("22.81"));

// Both Ingredients actions, and only those, carry the flag.
eq("add-ingredient is routed", (html.match(/add-ingredient/g) ?? []).length >= 3, true);
eq("rebase-ingredient is routed", (html.match(/rebase-ingredient/g) ?? []).length >= 3, true);
check("Replace asks before it fires", html.includes("data-confirm"));

// ⚠️ The grocery button's machinery is still `add` even though its label is Buy.
// Renaming the issue prefix would break the workflow's allowlist silently.
check("the grocery issue prefix is still Add:", html.includes(encodeURIComponent("Add: ")) || html.includes("Add%3A"));
