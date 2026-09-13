import { check, describe, eq } from "./harness.js";
import {
	DISCOUNT_PROPS,
	discountBeats,
	discountProperties,
	discountRate,
	formatDiscount,
	hasDiscount,
	parseRecordedRate,
	readDiscount,
} from "../core/discount.js";
import type { UnitType } from "../core/notion.js";

/**
 * **The three discount columns** (user, 2026-09-12).
 *
 * The rule under test is the user's, in their own words: *By Unit = x per 10 pcs, By gram
 * = x per kg, By ml = x per L.* That is the same three-way rule Notion's own
 * `Cheapest Price/Kg ` formula uses and the same one `perLabel` prints in the sweep's
 * report — so the cases below are as much a guard against those THREE drifting apart as
 * they are a check on this file. A factor of ten between two of them has already cost one
 * live incident; see the warning on `perLabel`.
 *
 * The second theme is the thing a price column never has to worry about: an **expiry**. A
 * promo nobody clears reads as a live offer forever, and it is cleared by the shop that
 * set it and by nobody else.
 */
describe("discounts — the rate follows the row's unit type");

const rate = (unitType: UnitType, price: number, size: number | null, rowName = "Thing", itemName = "") =>
	discountRate({ unitType, price, size, rowName, itemName });

eq("By Gram quotes per kg", rate("By Gram", 4.9, 500)?.value, 9.8);
eq("...and says so", rate("By Gram", 4.9, 500)?.label, "/kg");
eq("By ml quotes per litre", rate("By ml", 3.2, 800)?.value, 4);
eq("...and says so", rate("By ml", 3.2, 800)?.label, "/L");

// ⚠️ TEN pieces, mirroring Notion's `Cheapest Price/Kg ` (`$4.20 /10 pc`). Per-one and
// per-hundred are both live conventions elsewhere in this codebase; neither is this one.
eq("By Unit quotes per ten pieces", rate("By Unit", 3.99, 10)?.value, 3.99);
eq("...and says so", rate("By Unit", 3.99, 10)?.label, "/10 pc");
check("a box of thirty is cheaper per ten", Math.abs(rate("By Unit", 8.4, 30)!.value - 2.8) < 1e-9);

// A counted row that states a weight is divided by the weight, like everything else —
// `packWeightOf` decides, so a 10-pack of 55g eggs is quoted per kg, not per ten.
eq("a counted pack that states its grams is quoted per kg", rate("By Unit", 4.4, 10, "Eggs (550g)")?.label, "/kg");
eq("...at the right figure", rate("By Unit", 4.4, 10, "Eggs (550g)")?.value, 8);
// ⚠️ The SLOT's item name is asked first — it describes the pack being divided.
check(
	"the shop's own item name outranks the row's",
	Math.abs(rate("By Unit", 4.4, 10, "Eggs (550g)", "Seng Choon Fresh Eggs 800g")!.value - 5.5) < 1e-9,
);
// Genuinely uncountable by weight: a razor cartridge has no grams anyone wrote down.
eq("a counted pack with no weight anywhere falls back to pieces", rate("By Unit", 12, 4)?.label, "/10 pc");
check("a free or missing price has no rate", rate("By Gram", 0, 500) === null);
check("a pack with no size has no rate", rate("By Gram", 4.9, null) === null);

describe("discounts — what goes in the three cells");

const offer = formatDiscount({
	vendor: "Guardian",
	unitType: "By Gram",
	promoSgd: 6.63,
	size: 100,
	rowName: "Toothpaste, Sensitive",
	itemName: "Sensodyne Repair & Protect 100g",
});
eq("the price cell carries the pack", offer.price, "$6.63 / 100g");
eq("the rate cell carries the unit", offer.rate, "$66.30/kg");
eq("the location cell is the shop", offer.location, "Guardian");
eq("...and the rate is kept as a number for the compare", offer.rateValue, 66.3);

const counted = formatDiscount({
	vendor: "NTUC",
	unitType: "By Unit",
	promoSgd: 3.5,
	size: 10,
	rowName: "Eggs",
	itemName: "",
});
eq("a counted pack says pcs, not g", counted.price, "$3.50 / 10 pcs");
eq("...and quotes per ten", counted.rate, "$3.50/10 pc");

describe("discounts — one set of columns, four vendor slots");

