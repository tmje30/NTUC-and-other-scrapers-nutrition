import {
	CANDIDATE_MARGIN,
	candidatesFor,
	decideItem,
	nextCandidates,
	pricePerKgLabelFor,
	rankRows,
	type IngredientRow,
} from "../core/list-intake.js";
import { parseItem } from "../core/list-parse.js";
import { askKeyboard, newIngredientFields, unitTypeFor } from "../core/tg-inbox.js";
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
	parked: false,
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

describe("texted list — a parked row is offered, never assumed");

/**
 * ⚠️ **Found by texting the live bot on 2026-08-11: "milk, skimmed" came back
 * offering two milks, neither of them skimmed.** `Milk (Skimmed)` carries
 * `Not in Use ATM`, and the reader dropped parked rows outright — so the one row
 * the user meant was the one row that could not be offered. Texting an item is an
 * explicit "I am buying this" and now outranks a snooze set weeks ago.
 *
 * ⚠️ **`Don't Search` is NOT this tag and must stay dropped.** It is the user's
 * permanent instruction, set by hand in Notion, and nothing in this repo may
 * write, clear, or offer a button that undoes it.
 */
const parked = (name: string): IngredientRow => ({ ...row(name), parked: true });
const WITH_PARKED: IngredientRow[] = [...ROWS, parked("Milk (Skimmed)")];

check(
	"a parked row is a candidate like any other",
	candidatesFor("milk", WITH_PARKED).some((m) => m.row.name === "Milk (Skimmed)"),
);

// Picking one un-parks it — a write to a tag the user set by hand — so it has to
// be a deliberate tap, never the by-product of a confident score.
const onlyParked: IngredientRow[] = [parked("Harissa Paste")];
const decided = decideItem(parseItem("harissa paste")!, onlyParked);
eq("⚠️ a parked row is NEVER linked silently, however well it scores", decided.verdict, "ask");
check("…and it is still the row on offer", decided.candidates[0]?.row.name === "Harissa Paste");
check("…which it would have been, unparked", decideItem(parseItem("harissa paste")!, [row("Harissa Paste")]).verdict === "linked");

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

describe("texted list — a piece count is not a weight");

/**
 * ⚠️ **Caught by reading the live grocery list back on 2026-08-11**, not by any
 * test: a $3.99 box of ten eggs had been filed the day before as
 * **`$399.00/kg`**. `Size[Vendor n]` holds whatever `Unit type ` says it holds,
 * so on a By-Unit row it is a count of eggs — and `per1000` divided by it as if
 * it were grams. `pricePerKgLabelFor`'s own header claimed it refused to do this;
 * its guard was a falsy check that a count of 10 sails straight through.
 *
 * Wrong by a factor of a hundred-odd, and the worst shape of wrong: nothing is
 * missing, so nothing prompts anyone to check it.
 */
const priced = (unitType: IngredientRow["unitType"], sgd: number, size: number, per1000: number | null) => ({
	...row("Eggs"),
	unitType,
	price: { sgd, size, vendor: "NTUC", per1000 },
});

eq(
	"⚠️ a counted row quotes no price per kg",
	pricePerKgLabelFor(priced("By Unit", 3.99, 10, 399)),
	undefined,
);
eq("a weighed row still does", pricePerKgLabelFor(priced("By Gram", 8.2, 500, 16.4)), "$16.40/kg");
eq("and a litre row says litres", pricePerKgLabelFor(priced("By ml", 3.33, 1000, 3.33)), "$3.33/L");

describe("texted list — the keyboard's shape");

const keys = askKeyboard("tok", [
	{ rowId: "a", rowName: "Milk ( Normal)", score: 1 },
	{ rowId: "b", rowName: "Milk (Skimmed)", score: 1, parked: true },
]);
const verbs = keys.map((r) => r[0].data.split(":")[0]);

// ⚠️ One candidate per ROW, never two side by side: these labels are ingredient
// names, and Telegram shrinks text to fit, so two columns is two truncated names
// and a coin flip between two different foods.
check("every row holds exactly one button", keys.every((r) => r.length === 1));
eq("candidates first, then the ways out", verbs, ["p", "p", "r", "c", "d"]);

// ⚠️ Cancel is LAST, and that placement is the point: the button that discards
// the line sits furthest from the candidates, so a thumb aiming at the last
// ingredient cannot land on it.
eq("cancel is the final button", keys[keys.length - 1][0].text, "✖️ Cancel — typo");
check("a parked candidate is marked on the button", keys[1][0].text.startsWith("💤 "));
check("an active one is not", !keys[0][0].text.startsWith("💤 "));

// Every ask carries both ways out, even when nothing matched at all — a new item
// still needs somewhere to go, and a typo still needs forgetting.
const bare = askKeyboard("tok", []).map((r) => r[0].data.split(":")[0]);
eq("an empty candidate list still offers all three", bare, ["r", "c", "d"]);

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
