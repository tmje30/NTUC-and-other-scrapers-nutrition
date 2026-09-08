import { check, describe, eq } from "./harness.js";
import { variantTitleSizes } from "../core/stores/myprotein.js";
import { marketplaceSize } from "../core/marketplace-size.js";

/**
 * ⚠️⚠️ **Dropping a variant whose JSON-LD states no weight was biased toward the big
 * pack.** The user buys on price per kilo or litre and a SMALLER pack is perfectly
 * acceptable — the size ceiling exists to stop packs being too big, never too small.
 *
 * Measured 2026-09-08 on `essential-whey-protein`: ten in-stock variants, three carrying
 * a `weight` field (the 2.25 kg tubs) and seven named only "Essential Whey Protein
 * Unflavoured". The shop publishes their sizes — in its own variant list, not in the
 * JSON-LD — so reading only the JSON-LD meant this shop could offer nothing but bulk.
 * The live page after the fix returns 8 products at $155.11, $172.00 and $210.67 per kg,
 * each matching the per-kg line the page itself prints.
 */
describe("MyProtein publishes some sizes only in its variant list");

/** A trimmed copy of the real blob: the title carries the size, the image id is the sku. */
const blob =
	'{"title":"Essential Whey Protein - 375G - 15servings - Unflavoured","images":[{"original":"https://static.thcdn.com/productimg/original/17784498-118.jpg","altText":null}]},' +
	'{"title":"Essential Whey Protein - 2.25kg - 90servings - Vanilla","images":[{"original":"https://static.thcdn.com/productimg/original/17784515-991.jpg","altText":null}]}';

const sizes = variantTitleSizes("<html><body>" + blob + "</body></html>");
eq("both variants are picked up", sizes.size, 2);
eq(
	"the sku keys the title the page shows",
	sizes.get("17784498"),
	"Essential Whey Protein - 375G - 15servings - Unflavoured",
);

// The whole point: a size the JSON-LD does not carry is still a PUBLISHED size.
const small = marketplaceSize(sizes.get("17784498") ?? "");
check("…and it resolves to a real pack size", small.ok && small.grams === 375);
const big = marketplaceSize(sizes.get("17784515") ?? "");
check("…for the bulk tub too", big.ok && big.grams === 2250);

// ⚠️ The real page is pretty-printed, so newlines and indentation sit between the title
// and its image. Folding whitespace is what makes the join hold.
const spaced = variantTitleSizes(
	'{\n  "title":"Whey - 750G - 30servings",\n  "images":[{"original":"https://x/productimg/original/17784516-1.jpg"}]}',
);
eq("whitespace between the fields is folded away", spaced.get("17784516"), "Whey - 750G - 30servings");

// ⚠️ No size in the title is still NO DATA — the module rule that keeps a $138 tub of
// unknown size from being priced against a 2.7 kg one.
const untitled = variantTitleSizes(
	'{"title":"Essential Whey Protein Vanilla","images":[{"original":"https://x/productimg/original/17784503-2.jpg"}]}',
);
check("a title with no size resolves to nothing usable", !marketplaceSize(untitled.get("17784503") ?? "").ok);