// Nobody holds it → take it.
check("an empty cell is claimed", discountBeats({ recordedLocation: "", recordedRate: null, vendor: "NTUC", rate: 9.8 }));
// ⚠️ Its own entry is always the shop's to refresh, in EITHER direction — an offer that
// got less good is still today's offer, and refusing the update leaves a stale number.
check(
	"a shop may refresh its own discount upwards",
	discountBeats({ recordedLocation: "NTUC", recordedRate: 5, vendor: "NTUC", rate: 9.8 }),
);
check(
	"...whatever the case it is spelled in",
	discountBeats({ recordedLocation: "ntuc ", recordedRate: 5, vendor: "NTUC", rate: 9.8 }),
);
// Cheapest per kg wins, exactly as everywhere else in the project.
check(
	"a cheaper shop takes it off another",
	discountBeats({ recordedLocation: "Guardian", recordedRate: 12, vendor: "Watsons", rate: 9.8 }),
);
check(
	"a dearer shop does not",
	!discountBeats({ recordedLocation: "Guardian", recordedRate: 8, vendor: "Watsons", rate: 9.8 }),
);
// ⚠️ Displacing a NAMED shop on no evidence is the worse of the two errors. A pack with no
// divisor (`rate: null`) cannot be compared, so it waits rather than overwriting.
check(
	"an uncomparable offer does not displace a named shop",
	!discountBeats({ recordedLocation: "Guardian", recordedRate: 8, vendor: "Watsons", rate: null }),
);
check(
	"...but it does fill an empty cell",
	discountBeats({ recordedLocation: "", recordedRate: null, vendor: "Watsons", rate: null }),
);

describe("discounts — reading what is already there");

const cell = (s: string) => ({ rich_text: [{ plain_text: s }] });
const props = {
	[DISCOUNT_PROPS.PRICE]: cell("$6.63 / 100g"),
	[DISCOUNT_PROPS.RATE]: cell("$66.30/kg"),
	[DISCOUNT_PROPS.LOCATION]: cell("Guardian"),
};
eq("the recorded rate is read back as a number", readDiscount(props).rate, 66.3);
eq("...and the shop by name", readDiscount(props).location, "Guardian");
check("a filled row reports a discount", hasDiscount(props));
check("an empty row does not", !hasDiscount({}));
// ⚠️ The older capital-D spelling still reads. Same reasoning as `CATEGORY_ALIASES`: this
// database has renamed a property out from under the code once already and NOTHING errored.
eq(
	"the other spelling of the rate column still reads",
	readDiscount({ "Price per kg/L (Discount)": cell("$4.20/kg") }).rate,
	4.2,
);
eq("a bare number reads", parseRecordedRate("9.8"), 9.8);
check("prose nobody can price reads as no discount", parseRecordedRate("on offer this week") === null);
check("...and so does an empty cell", parseRecordedRate("") === null);
// ⚠️ Null must mean "let the fresh figure replace it" at the call site, never "refuse
// forever" — an unreadable cell is usually one a human typed.
check(
	"an unreadable cell does not block the shop that owns it",
	discountBeats({ recordedLocation: "Guardian", recordedRate: null, vendor: "Guardian", rate: 9.8 }),
);

describe("discounts — writing and clearing");

const schema = {
	[DISCOUNT_PROPS.PRICE]: { type: "rich_text" },
	[DISCOUNT_PROPS.RATE]: { type: "rich_text" },
	[DISCOUNT_PROPS.LOCATION]: { type: "rich_text" },
};
const wrote = discountProperties(schema, offer);
eq("all three columns are sent", wrote.written.length, 3);
eq("the price lands as rich text", wrote.properties[DISCOUNT_PROPS.PRICE].rich_text[0].text.content, "$6.63 / 100g");
const cleared = discountProperties(schema, null);
eq("a clear sends all three", cleared.written.length, 3);
eq("...as genuinely empty cells", cleared.properties[DISCOUNT_PROPS.LOCATION].rich_text.length, 0);

// ⚠️ A missing column is reported by name, never a thrown update. A database with two of
// the three still gets the two — the extension refusing every capture over one renamed
// column is a mistake this project has already made once (2026-08-09).
const partial = discountProperties({ [DISCOUNT_PROPS.LOCATION]: { type: "rich_text" } }, offer);
eq("a database missing two columns still writes the third", partial.written.length, 1);
eq("...and names what it could not write", partial.skipped.length, 2);
check(
	"...by column name",
	partial.skipped.some((s) => s.includes(DISCOUNT_PROPS.PRICE)),
);

// The capital-D database gets written in ITS spelling, not ours.
const legacy = discountProperties(
	{ "Price per kg/L (Discount)": { type: "rich_text" }, [DISCOUNT_PROPS.LOCATION]: { type: "rich_text" } },
	offer,
);
check("the rate is written under whichever spelling exists", "Price per kg/L (Discount)" in legacy.properties);
