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

describe("pack weight in the name — how a counted item gets compared");

/**
 * ⚠️ **The one figure that stops a per-piece price flattering the smallest piece.**
 *
 * A counted row (`By Unit`) prices per egg, per slice, per roll — and counting does
 * not normalise size, so 30 quail eggs look cheaper than 10 hen's eggs purely by
 * being smaller. The weight stated in the row's NAME is the only thing that lets
 * `compare.ts` fall back to price-per-gram and see through that.
 *
 * Both forms are accepted. `(350g)` is the older convention and is what four live
 * rows already use; `, 350g` was stated by the user on 2026-08-09 and until then was
 * silently dropped — no error, no search breakage, just a row quietly missing the
 * figure its whole comparison rests on.
 */
const weightIn = (name: string) => parseName(name).size?.grams ?? null;

eq("the parenthesised form — four live rows use it", weightIn("Egg tray (350g)"), 350);
eq("the comma form the user stated", weightIn("Egg tray, 350g"), 350);
eq("a comma weight among other segments", weightIn("Eggs, Whole, small, 350g, {cheap}"), 350);
eq("kg is normalised to grams", weightIn("Rice, 1.5kg"), 1500);
eq("a multipack states its total", weightIn("Milk, 2 x 1L"), 2000);
// ( ) is the explicit, older convention, so it wins where a name carries both.
eq("parentheses win over a comma", weightIn("Egg tray, 350g (400g)"), 400);

// ⚠️ Only a segment that is PURELY a size counts. A comma segment is otherwise a
// descriptive keyword, and reading a weight out of one that also says something
// would attach a number to a row that never claimed it.
eq("an ordinary segment is not a weight", weightIn("Bread, Wholemeal, Sunshine"), null);
eq("a bare name has no weight", weightIn("Eggs, Whole, small, {cheap}"), null);
// The must-match keywords beside a weight must survive it being extracted.
eq("extracting a weight leaves the keywords alone", parseName("Bread, Wholemeal, 600g").mustMatch, ["wholegrain"]);
eq("and leaves the search term alone", parseName("Egg tray, 350g").searchTerm, "Egg tray");

describe("pack weight in the name — it prices, it never filters");

/**
 * ⚠️ **The weight in a row's name must NEVER narrow the search**, and this suite
 * exists because that is a natural thing to get wrong: everything else inside `( )`
 * IS a hard requirement. `Onion (White)` genuinely demands the word "white" in a
 * candidate's title — so `Egg tray (300g)` looks like it should demand "300g", and
 * no shop writes your pack size in its product name, so the row would match nothing
 * at all and simply go quiet.
 *
 * `SIZE_ONLY_RE` is what keeps a size-only parenthetical out of `properties`. What
 * the weight is FOR is the comparison: price per kg, or price per piece with a
 * sanity check on piece size. A 350 g tray of 30 eggs is not a demand for a 350 g
 * pack — it is how the system knows one of those eggs weighs about 55 g.
 */
const parsed = parseName("Egg tray (300g)");
eq("a size imposes no hard property", parsed.properties, []);
eq("and no must-match keyword", parsed.mustMatch, []);
eq("so the row stays in the basic, unrestricted range", parsed.basicRange, true);
eq("the search term is the bare noun", parsed.searchTerm, "Egg tray");
eq("the comma form behaves identically", parseName("Egg tray, 300g").properties, []);

// The contrast that makes the point: a NON-size parenthetical really does bind.
eq("a real property still binds", parseName("Onion (White)").properties, ["white"]);
check("and a bound property leaves the basic range", !parseName("Onion (White)").basicRange);

// A size alongside a genuine keyword must not swallow it, in either form.
eq("a keyword beside a (size) survives", parseName("Bread, Wholemeal, [FairPrice] (600g)").mustMatch, ["wholegrain"]);
eq("a keyword beside a comma size survives", parseName("Bread, Wholemeal, 600g").mustMatch, ["wholegrain"]);
