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

/**
 * The two ignores, and which one is reachable.
 *
 * ⚠️ They traded places on 2026-08-05: the CTA button under Buy was the PERMANENT
 * product block and the ⋯ menu held the weekly snooze; now it is the other way
 * round. Both actions are unchanged — only which control emits which.
 *
 * ⚠️ The weekly one became a DROPDOWN on 2026-08-11 (1/2/3/4 weeks), so the CTA
 * column now holds a `<details>` rather than a link, and one card carries four
 * `ignore-week` payloads instead of one.
 *
 * This is worth a test because getting it backwards is invisible. Both controls say
 * "Ignore", both settle on "✓ ignored", and the difference only shows up days later
 * as a product that never comes back. The pairing that must hold is:
 *
 *   reachable (CTA column)       →  ignore-week    →  reversible, undoable
 *   behind the ⋯ menu (two taps) →  ignore-product →  no undo, confirms
 *
 * ⚠️ Both are RED (asked for 2026-08-05), so colour no longer tells them apart —
 * the label, the action and the confirm dialog do. That makes these cases more
 * load-bearing than they were, not less.
 */
describe("deals page — the two ignores");

// The CTA column's lower control: a disclosure whose summary is painted as the red
// button it replaced. `weeks` is what moves its panel to the left edge.
check("the CTA holds the weeks dropdown", html.includes('<details class="menu weeks"'));
check("its summary is the red button", /<summary class="act week ignore"/.test(html));
check("it emits ignore-week", html.includes("&quot;action&quot;:&quot;ignore-week&quot;"));

// Every duration the user asked for, and no others — a menu missing "4 weeks" is a
// menu that silently caps the snooze a month short.
for (const label of [">1 week<", ">2 weeks<", ">3 weeks<", ">4 weeks<"]) {
	check(`the dropdown offers ${label.slice(1, -1)}`, html.includes(label));
}
check("and no fifth week", !html.includes(">5 weeks<"));

// ⚠️ The duration has to be IN the payload. Four buttons that all send the same
// JSON is the failure this catches, and on the page it is invisible: every one of
// them would say "✓ 3 weeks" and snooze the item for one.
for (const n of [1, 2, 3, 4]) {
	check(`${n} week(s) travels in the payload`, html.includes(`&quot;weeks&quot;:${n}`));
}

// The menu entry. Red too, and it must keep the dialog — it is the only control on
// the page with no undo.
check("the menu holds the permanent one", html.includes(">Ignore for good<"));
check("the menu entry emits ignore-product", html.includes("&quot;action&quot;:&quot;ignore-product&quot;"));
check("the permanent one is still red", /class="act ignore"/.test(html));

// ⚠️ No week option may pick up the confirm dialog just because it shares a class
// with the permanent one. Colour is shared; behaviour is not.
const weekTags = html.match(/<a class="act ignore"[^>]*&quot;weeks&quot;[^>]*>/g) ?? [];
eq("all four week options are rendered", weekTags.length, 4 * 3); // four options × three cards
check("no week option confirms", weekTags.every((t) => !t.includes("data-confirm")));

// ⚠️ The confirm has to travel WITH the permanent action, not stay on the button
// that used to hold it. A permanent block that fires without asking is the exact
// failure this guards.
const ignoreTag = html.match(/<a class="act ignore"[^>]*data-confirm[^>]*>/)?.[0] ?? "";
check("the permanent one still confirms first", ignoreTag.includes("data-confirm"));
check("its confirm still says 'for good'", ignoreTag.includes("for good"));

// The issue title names the PRODUCT for the permanent block and the INGREDIENT for
// the weekly one — they are different scopes and the title is how you tell after
// the fact.
check(
	"the permanent issue names the product",
	html.includes(encodeURIComponent("Item: Ignore for good — Skippy Peanut Butter Spread")),
);
check(
	"a week issue names the ingredient and the duration",
	html.includes(encodeURIComponent("Item: 2 weeks — Peanut Butter, Smooth")),
);

// Neither may have gone missing in the move: four week options per card, one
// permanent block per card.
eq(
	"every card has both",
	(html.match(/ignore-week/g) ?? []).length,
	(html.match(/ignore-product/g) ?? []).length * 4,
);

/**
 * An accepted ignore takes the card off the page (asked for 2026-08-11).
 *
 * ⚠️ **The page can only do that if each card says what it IS**, and the two
 * ignores mean different things: the weekly one silences an INGREDIENT, the
 * permanent one retires a PRODUCT. `data-key` / `data-url` are what let one tap
 * clear every card the decision covers — the same ingredient can hold a deal card
 * and a "close match" card, and one product can be the match for two ingredients.
 */
describe("deals page — an accepted ignore clears the card");

