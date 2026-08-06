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

eq("the title is the ingredient, nothing else", groceryRowTitle("Banana (Fruit)"), "Banana (Fruit)");
check("no vendor bracket survives", !groceryRowTitle("Banana (Fruit)").includes("["));

// ⚠️ The ingredient's OWN brackets are part of its name and must be left alone —
// stripping "[" wholesale would eat the bracket standard's brand tag.
eq(
	"the ingredient's own brand bracket is untouched",
	groceryRowTitle("Chicken Breast [Betagro]"),
	"Chicken Breast [Betagro]",
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
