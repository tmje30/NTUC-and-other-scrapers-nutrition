import { check, describe, eq } from "./harness.js";
import { dealCapture, pickDealsToRecord, vendorOptionForStore, type DealLike } from "../core/deal-discount.js";
import { ROUTES, sizeFor } from "../core/vendor-scan.js";
import { formatDiscount } from "../core/discount.js";
import type { StoreProduct } from "../core/stores/types.js";

/**
 * The deals page's items and prices, on their way into the discount columns.
 *
 * The failure worth guarding here is the quiet one: a capture that looks fine and names a
 * shop the price book has never heard of, or quotes the pre-promo price as if it were the
 * offer. Either writes a cell that reads perfectly and is wrong, and the grocery page
 * prices a row off it.
 */

describe("the shop's name is not the database's name");

/**
 * ⚠️⚠️ **The whole reason this mapping exists.** The module is called `fairprice`, it
 * reports `store: "FairPrice"`, and the Vendor slots spell that shop **NTUC**. Writing
 * "FairPrice" into `Location (Discount)` would name a shop no Vendor slot matches, so the
 * grocery page's `dealVendor` would never line up with a price and the offer line would
 * lose its link — the failure would be a missing arrow, not an error.
 */
eq("FairPrice is NTUC", vendorOptionForStore("FairPrice"), "NTUC");
eq("…whatever the case and spacing", vendorOptionForStore("  fairprice "), "NTUC");
eq("Sheng Siong is itself", vendorOptionForStore("Sheng Siong"), "Sheng Siong");
eq("a shop with no route is null, not a guess", vendorOptionForStore("Cold Storage"), null);
eq("…and so is an empty name", vendorOptionForStore(""), null);

// ⚠️ Derived from ROUTES, never a second list. A route added there must route here with no
// further edit — this is the assertion that keeps that promise rather than the comment.
check(
	"every route's shop maps back to its own option",
	ROUTES.every((r) => vendorOptionForStore(r.module.name) === r.option),
);

describe("a deal, as the five cells would record it");

const product = (over: Partial<StoreProduct> = {}): StoreProduct =>
	({
		store: "Sheng Siong",
		name: "Peanut Butter - Creamy",
		priceSgd: 5.94,
		packWeightG: 800,
		volumetric: false,
		unitCount: null,
		pricePer100g: 0.74,
		dietaryAttributes: [],
		onSale: true,
		listPriceSgd: null,
		saleEndsAt: null,
		url: "https://shengsiong.com.sg/product/peanut-butter",
		...over,
	}) as StoreProduct;

const deal = (over: Partial<StoreProduct> = {}, target: Partial<DealLike["target"]> = {}): DealLike => ({
	target: { name: "Peanut butter", unitType: "By Gram", ingredientId: "ing-1", ...target },
	product: product(over),
});

/**
 * ⚠️⚠️ **The promo price, not the shelf price.** `atShelfPrice` has already put the pre-promo
 * figure in `priceSgd` and today's in `promoPriceSgd` by the time a deal exists. Taking
 * `priceSgd` here would record $5.94 as the offer on a pack the shop is selling at $5.05 —
 * a discount column quoting a price nobody is charging, on the row that prompted all this.
 */
eq("a flagged promo records what the shop charges today", dealCapture(deal({ promoPriceSgd: 5.05 }))!.promoSgd, 5.05);

/**
 * ⚠️⚠️ **And the fallback is the point, not a convenience.** Six of the eleven items on the
 * 2026-10-06 deals page carried no `promoPriceSgd` — they are simply cheaper somewhere else.
 * The sweep reads only `promoPriceSgd`, which is exactly why those six had nowhere to go.
 * The user asked for every item on the page (2026-10-06), so an unflagged deal records its
 * ordinary price.
 */
eq("an unflagged deal records its ordinary price", dealCapture(deal())!.promoSgd, 5.94);

const cap = dealCapture(deal({ promoPriceSgd: 5.05 }))!;
eq("the shop is the Notion option", cap.vendor, "Sheng Siong");
eq("the item name is the SHOP's, not the row's", cap.itemName, "Peanut Butter - Creamy");
eq("…and the row's name travels separately", cap.rowName, "Peanut butter");
eq("the link is the offer's own page", cap.url, "https://shengsiong.com.sg/product/peanut-butter");
// ⚠️ The same choke point the price book uses, so the rate is computed off the divisor
// `Size[Vendor n]` holds rather than a second opinion about pack size.
eq("size comes from sizeFor", cap.size, sizeFor("By Gram", product()));

// A counted row takes the count, not the weight — a 10-pack of eggs is "10", not "550".
const eggs = dealCapture(
	deal({ store: "FairPrice", name: "Pasar Fresh Eggs - Omega 3", unitCount: 10, packWeightG: 550 }, {
		unitType: "By Unit",
		name: "egg (Omega 3 Enriched)",
	}),
)!;
eq("a counted row records the count", eggs.size, 10);
eq("…and is routed to NTUC", eggs.vendor, "NTUC");

// Nothing priceable, nothing to record. A null price is the one cell the page prices from.
eq("a free product is not a deal", dealCapture(deal({ priceSgd: 0 })), null);
eq("an unroutable shop is skipped", dealCapture(deal({ store: "Cold Storage" })), null);
eq("a row with no id is skipped", dealCapture(deal({}, { ingredientId: "" })), null);

// ⚠️ The capture must survive `formatDiscount` into the shape the columns actually hold:
// a bare figure, and the shop's name with its pack.
const text = formatDiscount(cap);
eq("the price cell is bare — no $, no pack", text.price, "5.05");
check("the item cell carries the pack", text.itemName === "Peanut Butter - Creamy (800g)");
eq("the location cell is the shop", text.location, "Sheng Siong");

describe("one row, one offer");

/**
 * ⚠️ A row can appear in more than one of the page's lists — a plan deal at one shop and a
 * near-miss at another. Asking `recordDiscount` twice for the same five cells works, because
 * `discountBeats` settles it, but it costs two round trips and the log then reports a write
 * that was immediately overruled. Decided here instead.
 */
const cheap = deal({ store: "FairPrice", name: "FairPrice Peanut Butter", priceSgd: 4.2 });
const dear = deal({ priceSgd: 5.94 });
const picked = pickDealsToRecord([[dear], [cheap]]);
eq("one entry per ingredient", picked.size, 1);
eq("…and it is the cheaper one", picked.get("ing-1")!.promoSgd, 4.2);
eq("…from the shop that is actually running it", picked.get("ing-1")!.vendor, "NTUC");

// Order must not decide the winner.
eq("whichever order they arrive in", pickDealsToRecord([[cheap], [dear]]).get("ing-1")!.promoSgd, 4.2);

// Two different rows are two entries, not a contest.
const other = deal({ priceSgd: 9.99 }, { ingredientId: "ing-2", name: "Butter" });
eq("different rows do not compete", pickDealsToRecord([[dear, other]]).size, 2);

// An unroutable or unpriceable deal drops out rather than taking the slot.
eq("a skipped deal leaves the row to the next one", pickDealsToRecord([[deal({ store: "Cold Storage" }), dear]]).size, 1);
