import { deriveGenericName, stripStructure, structuredName } from "../core/generic-name.js";
import { parseName } from "../core/parse.js";
import { check, describe, eq } from "./harness.js";

/**
 * The shop's title → the user's own naming standard, for the `Name` column.
 *
 * `Name` is the one `parse.ts` reads to build a search, so what the extension puts
 * there decides what gets searched for ever after. The round-trip cases at the
 * bottom are the important ones: it is not enough for the string to *look* right,
 * the parser has to read back what was meant.
 */
describe("structured name — the bracket standard");

eq(
	"brand in [ ], variant in { }",
	structuredName("Skippy Peanut Butter Spread - Creamy", "Skippy"),
	"Peanut Butter Spread [Skippy] {Creamy}",
);
eq("no variant, no braces", structuredName("Skippy Peanut Butter Spread", "Skippy"), "Peanut Butter Spread [Skippy]");
eq("no brand, no brackets", structuredName("Rolled Oats - Jumbo", ""), "Rolled Oats {Jumbo}");
eq("plain title is left plain", structuredName("Rolled Oats", ""), "Rolled Oats");
eq(
	"a multi-word variant survives whole",
	structuredName("Gardenia Wholemeal Bread - Extra Soft & Fine", "Gardenia"),
	"Wholemeal Bread [Gardenia] {Extra Soft & Fine}",
);
eq("an en dash separates too", structuredName("Tuna Flakes – In Water", ""), "Tuna Flakes {In Water}");
eq("two dashes fold into one variant", structuredName("Oats - Instant - Original", ""), "Oats {Instant, Original}");

// ⚠️ FairPrice really ships names like this, and leaving the brackets in would have
// parse.ts read "BCRS" as the brand — a brand filter nobody asked for.
eq(
	"a pre-existing bracket in the shop's title is stripped",
	structuredName("[BCRS] Farmhouse Milk - Fresh", "Farmhouse"),
	"Milk [Farmhouse] {Fresh}",
);

eq("an empty title yields nothing", structuredName("", ""), "");

describe("structured name — stripping it back off");

eq("brackets removed", stripStructure("Peanut Butter Spread [Skippy] {Creamy}"), "Peanut Butter Spread");
eq("parentheses too", stripStructure("Onion (White)"), "Onion");
eq("all three at once", stripStructure("Milk [Meiji] (Full Fat) {cheap}"), "Milk");
eq("a plain name is untouched", stripStructure("Rolled Oats"), "Rolled Oats");

/**
 * ⚠️ The round trip is the point. A name that reads well but parses wrong is worse
 * than a plain one, because the failure is silent — the row just quietly stops
 * matching things.
 */
describe("structured name — what parse.ts reads back");

const p = parseName(structuredName("Skippy Peanut Butter Spread - Creamy", "Skippy"));
// `searchTerm` keeps the shop's capitalisation, so every check on it is case-insensitive.
const term = p.searchTerm.toLowerCase();
eq("the brand is understood as a brand", p.brand, "skippy");
check("the brand is NOT in the search term", !term.includes("skippy"), p.searchTerm);
check("the variant is NOT in the search term", !term.includes("creamy"), p.searchTerm);
// The whole reason the variant goes in { } and not ( ): a hard property would
// reject the smooth jar that is actually on offer this week.
eq("the variant imposes NO hard requirement", p.properties, []);
check("the base noun survives", /peanut butter/.test(term), p.searchTerm);

// Promoting a variant by hand is the user's call, and it must actually bite.
const promoted = parseName("Onion (White)");
eq("a hand-promoted property IS a hard requirement", promoted.properties, ["white"]);

// The plain generic stays plain — it feeds the category guess and the similar-rows
// search, and brackets there would match on punctuation.
eq("deriveGenericName is unchanged", deriveGenericName("Skippy Peanut Butter Spread - Creamy", "Skippy"), "Peanut Butter Spread - Creamy");
