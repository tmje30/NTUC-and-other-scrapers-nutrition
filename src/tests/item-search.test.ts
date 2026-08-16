import {
	EXACT_SCORE,
	MAX_HITS,
	MAX_QUERIES,
	SIMILAR_FLOOR,
	formatSearch,
	hitLine,
	searchAll,
	searchQuery,
	searchRows,
	searchTerms,
	sizeText,
} from "../core/item-search.js";
import type { IngredientRow } from "../core/list-intake.js";
import { check, describe, eq } from "./harness.js";

/**
 * `/search` — looking a price up without buying it.
 *
 * ⚠️ **The failure this suite exists to stop is a silent WRITE.** Plain text in
 * this bot is a shopping list, so a search that fell through to the intake would
 * answer "what does chicken cost?" by adding chicken to the list and queueing a
 * shop scan for anything it didn't recognise. The command router is therefore the
 * first thing tested, and the boundary between "this is a search" and "this is a
 * list" is asserted from both sides.
 */
describe("/search — the command router, which decides read vs write");

eq("a search is recognised", searchQuery("/search chicken breast"), "chicken breast");
eq("…and its aliases", searchQuery("/find milk"), "milk");
eq("…including the one-thumb form", searchQuery("/s eggs"), "eggs");
eq("…and /price, which is what it answers", searchQuery("/price rice"), "rice");
eq("case doesn't matter", searchQuery("/Search Milk"), "Milk");
// Telegram appends @thebot in groups. Private chat doesn't, but the cost of
// handling it is one alternation and the cost of not is a command that looks dead.
eq("a bot suffix is stripped", searchQuery("/search@Grocery69_bot milk"), "milk");

// ⚠️ Empty string and null are DIFFERENT answers. `""` is "asked to search, said
// nothing" → the usage hint. `null` is "this is a shopping list" → the intake.
// Collapsing them either swallows a list or nags at a bare command.
eq("a bare command asks what for", searchQuery("/search"), "");
eq("…even with trailing space", searchQuery("/search   "), "");
eq("⚠️ an ordinary list is NOT a search", searchQuery("2kg chicken breast"), null);
eq("…nor is a list that happens to start with the word", searchQuery("search chicken"), null);
eq("…nor another command", searchQuery("/help"), null);
// `/start` and `/help` are matched before this in `handleMessage`, but `/searching`
// must not be swallowed here regardless — a prefix match would eat future commands.
eq("…nor a longer command that merely starts the same", searchQuery("/searching"), null);

describe("/search — exact matches, and near-misses labelled as near-misses");

