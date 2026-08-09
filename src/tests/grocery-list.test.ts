import { groceryRowTitle, resolveListProps, vendorLabel } from "../core/grocery-list.js";
import { check, describe, eq } from "./harness.js";

/**
 * The grocery-list row: what goes in the Name, and where the shop goes.
 *
 * ⚠️ Since 2026-08-06 the title is the ingredient name alone and the shop lives
 * ONLY in the list's `Vendor ` column — the `[NTUC] ` prefix that used to carry it
 * as well is gone. That makes `resolveListProps` load-bearing in a way it wasn't:
 * if it stops finding the vendor column, `addToGroceryList` skips it (by design,
 * so an unknown property can't fail the whole write) and the shop is recorded
 * nowhere at all. A console warning is the only signal, and nobody reads a
 * successful run's log.
 */
describe("grocery list — the row title");

// The shape the user asked for: what you have to find in the shop.
eq(
	"ingredient, brand, size",
	groceryRowTitle({ ingredient: "Fish Sauce", brand: "Knife Brand", size: "750ml" }),
	"Fish Sauce, Knife Brand, 750ml",
);
check(
	"no vendor bracket survives",
	!groceryRowTitle({ ingredient: "Banana (Fruit)", brand: "Dole", size: "1kg" }).includes("["),
);

// Each segment is independently optional — a missing one must not leave a stray
// comma or an empty tail on the row.
eq("no brand, no gap", groceryRowTitle({ ingredient: "Fish Sauce", size: "750ml" }), "Fish Sauce, 750ml");
eq("no size", groceryRowTitle({ ingredient: "Fish Sauce", brand: "Knife Brand" }), "Fish Sauce, Knife Brand");
eq("neither — the old, shorter title", groceryRowTitle({ ingredient: "Fish Sauce" }), "Fish Sauce");
eq(
	"an empty string counts as missing",
	groceryRowTitle({ ingredient: "Fish Sauce", brand: "  ", size: "" }),
	"Fish Sauce",
);

// ⚠️ Never append the word "brand" — real brands already end in it. Five of the
// 264 in one Sheng Siong scan do (Tiger Brand, Snow Brand, House Brand …), and
// "Snow Brand brand" is how a naive template would read.
check(
	"the brand is verbatim, never suffixed",
	groceryRowTitle({ ingredient: "Milk", brand: "Snow Brand", size: "1L" }) === "Milk, Snow Brand, 1L",
);

// ⚠️ The ingredient's OWN brackets are part of its name and must be left alone —
// stripping "[" wholesale would eat the bracket standard's brand tag.
eq(
	"the ingredient's own brand bracket is untouched",
	groceryRowTitle({ ingredient: "Chicken Breast [Betagro]" }),
	"Chicken Breast [Betagro]",
);

// …and when that bracket already names the shop's brand, it isn't said twice.
eq(
	"a brand the name already states is not repeated",
	groceryRowTitle({ ingredient: "Fish Sauce [Knife]", brand: "Knife", size: "750ml" }),
	"Fish Sauce [Knife], 750ml",
);
eq(
	"the check ignores case",
	groceryRowTitle({ ingredient: "Chicken Breast [BETAGRO]", brand: "Betagro", size: "500g" }),
	"Chicken Breast [BETAGRO], 500g",
);
// A different brand still lands — the guard must not swallow a genuine one.
eq(
	"an unrelated brand is kept",
	groceryRowTitle({ ingredient: "Fish Sauce [Knife]", brand: "Tiparos", size: "750ml" }),
	"Fish Sauce [Knife], Tiparos, 750ml",
);

describe("grocery list — the vendor column");

// The user's Notion says NTUC, not FairPrice, everywhere.
eq("FairPrice files as NTUC", vendorLabel("FairPrice"), "NTUC");
eq("Sheng Siong keeps its name", vendorLabel("Sheng Siong"), "Sheng Siong");
eq("an unmapped shop passes through", vendorLabel("Guardian"), "Guardian");

/**
 * The live schema as introspected on 2026-08-06 — trailing spaces and all. These
 * names drift (the price column became "Price , To Buy " and grew a companion in
 * the space of one morning), which is why nothing here is hardcoded in the writer.
 */
const LIVE = {
	"Price , To Buy ": { type: "number" },
	Checkbox: { type: "checkbox" },
	"Amount ": { type: "number" },
	Price: { type: "formula" },
	"Current Price ": { type: "number" },
	"Vendor ": { type: "rich_text" },
	Name: { type: "title" },
};

const live = resolveListProps(LIVE);
eq("the vendor column is found", live.vendor, "Vendor ");
eq("the title column is found", live.title, "Name");
eq("the buy price wins over the formula", live.price, "Price , To Buy ");
eq("current price is claimed separately", live.currentPrice, "Current Price ");
eq("the done checkbox is found", live.done, "Checkbox");

// ⚠️ `Amount ` became load-bearing on 2026-08-09: Buy writes 1 into it, and a second
// tap on the same outstanding row makes it 2. Two ways this goes quietly wrong, and
// both are covered here — the column not being found (every tap silently writes no
// quantity), and it being mistaken for a price (a tap sets the shopping price to 1).
eq("the amount column is found, trailing space and all", live.amount, "Amount ");
check("and it is not confused with either price", live.amount !== live.price && live.amount !== live.currentPrice);
eq(
	"a list with no Amount column resolves to null, so the write skips it",
	resolveListProps({ Name: { type: "title" }, "Price , To Buy ": { type: "number" } }).amount,
	null,
);
// The column drifted from `Vendor ` to `Vendor %` between 2026-08-06 and 2026-08-09
// without anything breaking — which is the whole case for resolving by keyword.
const { "Vendor ": _v, ...withoutVendorCol } = LIVE;
eq(
	"the vendor column survived being renamed to Vendor %",
	resolveListProps({ ...withoutVendorCol, "Vendor %": { type: "rich_text" } }).vendor,
	"Vendor %",
);

// A rename that keeps the word still resolves — the whole point of matching on a
// keyword and a type rather than an exact string.
const { "Vendor ": _dropped, ...withoutVendor } = LIVE;
eq(
	"a renamed vendor column still resolves",
	resolveListProps({ ...withoutVendor, "Shop / Vendor": { type: "rich_text" } }).vendor,
	"Shop / Vendor",
);

// ⚠️ And the failure that now costs the most: no vendor column at all. This must
// stay visible as a null rather than quietly becoming a string, because that null
// is what the writer's warning is keyed on.
const noVendor = resolveListProps({ Name: { type: "title" }, Checkbox: { type: "checkbox" } });
eq("a missing vendor column resolves to null", noVendor.vendor, null);
check("but the title still resolves, so the add still works", noVendor.title === "Name");