check("cards carry the ingredient key", /<div class="card" data-key="peanut butter"/.test(html));
check("cards carry the product url", html.includes('data-url="https://www.fairprice.com.sg/product/skippy'));
check("the weekly options clear by ingredient", html.includes('data-hide-card="key"'));
check("the permanent one clears by product", html.includes('data-hide-card="url"'));
// ⚠️ Only the ignores. Buy, Add, Replace and the two corrections all leave the card
// where it is — a card that vanished on "Mismatch item" would take the product's
// price off the screen while the user was still deciding whether to buy it.
// The attribute, not the word — the dispatch script names it in a comment too.
eq("nothing else hides a card", (html.match(/data-hide-card="/g) ?? []).length, (4 + 1) * 3);
// The count in the header is rewritten as cards leave, so it needs a handle.
check("the deal count is addressable", html.includes('id="dealcount"'));

/**
 * Pack shots have to reach the payload, or the + Macros toggle buys the expensive
 * lookup instead of the cheap one.
 *
 * This is a regression guard on a gap that existed and was missed: the deals page
 * carried no images at all until 2026-08-04, so every armed lookup was text-only
 * (~$0.29) even for FairPrice products whose back-of-pack shot was sitting in the
 * search payload the whole time.
 */
describe("deals page — pack shots reach the payload");

const M = "https://media.nedigital.sg/fairprice/fpol/media/images/product/XL";
const withImages = renderDealsPage(
	[
		deal(
			target({ name: "Instant Oats", search: { searchTerm: "oats", mustMatch: [], properties: [], keywords: [] } }),
			product({
				name: "Quaker Oats Instant Oatmeal",
				nutritionHtml: null,
				images: [`${M}/47440_XL1_20260327.jpg`, `${M}/47440_BXL1_20250411.jpg`, `${M}/11838626_LXL1_2024.jpg`],
			}),
			20,
		),
	],
	[],
	new Date(),
	[],
	{ repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
);

check("the back shot is in the payload", withImages.includes("47440_BXL1_20250411.jpg"));
check("the side shot is too", withImages.includes("11838626_LXL1_2024.jpg"));
// ⚠️ The front must never be there. It is the marketing face, and sending it is
// what produced the bogus 24.8 g protein reading on frozen chicken.
check("the FRONT shot is not", !withImages.includes("47440_XL1_20260327.jpg"));

// A commodity food is refused photographs entirely, even when the shop published them.
const commodityPage = renderDealsPage(
	[
		deal(
			target({ name: "Chicken Breast", search: { searchTerm: "chicken breast", mustMatch: [], properties: [], keywords: [] } }),
			product({
				name: "Kee Song Fresh Chicken - Boneless Breast",
				nutritionHtml: null,
				images: [`${M}/47440_XL1_20260327.jpg`, `${M}/47440_BXL1_20250411.jpg`],
			}),
			18,
		),
	],
	[],
	new Date(),
	[],
	{ repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
);
check("a fresh commodity ships no photographs", !commodityPage.includes("_BXL1_"));

/**
 * `Weekly Buy` has to survive the trip from Notion to the workflow.
 *
 * The tag is read in `readGroceryTargets`, put into the payload at page-build time
 * by `addPayload`, and only read again days later when someone taps Buy and
 * `planCooldown` runs in Actions. Nothing in between would fail if the field were
 * dropped — the add still works, the row still lands, and the only symptom is a
 * banana that goes quiet for six weeks. So the wiring is pinned here.
 */
describe("deals page — Weekly Buy reaches the payload");

const weeklyPage = renderDealsPage(
	[
		deal(
			target({
				name: "Banana (Fruit)",
				weeklyBuy: true,
				search: { searchTerm: "banana", mustMatch: [], properties: [], keywords: [] },
			}),
			product({ name: "Fresh Bananas", nutritionHtml: null, onSale: false, listPriceSgd: null }),
			22,
		),
	],
	[],
	new Date(),
	[],
	{ repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
);

check("the flag is in the one-tap JSON", weeklyPage.includes("&quot;weeklyBuy&quot;:true"));
check("and in the two-tap issue body", weeklyPage.includes(encodeURIComponent('"weeklyBuy": true')));

// ⚠️ An untagged item must not carry a truthy flag — every other row on the page
// would otherwise take the 5-day route and the whole cooldown formula would be dead
// code that still typechecks.
check("an untagged item does not claim the flag", !html.includes("&quot;weeklyBuy&quot;:true"));

/**
 * The shopping-list row is assembled at page-build time, not in the workflow, so
 * the brand and pack size have to be IN the payload. Nothing downstream can
 * recover them: `add-to-list` never sees the product, only what the card sent.
 */
describe("deals page — brand and size reach the Buy payload");

const shelf = renderDealsPage(
	[
		deal(
			target({ name: "Fish Sauce", search: { searchTerm: "fish sauce", mustMatch: [], properties: [], keywords: [] } }),
			product({ name: "Fish Sauce", brand: "Knife Brand", packWeightG: 750, volumetric: true, nutritionHtml: null }),
			25,
		),
	],
	[],
	new Date(),
	[],
	{ repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
);

check("the brand rides along", shelf.includes("&quot;brand&quot;:&quot;Knife Brand&quot;"));
check("the size is a shelf label, not grams", shelf.includes("&quot;size&quot;:&quot;750ml&quot;"));

// ⚠️ A counted pack must report its COUNT. `packSizeG` beside it is the grams the
// cooldown needs; "1650g" of eggs is a number no carton prints.
const counted = renderDealsPage(
	[
		deal(
			target({ name: "Eggs", packSize: 10, packWeightG: 550, search: { searchTerm: "eggs", mustMatch: [], properties: [], keywords: [] } }),
			product({ name: "Fresh Eggs", brand: "Seng Choon", packWeightG: null, unitCount: 30, nutritionHtml: null }),
			15,
		),
	],
	[],
	new Date(),
	[],
	{ repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
);
check("a counted pack reads in pieces", counted.includes("&quot;size&quot;:&quot;30 pcs&quot;"));
