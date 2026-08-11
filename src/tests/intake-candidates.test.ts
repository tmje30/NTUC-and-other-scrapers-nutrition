import {
	CANDIDATE_MARGIN,
	candidatesFor,
	decideItem,
	nextCandidates,
	rankRows,
	type IngredientRow,
} from "../core/list-intake.js";
import { parseItem } from "../core/list-parse.js";
import { newIngredientFields, unitTypeFor } from "../core/tg-inbox.js";
import { parseName } from "../core/parse.js";
import { check, describe, eq } from "./harness.js";

/**
 * The ask that offers every candidate, and the two ways out of it — faults 28 and
 * 30, both found the first time the inbox was used for real.
 *
 * ⚠️ **The failure these prevent looks exactly like success.** A tie resolved by
 * whichever row Notion happened to return first produces a grocery-list line that
 * reads perfectly, links a relation to the wrong ingredient, and quotes that
 * ingredient's price. Nothing about it is visibly wrong until you are in the shop.
 */
describe("texted list — a tie must be asked about, not guessed");

const row = (name: string): IngredientRow => ({
	pageId: `page-${name}`,
	name,
	searchTerm: name.replace(/\s*[[({].*$/, "").trim(),
	unitType: "By Gram",
	price: null,
});

// The live database on 2026-08-10, reduced to the rows that made the fault.
// Two milks score identically; the two chickens are different FOODS a hair apart.
const ROWS: IngredientRow[] = [
	row("Milk (Low Fat)"),
	row("Milk ( Normal)"),
	row("Chicken thigh, Boneless  [Seara]"),
	row("chicken soup cube"),
	row("Peanut Butter Spread [Skippy] {Creamy}"),
];

const names = (ms: { row: IngredientRow }[]) => ms.map((m) => m.row.name);

// ⚠️ The exact case from the handover: `1 x milk` linked silently to whichever
// milk came back first. Both score the same, so neither is "the" answer.
const milk = candidatesFor("milk", ROWS);
check("both milks are offered, not one of them picked", milk.length === 2);
eq("…and in a stable order", names(milk), ["Milk ( Normal)", "Milk (Low Fat)"]);
eq("a tie is asked about even at full confidence", decideItem(parseItem("1 x milk")!, ROWS).verdict, "ask");

// A confident match with nothing near it still links silently — the point of the
// margin is that it does NOT turn every match into a question.
const pb = decideItem(parseItem("peanut butter")!, ROWS);
eq("a lone confident match is still linked silently", pb.verdict, "linked");
check("…and carries exactly one candidate", pb.candidates.length === 1);

check(
	"the margin is small enough to leave clear winners alone",
	CANDIDATE_MARGIN > 0 && CANDIDATE_MARGIN <= 0.1,
);

describe("texted list — re-search offers the next tranche");

const first = candidatesFor("milk", ROWS);
const rejected = first.map((m) => m.row.pageId);
const second = nextCandidates("milk", ROWS, rejected);

check("nothing already offered comes back", second.every((m) => !rejected.includes(m.row.pageId)));
check("what is left is still ranked", second.every((m, i) => i === 0 || m.score <= second[i - 1].score));

// ⚠️ Below the review bar on purpose: being asked at all means the confident
// answers were already turned down, so "nothing else is close" is a worse answer
// than a faint one the user can see and reject.
check(
	"a faint match IS offered on re-search",
	nextCandidates("milk", ROWS, rejected).length > 0 || rankRows("milk", ROWS).length === 2,
);
eq("re-searching past every row offers nothing", nextCandidates("milk", ROWS, ROWS.map((r) => r.pageId)), []);

describe("texted list — creating the row the user asked for");

// ⚠️ **The whole point of choosing braces.** `( )` is a DEFINING PROPERTY in this
// project's bracket standard — a hard requirement on the product's title — so a
// row called `(New) Harissa Paste` would demand the word "new" from every listing
// at every shop, match nothing, and appear in no section of the deals page, while
// looking perfectly ordinary in Notion. `{ }` is the ignored bracket.
const created = newIngredientFields(parseItem("harissa paste")!);
eq("the marker is in braces", created.name, "{New} harissa paste");
eq("…so the scan searches the food, not the marker", parseName(created.name).searchTerm, "harissa paste");
eq("…and 'new' is not a requirement", parseName(created.name).properties, []);
check("…while (New) would have demanded it", parseName("(New) harissa paste").properties.includes("new"));

// The texted quantity says what the row is counted in — the same inference
// `fieldsFromPurchase` makes from a pack.
eq("a stated weight is By Gram", unitTypeFor(parseItem("2kg chicken breast")!), "By Gram");
eq("a stated volume is By ml", unitTypeFor(parseItem("1L milk")!), "By ml");
eq("a bare count is By Unit", unitTypeFor(parseItem("bananas x6")!), "By Unit");
eq("no quantity at all falls back to By Gram", unitTypeFor(parseItem("harissa paste")!), "By Gram");

// ⚠️ No price, no size. Both belong to a vendor slot, and a slot holding a size
// with no price and no shop is a half-fact `readBaseline` would have to step over.
check("no price is invented", created.priceSgd === undefined);
check("no size is invented", created.size === undefined);
check("the category is a guess, resolved against Notion's own options at write time", "categoryKey" in created);
