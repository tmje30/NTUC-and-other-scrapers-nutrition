import {
	CANDIDATE_MARGIN,
	MAX_CANDIDATES,
	candidatesFor,
	decideItem,
	pricePerKgLabelFor,
	rankRows,
	type IngredientRow,
} from "../core/list-intake.js";
import { parseItem } from "../core/list-parse.js";
import { askKeyboard, newIngredientFields, unitTypeFor } from "../core/tg-inbox.js";
import { parseName } from "../core/parse.js";
import { packWeightOf } from "../core/notion.js";
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

/**
 * ⚠️ **The re-search tranche is gone** (2026-08-11, by request — the button was
 * judged redundant against the candidates already on the keyboard). What used to
 * be a safety net under `candidatesFor` is now nothing, so these cases guard the
 * only offer there is: it must not be empty when a plausible row exists, and it
 * must not run past the keyboard's size.
 */
describe("texted list — the one offer is the whole offer");

const first = candidatesFor("milk", ROWS);

check("a plausible query still offers something", first.length > 0);
check("and never more than a keyboard's worth", first.length <= MAX_CANDIDATES);
check("best first", first.every((m, i) => i === 0 || m.score <= first[i - 1].score));

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
const priced = (
	unitType: IngredientRow["unitType"],
	sgd: number,
	size: number,
	extra: { per1000?: number | null; perPiece?: number | null } = {},
): IngredientRow => ({
	...row("Eggs"),
	unitType,
	price: { sgd, size, vendor: "NTUC", per1000: extra.per1000 ?? null, perPiece: extra.perPiece ?? null },
});

// The real box: $3.99 for 10, and "(550g)" in the row's own name.
eq(
	"⚠️ a counted row quotes its WEIGHT-based price, not its count-based one",
	pricePerKgLabelFor(priced("By Unit", 3.99, 10, { per1000: (3.99 / 550) * 1000, perPiece: 0.399 })),
	"$7.25/kg",
);
// ⚠️ Quoted per TEN pieces, matching Notion's own `Cheapest Price/Kg ` formula,
// which prints "4.2 /10 pc" on these rows. Two conventions for one figure sitting
// in two databases is where someone later assumes a factor of ten.
eq(
	"…and per 10 pieces when nothing states a weight",
	pricePerKgLabelFor(priced("By Unit", 3.99, 10, { perPiece: 0.399 })),
	"$3.99/10 pc",
);
eq(
	"…so a box of 30 at the same unit price reads the same",
	pricePerKgLabelFor(priced("By Unit", 11.97, 30, { perPiece: 0.399 })),
	"$3.99/10 pc",
);
check(
	"⚠️ never the count-as-grams answer that produced $399.00/kg",
	pricePerKgLabelFor(priced("By Unit", 3.99, 10, { perPiece: 0.399 })) !== "$399.00/kg",
);
eq("a weighed row is unchanged", pricePerKgLabelFor(priced("By Gram", 8.2, 500, { per1000: 16.4 })), "$16.40/kg");
eq("and a litre row says litres", pricePerKgLabelFor(priced("By ml", 3.33, 1000, { per1000: 3.33 })), "$3.33/L");
eq("a row with no price at all says nothing", pricePerKgLabelFor(row("Eggs")), undefined);

// ⚠️ The rule that feeds the figures above, shared with `readGroceryTargets` so
// the deal comparison and the texted list cannot disagree about what a pack weighs.
eq("a weighed row's pack weight IS its size", packWeightOf("By Gram", 500, "Peanut Butter", ""), 500);
// ⚠️ The shop's own wording wins, because it comes from the SAME slot as the
// price and the size — one pack, one shop. The row `Name` is global across all
// four slots, so it is the fallback, not the first answer.
eq(
	"a counted row reads the shop's wording first",
	packWeightOf("By Unit", 10, "Bread, Wholemeal (600g)", "Gardenia Wholemeal 400g"),
	400,
);
eq("…and falls back to the row's own Name", packWeightOf("By Unit", 10, "egg  (Omega 3 Enriched) (550g)", ""), 550);
eq(
	"…including when the shop's wording states no size at all",
	packWeightOf("By Unit", 10, "Bread, Wholemeal (600g)", "Gardenia Wholemeal Bread"),
	600,
);
eq(
	"⚠️ and null when neither says — sold by the piece, not a gap to fill",
	packWeightOf("By Unit", 4, "Razor Cartridge Refill - Hydro 5 [Schick]", ""),
	null,
);

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
// ⚠️ No "r" — the re-search button was removed on 2026-08-11 as redundant. Its
// absence is asserted, not merely unmentioned: it is the kind of button that
// gets re-added by a well-meaning edit, and it would then offer rows the
// keyboard has already been decided against.
eq("candidates first, then the two ways out", verbs, ["p", "p", "c", "d"]);

// ⚠️ Cancel is LAST, and that placement is the point: the button that discards
// the line sits furthest from the candidates, so a thumb aiming at the last
// ingredient cannot land on it.
eq("cancel is the final button", keys[keys.length - 1][0].text, "✖️ Cancel — typo");
check("a parked candidate is marked on the button", keys[1][0].text.startsWith("💤 "));
check("an active one is not", !keys[0][0].text.startsWith("💤 "));

// Every ask carries both ways out, even when nothing matched at all — a new item
// still needs somewhere to go, and a typo still needs forgetting.
const bare = askKeyboard("tok", []).map((r) => r[0].data.split(":")[0]);
eq("an empty candidate list still offers both", bare, ["c", "d"]);

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
