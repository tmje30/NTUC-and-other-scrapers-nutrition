import { humanizeProductName, looksLikeSlug } from "../core/human-name.js";
import { fieldsFromPurchase } from "../core/ingredient-write.js";
import { check, describe, eq } from "./harness.js";

/**
 * Repairing a name that arrived as a URL slug.
 *
 * ⚠️ **Both halves of this matter, and the second one more.** Failing to repair a slug
 * gives an ugly row the user can see and fix. Repairing something that was never a
 * slug rewrites a name a shop actually published, in a field nobody re-reads — the
 * quiet kind of wrong. So the "left alone" cases below are the real guard rail, and
 * every one of them is a string that has a hyphen in it on purpose.
 */
describe("human name — a slug turned back into words");

eq(
	"the CeraVe row that started this",
	humanizeProductName("cerave-pm-facial-moisturizing-lotion-52ml-630062.html"),
	"Cerave PM Facial Moisturizing Lotion 52ml",
);

// The whole URL, not just its last segment — the extension reads `location.href` too.
eq(
	"a full URL names its last segment",
	humanizeProductName("https://www.guardian.com.sg/cerave-pm-facial-moisturizing-lotion-52ml-630062.html"),
	"Cerave PM Facial Moisturizing Lotion 52ml",
);
eq(
	"a query string is not part of the name",
	humanizeProductName("sensodyne-toothpaste-fresh-mint-100g-123456.html?utm_source=x"),
	"Sensodyne Toothpaste Fresh Mint 100g",
);

// ⚠️ The size has to survive intact: `marketplaceSize` parses it out of the NAME on
// Guardian and Watsons, so eating "100g" here would leave the price unpriceable per kg.
check("the pack size survives", /\b100g\b/.test(humanizeProductName("sensodyne-toothpaste-100g-99881.html")));
eq("litres are capitalised", humanizeProductName("cerave-moisturising-lotion-1l-556677.html"), "Cerave Moisturising Lotion 1L");
eq("multipacks keep their form", humanizeProductName("sensodyne-mint-2x100g-556678.html"), "Sensodyne Mint 2x100g");

// ⚠️ Five digits, not four. `vitamin-c-1000` is a dose, not a catalogue id.
eq("a long trailing number is a catalogue id", humanizeProductName("fresh-milk-bottle-84920113"), "Fresh Milk Bottle");
eq("a short one is part of the product", humanizeProductName("vitamin-c-tablets-1000"), "Vitamin C Tablets 1000");

describe("human name — what it must NOT touch");

// A real title always has a space in it. That single test is what makes the rest safe.
for (const title of [
	"CeraVe PM Facial Moisturising Lotion 52ML",
	"Sensodyne Toothpaste Fresh Mint 2X100G",
	"[BCRS] Farmhouse Milk - Fresh",
	"Pasar Romaine Lettuce",
	"Seng Choon Carrot Eggs (10s)",
]) {
	eq(`published title untouched: ${title}`, humanizeProductName(title), title);
}

// ⚠️ Hyphenated single-word names are the trap: they look exactly like a two-part
// slug. Three parts is the floor precisely so these survive.
for (const name of ["Coca-Cola", "7-Eleven", "Vitamin-C"]) {
	eq(`a hyphenated name is not a slug: ${name}`, humanizeProductName(name), name);
	check(`…and is not detected as one`, !looksLikeSlug(name));
}

eq("a one-word name is left alone", humanizeProductName("Cabbage"), "Cabbage");
eq("a bare host names no product", humanizeProductName("https://www.guardian.com.sg/"), "https://www.guardian.com.sg/");
eq("blank stays blank", humanizeProductName(""), "");

// A slug of nothing but an id has no words to offer, so the original is kept rather
// than an empty box — same rule as `deriveGenericName`.
eq("digits alone are not a name", humanizeProductName("630062"), "630062");

describe("human name — it reaches the row before anything is derived");

/**
 * The row a Buy would write. ⚠️ The assertion that matters is `categoryKey` and the
 * size: those are computed FROM the name, so a repair applied afterwards would leave
 * a readable row that had still been filed by its URL.
 */
const row = fieldsFromPurchase({
	product: "cerave-pm-facial-moisturizing-lotion-52ml-630062.html",
	store: "Guardian",
	priceSgd: 28.9,
	packSizeG: null,
	volumetric: false,
	url: "https://www.guardian.com.sg/cerave-pm-facial-moisturizing-lotion-52ml-630062.html",
	ingredientName: "Facial Moisturiser",
});

check("Items Exact Name is words, not an address", !/\.html|-/.test(row.exactName ?? ""));
eq("and it is the repaired name", row.exactName, "Cerave PM Facial Moisturizing Lotion 52ml");
eq("the vendor slot records the same string", row.itemName, row.exactName);
check("the title is derived from the repaired name", !/\.html/.test(row.name));
// 52 ml read out of the repaired name — proof the repair ran first.
eq("the size was read from it", row.size, 52);
eq("…as a volume", row.unitType, "By ml");

// The ordinary case, unchanged: a shop that published a title still gets it verbatim.
const plain = fieldsFromPurchase({
	product: "Pasar Romaine Lettuce 200g",
	store: "FairPrice",
	priceSgd: 2.5,
	packSizeG: 200,
	volumetric: false,
	url: "https://www.fairprice.com.sg/product/pasar-romaine-lettuce-13281014",
	ingredientName: "Romaine Lettuce",
});
eq("a real title reaches the row verbatim", plain.exactName, "Pasar Romaine Lettuce 200g");
