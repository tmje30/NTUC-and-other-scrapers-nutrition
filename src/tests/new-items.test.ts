import { scanNewItem, type ShopRoute } from "../core/new-items.js";
import { parseItem } from "../core/list-parse.js";
import type { StoreModule, StoreProduct } from "../core/stores/types.js";
import { check, describe, eq } from "./harness.js";

/**
 * Picking one listing per shop for an item with no recorded price.
 *
 * ⚠️ **The marketplace case is the whole reason this suite exists.** On Carousell
 * the cheapest listing is usually the scam, and there is no baseline here to catch
 * it — a new item has no recorded price, so `vendor-scan.ts`'s reference floor
 * cannot run and the median guard is the only one left. Get the reduction wrong
 * and the page confidently reports a 2 kg tub of whey for $4: nothing errors, the
 * card renders, and the number is simply a lie. The contrast pinned below is that
 * the SAME set of listings reduces differently depending on which kind of shop it
 * came from.
 */
/**
 * ⚠️ **Every `await` in this file happens BEFORE the first `describe()`, and that
 * is not stylistic.** `describe()` sets a module-global in the harness, and a
 * module using top-level await is evaluated *concurrently* with its siblings under
 * ESM — so an await between a `describe()` and its `check()`s lets another suite's
 * async cases land under this file's heading, and vice versa. (That is how
 * `packshots.test.ts`'s two cases end up filed under whichever suite happens to be
 * current — a pre-existing quirk, visible in `npm test` output.) Resolving
 * everything up front and then asserting synchronously makes this file's own
 * labels correct, because a synchronous block cannot be interleaved.
 */

const prod = (store: string, name: string, priceSgd: number, packWeightG: number | null): StoreProduct => ({
	store,
	name,
	priceSgd,
	packWeightG,
	volumetric: false,
	unitCount: null,
	pricePer100g: packWeightG ? (priceSgd / packWeightG) * 100 : null,
	dietaryAttributes: [],
	onSale: false,
	listPriceSgd: null,
	saleEndsAt: null,
	url: `https://example.test/${encodeURIComponent(name)}`,
});

/** A shop that always returns the same listings, whatever the search term. */
const fakeShop = (name: string, products: StoreProduct[]): StoreModule => ({
	name,
	async search() {
		return products;
	},
});

// One field of whey listings: two implausible, three credible.
//   per 100g → 0.20, 0.22, 4.50, 4.80, 5.00  (median 4.50, floor 55% = 2.475)
const FIELD = (store: string) => [
	prod(store, "Whey Protein Isolate 1kg", 2.0, 1000),
	prod(store, "Whey Protein Powder 1kg", 2.2, 1000),
	prod(store, "Whey Protein Isolate Vanilla 1kg", 45.0, 1000),
	prod(store, "Whey Protein Concentrate 1kg", 48.0, 1000),
	prod(store, "Whey Protein Chocolate 1kg", 50.0, 1000),
];

const item = parseItem("whey protein")!;

const shopRoute = (r: ShopRoute) => [r];

// ── every await, up front (see the note above) ──────────────────────────────
const [asShop, asMarket, noSize, noSizeMarket, wrongShop, broken, across] = await Promise.all([
	scanNewItem(item, shopRoute({ module: fakeShop("RealShop", FIELD("RealShop")), marketplace: false })),
	scanNewItem(item, shopRoute({ module: fakeShop("Carousell", FIELD("Carousell")), marketplace: true })),
	scanNewItem(
		item,
		shopRoute({
			module: fakeShop("RealShop", [prod("RealShop", "Whey Protein Tub", 39.9, null)]),
			marketplace: false,
		}),
	),
	scanNewItem(
		item,
		shopRoute({
			module: fakeShop("Carousell", [prod("Carousell", "Whey Protein Tub", 4.0, null)]),
			marketplace: true,
		}),
	),
	scanNewItem(
		item,
		shopRoute({
			module: fakeShop("RealShop", [prod("RealShop", "Dishwasher Tablets 60s", 12.9, 1000)]),
			marketplace: false,
		}),
	),
	scanNewItem(
		item,
		shopRoute({
			module: {
				name: "BrokenShop",
				async search(): Promise<StoreProduct[]> {
					throw new Error("HTTP 503");
				},
			},
			marketplace: false,
		}),
	),
	scanNewItem(item, [
		{ module: fakeShop("Dear", [prod("Dear", "Whey Protein Isolate 1kg", 60, 1000)]), marketplace: false },
		{ module: fakeShop("Cheap", [prod("Cheap", "Whey Protein Isolate 1kg", 40, 1000)]), marketplace: false },
	]),
]);

// ── assertions, all synchronous from here ───────────────────────────────────
describe("new items — picking one listing per shop");

check("an ordinary shop returns one offer", asShop.offers.length === 1);
check("a marketplace returns one offer", asMarket.offers.length === 1);

// An ordinary shop's cheapest listing IS its cheapest listing — no second-guessing.
eq("an ordinary shop takes the minimum", asShop.offers[0]?.priceSgd, 2.0);

// The same field on a marketplace skips the two below 55% of the median.
eq("a marketplace skips the implausible minimum", asMarket.offers[0]?.priceSgd, 45.0);

check("a marketplace offer is labelled as one", asMarket.offers[0]?.marketplace === true);
check("an ordinary shop's offer is not", asShop.offers[0]?.marketplace === undefined);

describe("new items — unpriceable listings");

// A shop with no readable size still gets to answer: the whole-pack price is a
// worse comparison than $/kg but it is a real one.
eq("an ordinary shop falls back to the pack price", noSize.offers[0]?.priceSgd, 39.9);

// A marketplace does NOT: with no size there is nothing to take a median over, so
// the plausibility guard cannot run at all — see `bestFromMarketplace`.
eq("a marketplace drops an unguardable listing", noSizeMarket.offers.length, 0);

describe("new items — no match, no invention");

eq("an unrelated product is not offered as a match", wrongShop.offers.length, 0);
eq("a failing shop yields no offers", broken.offers.length, 0);
check("a failing shop is reported, not swallowed", broken.errors.some((e) => e.store === "BrokenShop"));

describe("new items — several shops side by side");

eq("one offer per shop", across.offers.length, 2);
// Sorted by $/kg so the page can mark the first row as cheapest.
eq("cheapest per kg comes first", across.offers[0]?.store, "Cheap");
eq("the dearer shop is kept, not dropped", across.offers[1]?.store, "Dear");