const row = (name: string, extra: Partial<IngredientRow> = {}): IngredientRow => ({
	pageId: `page-${name}`,
	name,
	searchTerm: name.replace(/\s*[[({].*$/, "").trim(),
	unitType: "By Gram",
	parked: false,
	price: null,
	...extra,
});

const priced = (
	name: string,
	sgd: number,
	size: number,
	vendor: string,
	extra: Partial<IngredientRow> = {},
): IngredientRow =>
	row(name, {
		...extra,
		price: { sgd, size, vendor, per1000: (sgd / size) * 1000, perPiece: null },
	});

const ROWS: IngredientRow[] = [
	priced("Milk ( Normal)", 3.3, 1000, "NTUC", { unitType: "By ml" }),
	priced("Milk (Low Fat)", 3.15, 1000, "Sheng Siong", { unitType: "By ml" }),
	priced("Chicken thigh, Boneless  [Seara]", 8.2, 500, "Sheng Siong"),
	priced("Peanut Butter Spread [Skippy] {Creamy}", 7.9, 462, "FairPrice"),
	row("chicken soup cube"),
];

const found = (query: string) => searchRows(query, ROWS);
const names = (query: string) => found(query).hits.map((h) => h.row.name);

const milk = found("milk");
eq("a plain query reports an exact match", milk.kind, "exact");
// "list of exact items", plural — two milks are two answers, not a tie to resolve.
// The intake has to ask which one; a search has no reason to, and asking would be
// the wrong shape of reply to a question.
eq("…and lists ALL of them, not the best one", names("milk"), ["Milk ( Normal)", "Milk (Low Fat)"]);

// ⚠️ A vague query is the case the user named. It must not come back empty, and
// it must not come back looking confident.
const vague = found("nut spread");
eq("a vague query still finds the closest row", vague.kind, "similar");
eq("…which is the right one", vague.hits[0]?.row.name, "Peanut Butter Spread [Skippy] {Creamy}");
check("…and it scored below the exact bar, or it wouldn't be labelled 'similar'", vague.hits[0].score < EXACT_SCORE);

eq("nothing at all is said plainly", found("quinoa").kind, "none");
eq("…with no rows invented to fill the gap", found("quinoa").hits.length, 0);

check(
	"the similar floor sits below the intake's write bar (0.45), on purpose",
	SIMILAR_FLOOR < 0.45 && SIMILAR_FLOOR > 0,
);
check("hits are capped to a phone screen", found("milk").hits.length <= MAX_HITS);
check("best first", milk.hits.every((m, i) => i === 0 || m.score <= milk.hits[i - 1].score));

// ⚠️ Quantities must not derail a lookup. `tokens()` drops anything starting with
// a digit, which is why the raw line goes in un-parsed — see `searchRows`.
eq("a quantity in the query is harmless", names("2kg chicken thigh")[0], "Chicken thigh, Boneless  [Seara]");
eq("…and so is a trailing bare number", found("milk 2").kind, "exact");

describe("/search — the four figures the user asked for");

const line = hitLine(found("chicken thigh").hits[0]);

check("the name is there", line.includes("Chicken thigh, Boneless  [Seara]"));
check("the price is there", line.includes("$8.20"));
check("the size is there", line.includes("500g"));
check("the price per kg is there", line.includes("$16.40/kg"));
check("and the vendor it came from", line.includes("Sheng Siong"));

// ⚠️ `Size[Vendor n]` holds grams, millilitres OR a piece count, decided by
// `Unit type ` — the same trap that once printed `$399.00/kg` for a box of eggs.
// Labelling a count of 10 as "10g" is that mistake with smaller consequences.
eq("a weighed row's size reads in grams", sizeText(priced("x", 8.2, 500, "NTUC")), "500g");
eq("…and rolls up to kg", sizeText(priced("x", 8.2, 2000, "NTUC")), "2kg");
eq("a volumetric row says millilitres", sizeText(priced("x", 3.3, 750, "NTUC", { unitType: "By ml" })), "750ml");
eq("…and litres", sizeText(priced("x", 3.3, 1000, "NTUC", { unitType: "By ml" })), "1L");
eq(
	"⚠️ a counted row says PIECES, never grams",
	sizeText(priced("x", 3.99, 10, "NTUC", { unitType: "By Unit" })),
	"10 pc",
);
eq("a row with no price has no size to state", sizeText(row("Harissa Paste")), null);

// A row with nothing on its price book is still an answer — "you have this, you
// have never recorded what it costs" — and dropping it would make the query look
// like it found less than it did.
const cube = hitLine(found("chicken soup cube").hits[0]);
check("an unpriced row is still listed", cube.includes("chicken soup cube"));
check("…and says so rather than showing a blank", cube.includes("no price recorded yet"));
check("…with no $ figure invented", !cube.includes("$"));

describe("/search — one message, however much was asked");

// The user's requirement, stated as a test: several items, ONE text.
const many = formatSearch(searchAll(searchTerms("milk, chicken thigh, quinoa"), ROWS));

eq("every query gets a block", (many.match(/🔎/g) ?? []).length, 3);
check("in the order they were typed", many.indexOf("milk") < many.indexOf("chicken thigh"));
check("a near-miss block says it is one", formatSearch([found("nut spread")]).includes("closest"));
check("an exact block does not", !formatSearch([milk]).includes("closest"));
check("⚠️ it fits in one Telegram message", many.length <= 4096);

eq("newlines split queries too", searchTerms("milk\neggs\nrice").length, 3);
// ⚠️ Multi-line messages are NOT comma-split, because the user's own naming
// standard is full of commas — `Onion (White), Fresh` is one ingredient. Inherited
// from `splitLines`, and asserted here because a search that shredded a row name
// would report "nothing matches" for a row that is plainly there.
eq("…and a multi-line message keeps its commas", searchTerms("Onion (White), Fresh\nmilk"), [
	"Onion (White), Fresh",
	"milk",
]);

check("too many terms are capped", searchTerms(Array.from({ length: 20 }, (_, i) => `item${i}`).join(",")).length === MAX_QUERIES);
// ⚠️ Said out loud. A reply that silently stops after ten of twenty is
// indistinguishable from one that only found ten.
check(
	"…and the reply says what it left out",
	formatSearch(searchAll(searchTerms("a,b,c"), ROWS), 12).includes("more item"),
);

// The clip is the last defence: 4096 is Telegram's hard cap, and one text was the
// requirement, so the overflow is paid in results rather than in a second message.
const huge = searchAll(
	Array.from({ length: MAX_QUERIES }, () => "milk"),
	Array.from({ length: 40 }, (_, i) => priced(`Milk variety number ${i} with a long name [Brand]`, 3.3, 1000, "NTUC")),
);
const clipped = formatSearch(huge);
check("a very large answer is still one message", clipped.length <= 4096);
check("…and admits it dropped something", clipped.includes("didn't fit"));
