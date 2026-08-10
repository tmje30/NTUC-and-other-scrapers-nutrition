import { bestRow, decideItem, pricePerKgLabelFor, type IngredientRow } from "../core/list-intake.js";
import { parseItem } from "../core/list-parse.js";
import { ACCEPT_THRESHOLD, REVIEW_THRESHOLD } from "../core/match.js";
import { check, describe, eq } from "./harness.js";

/**
 * The three-way decision a texted item gets: link it, ask about it, or treat it
 * as new.
 *
 * ⚠️ **Both wrong answers here are silent and neither looks like a bug.** A
 * false link points the grocery list's `List [Ingredients]` relation at the wrong
 * row and quotes that row's price, so the line reads perfectly and is about a
 * different food. A false "new" sends the scraper off to price something the user
 * has had in Notion for months, and files a duplicate. The bands are the
 * matcher's own — if these tests start failing after a `match.ts` change, the
 * question is whether the THRESHOLD moved, not whether to nudge the fixtures.
 */
describe("texted list — matching to Ingredients");

const row = (name: string, extra: Partial<IngredientRow> = {}): IngredientRow => ({
	pageId: `page-${name}`,
	name,
	// In real use this comes from `parseName`; the fixtures use plain nouns so the
	// test is about the decision, not about bracket parsing (covered in naming.test).
	searchTerm: name.replace(/\s*[[({].*$/, "").trim(),
	unitType: "By Gram",
	price: null,
	...extra,
});

const ROWS: IngredientRow[] = [
	row("Peanut Butter Spread [Skippy] {Creamy}", {
		price: { sgd: 8.2, size: 500, vendor: "NTUC", per1000: 16.4 },
	}),
	row("Milk (Normal)", { price: { sgd: 3.1, size: 1000, vendor: "NTUC", per1000: 3.1 } }),
	row("Chicken Breast", { price: { sgd: 11.9, size: 1000, vendor: "Sheng Siong", per1000: 11.9 } }),
	row("Onion (White)"),
];

const named = (query: string) => bestRow(query, ROWS);

check("an exact name matches its own row", named("Milk (Normal)")?.row.name === "Milk (Normal)");

// The stripped-vs-full scoring exists so neither spelling is punished for the
// other — see `bestRow`.
check(
	"the stripped noun finds a bracketed row",
	named("peanut butter")?.row.pageId === "page-Peanut Butter Spread [Skippy] {Creamy}",
);
check(
	"the brand alone finds the same row",
	named("skippy")?.row.pageId === "page-Peanut Butter Spread [Skippy] {Creamy}",
);

check("an unrelated word does not reach the review band", (named("harissa paste")?.score ?? 0) < REVIEW_THRESHOLD);

describe("texted list — the three-way verdict");

const verdictOf = (line: string) => decideItem(parseItem(line)!, ROWS).verdict;

eq("a confident name is linked silently", verdictOf("2kg chicken breast"), "linked");
eq("an exact ingredient name is linked", verdictOf("1L milk"), "linked");
eq("something unknown is new", verdictOf("harissa paste"), "new");
eq("a totally unrelated line is new", verdictOf("dishwasher tablets"), "new");

// The quantity must not change the verdict: "2kg chicken breast" and "chicken
// breast" are the same ingredient, and a parser that leaked the digits into the
// query would score them differently.
eq(
	"quantities do not change the verdict",
	verdictOf("chicken breast"),
	verdictOf("2 x 500g chicken breast"),
);

const linked = decideItem(parseItem("chicken breast")!, ROWS);
check("a linked decision carries its row", linked.match?.row.name === "Chicken Breast");
check("a linked decision scored at or above ACCEPT", (linked.match?.score ?? 0) >= ACCEPT_THRESHOLD);

const fresh = decideItem(parseItem("harissa paste")!, ROWS);
eq("a new decision carries no row", fresh.match, null);

// An empty Ingredients DB must produce "new", not a crash or a bogus link — the
// state a fresh clone or a failed read leaves behind.
eq("no rows at all means new, not a crash", decideItem(parseItem("milk")!, []).verdict, "new");

describe("texted list — the price quoted on the row");

eq(
	"a priced row gives a per-kg label",
	pricePerKgLabelFor(ROWS.find((r) => r.name === "Chicken Breast")!),
	"$11.90/kg",
);
// A By-ml row is priced per litre — the same figure, the honest unit.
eq(
	"a By-ml row says /L",
	pricePerKgLabelFor(row("Oil", { unitType: "By ml", price: { sgd: 5, size: 1000, vendor: "NTUC", per1000: 5 } })),
	"$5.00/L",
);
// No price book, no label — never a fabricated $0.00/kg.
eq("an unpriced row gives no label", pricePerKgLabelFor(row("Onion (White)")), undefined);
eq(
	"a priced row with no size gives no label",
	pricePerKgLabelFor(row("Salt", { price: { sgd: 2, size: null, vendor: "NTUC", per1000: null } })),
	undefined,
);
