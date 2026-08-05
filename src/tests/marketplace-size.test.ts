/**
 * `marketplaceSize` and `cheapestPlausible` — the two functions standing between a
 * marketplace listing and a wrong number on a deal card.
 *
 * Every case below is a REAL title taken from one page of Carousell whey results
 * (2026-08-04/05), not an invented string. That matters: two of these were passing
 * quietly wrong values in the first live run of `npm run vendor-probe`, and neither
 * looked wrong in the output — they looked like bargains.
 *
 *  - `"…Protein 1.6-5 LBS"` was read as a flat **5 LBS**, pricing the seller's smallest
 *    tier as their largest tub.
 *  - `"2 X MuscleBlaze … - 2lb"` was read as **2 lb** instead of 4, because the gap
 *    between the multiplier and the unit was 46 characters and the pattern allowed 40.
 *
 * Both are the house failure mode: an error that makes a bad deal look good. Same family
 * as the 32 g serving read as 100 g, and tested here for the same reason.
 */

import { describe, check } from "./harness.js";
import { marketplaceSize, cheapestPlausible } from "../core/marketplace-size.js";

describe("marketplace size");

const g = (title: string): number | null => {
	const r = marketplaceSize(title);
	return r.ok ? r.grams : null;
};
const reason = (title: string): string => {
	const r = marketplaceSize(title);
	return r.ok ? "ok" : r.reason;
};
const near = (a: number | null, b: number, tol = 1): boolean => a != null && Math.abs(a - b) <= tol;

// --- imperial units: the reason this module exists -------------------------
check("5 lbs → 2268 g", near(g("Optimum Nutrition Gold Standard 100% Whey Protein 5 lbs"), 2267.96));
check("5LBS (no space, caps)", near(g("Dymatize ISO100 Strawberry 5LBS Whey Protein Isolate"), 2267.96));
check("5Lb (mixed case)", near(g("5Lb Double Rich Chocolate Optimum Nutrition Whey Protein"), 2267.96));
check("4.00 LBS (trailing zeros)", near(g("Muscletech Nitro Tech Whey Protein Cookies & Cream 4.00 LBS"), 1814.37));
check("oz supported", near(g("Protein Powder 16 oz"), 453.59));
check("metric still works", near(g("NOW Sports Whey Protein 2.2kg"), 2200));
check("grams still work", near(g("Applied Nutrition Critical Whey 825g"), 825));

// --- ranges: caught live, 2026-08-05 ---------------------------------------
check(
	"a shared-unit RANGE is rejected, not read as its top end",
	reason("Mutant Hardcore ISO Whey Isolate Protein 1.6-5 LBS") === "range",
	`got ${reason("Mutant Hardcore ISO Whey Isolate Protein 1.6-5 LBS")} / ${g("Mutant Hardcore ISO Whey Isolate Protein 1.6-5 LBS")}g`,
);
check("en-dash range also rejected", reason("Whey Protein 450–825 g") === "range");

// --- multi-size titles -----------------------------------------------------
check(
	"slash multi-size rejected",
	reason("Applied Nutrition Critical Whey Protein 450g/825g") === "multi-size",
	`got ${reason("Applied Nutrition Critical Whey Protein 450g/825g")}`,
);
check(
	"bracketed multi-size rejected",
	reason("Optimum Nutrition - Gold Standard 100% Isolate [1.58LBS / 5.2LBS]") === "multi-size",
);
check(
	"the SAME size stated twice is NOT multi-size",
	near(g("Whey Protein Isolate 5 lbs (2.27kg)"), 2267.96),
	`got ${g("Whey Protein Isolate 5 lbs (2.27kg)")}`,
);

// --- multipacks: caught live, 2026-08-05 -----------------------------------
check(
	"2 X <long product name> - 2lb → 4 lb",
	near(g("(FREE DELIVERY) 2 X MuscleBlaze Biozorb Performance Whey Protein - 2lb"), 907.18 * 2, 2),
	`got ${g("(FREE DELIVERY) 2 X MuscleBlaze Biozorb Performance Whey Protein - 2lb")}g, expected ~1814`,
);
check("plain 3 x 1kg → 3000 g", near(g("Bundle 3 x 1kg Whey"), 3000));

// --- things that are not pack sizes ----------------------------------------
check("no size at all → none", reason("MuscleBlaze MB Biozorb Performance Whey Protein") === "none");
check("percentages are not sizes", reason("Optimum Nutrition 100% Whey") === "none", `got ${reason("Optimum Nutrition 100% Whey")}`);
check("a serving count is not a pack size", reason("Whey Protein 60 servings") === "none");

// --- the plausibility gate -------------------------------------------------
describe("marketplace plausibility gate");

// The real spread seen on one search: ON Gold Standard 5 lbs at S$37, S$38 and S$110,
// against a retail of roughly S$120. "Cheapest wins" picks a listing that is not a 5 lb tub.
const listings = [
	{ label: "ON 5lbs S$37", pricePer100g: 1.631 },
	{ label: "ON 5lbs S$38", pricePer100g: 1.676 },
	{ label: "ISO100 5LBS S$40", pricePer100g: 1.764 },
	{ label: "Myprotein Impact 2.5kg", pricePer100g: 3.4 },
	{ label: "Nitro Tech 4lbs S$80", pricePer100g: 4.409 },
	{ label: "ON 5lbs S$110", pricePer100g: 4.85 },
	{ label: "NOW Sports 2.2kg S$150", pricePer100g: 6.818 },
];

const gate = cheapestPlausible(listings);
check("the gate does not return the absolute minimum", gate.pick?.label !== "ON 5lbs S$37", `picked ${gate.pick?.label}`);
check("the gate rejects the implausible tail", gate.rejected.length >= 3, `rejected ${gate.rejected.length}`);
check("a median is reported", gate.median != null && gate.median > 0);
check(
	"the pick is the cheapest SURVIVOR, not just any survivor",
	gate.pick != null && !gate.rejected.some((r) => r.pricePer100g > gate.pick!.pricePer100g),
);
check("an empty candidate list is safe", cheapestPlausible([]).pick === null);
check(
	"a tight cluster loses nobody",
	cheapestPlausible([{ pricePer100g: 3.0 }, { pricePer100g: 3.1 }, { pricePer100g: 3.2 }]).rejected.length === 0,
);
