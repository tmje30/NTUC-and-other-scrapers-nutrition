import { check, describe, eq } from "./harness.js";
import { sameShop, vendorAtLocation, LOCATION_TAGS, type VendorLocations } from "../core/vendor-locations.js";
import { bestAtLocation } from "../core/grocery-page.js";

describe("which shops are on this trip");

/**
 * The live tagging, introspected 2026-10-04. Six of the nine shops carry no location tag at
 * all, which is the case the toggle has to survive rather than the exception.
 */
const locations: VendorLocations = new Map([
	["Sheng Siong", new Set(["home"])],
	["NTUC", new Set(["home", "office toby"])],
	["Shopee", new Set(["office toby", "office ml"])],
	["Guardian Pharmacy", new Set<string>()],
	["Watsons Pharmacy", new Set<string>()],
	["My Protein", new Set<string>()],
]);

check("Sheng Siong is a Home shop", vendorAtLocation(locations, "Sheng Siong", "home"));
check("…and not a Work one", !vendorAtLocation(locations, "Sheng Siong", "work"));
check("NTUC is both", vendorAtLocation(locations, "NTUC", "home") && vendorAtLocation(locations, "NTUC", "work"));

// ⚠️ **Work is Office Toby ONLY** (user's call). Shopee carries both office tags, so it
// qualifies — but a shop tagged only `Office ML` must NOT, or the toggle sends you to the
// wrong office.
eq("Work means Office Toby", LOCATION_TAGS.work, "Office Toby");
const mlOnly: VendorLocations = new Map([["Somewhere", new Set(["office ml"])]]);
check("a shop tagged only Office ML is not Work", !vendorAtLocation(mlOnly, "Somewhere", "work"));

// ⚠️ Cheapest is the ABSENCE of a filter, not a location — every shop qualifies, including
// the untagged ones, which is what keeps it identical to the page's old behaviour.
check("cheapest takes an untagged shop", vendorAtLocation(locations, "Guardian", "cheapest"));
check("…and Home does not", !vendorAtLocation(locations, "Guardian", "home"));
check("a shop not in the DB at all is nowhere", !vendorAtLocation(locations, "Nonesuch", "home"));

/**
 * ⚠️⚠️ **The two databases do not spell the shops the same way.** The price book's options
 * are `Guardian`, `Watsons`, `Iherb`; Website Used calls them `Guardian Pharmacy`,
 * `Watsons Pharmacy`. An `===` here drops every shop written out in full — and a dropped
 * shop is indistinguishable from an untagged one, so the toggle would just quietly show
 * fewer prices.
 */
check("Guardian matches Guardian Pharmacy", sameShop("Guardian", "Guardian Pharmacy"));
check("…and Watsons matches Watsons Pharmacy", sameShop("Watsons", "Watsons Pharmacy"));
check("…whatever the case and spacing", sameShop("  sheng   siong ", "Sheng Siong"));
check("but Google Search is not Google Shopping's neighbour", !sameShop("Google Search", "Shopee"));
check("…and empty matches nothing", !sameShop("", "NTUC"));

describe("the cheapest shop on this trip");

const slots = [
	// $2.00 / 500g = $4.00/kg
	{ vendorName: "NTUC", priceValue: 2.0, sizeValue: 500, urlValue: "https://ntuc.test/x" },
	// $1.60 / 1000g = $1.60/kg — cheapest per kg, dearest per pack
	{ vendorName: "Sheng Siong", priceValue: 1.6, sizeValue: 1000, urlValue: "https://ss.test/x" },
	// $0.50 / 100g = $5.00/kg, and untagged
	{ vendorName: "Guardian", priceValue: 0.5, sizeValue: 100, urlValue: "https://g.test/x" },
];

// ⚠️ Cheapest per kg/L, never the sticker price: a 1 kg bag at $1.60 beats 500 g at $2.00.
eq("cheapest overall is per kg", bestAtLocation(slots, locations, "cheapest").vendor, "Sheng Siong");
eq("Home picks the cheapest Home shop", bestAtLocation(slots, locations, "home").vendor, "Sheng Siong");
// Sheng Siong is not a Work shop, so NTUC wins there even though it is dearer per kg.
eq("Work picks the cheapest WORK shop", bestAtLocation(slots, locations, "work").vendor, "NTUC");
eq("…and carries that shop's own link", bestAtLocation(slots, locations, "work").url, "https://ntuc.test/x");

/**
 * ⚠️ **A row priced only at an untagged shop is reported, never silently dropped** (user's
 * call). Hiding it would empty the list on a missing tag and look exactly like having
 * nothing left to buy.
 */
const untaggedOnly = [{ vendorName: "Guardian", priceValue: 0.5, sizeValue: 100, urlValue: "https://g.test/x" }];
const home = bestAtLocation(untaggedOnly, locations, "home");
eq("no reachable shop means no price", home.price, null);
check("…but it says the price exists elsewhere", home.elsewhere);

// Nothing priced anywhere is a different thing from "priced, but not here".
const nothing = bestAtLocation([], locations, "home");
check("an unpriced row is not 'elsewhere'", !nothing.elsewhere);

// ⚠️ A slot with no usable price cannot win: it would beat a shop that actually has one.
const halfPriced = [
	{ vendorName: "Sheng Siong", priceValue: null, sizeValue: null, urlValue: "https://ss.test/x" },
	{ vendorName: "NTUC", priceValue: 2.0, sizeValue: 500, urlValue: "https://ntuc.test/x" },
];
eq("a priceless slot never wins", bestAtLocation(halfPriced, locations, "home").vendor, "NTUC");
