import { check, describe, eq } from "./harness.js";
import {
	discountPct,
	parseCurrentPrice,
	resolveExtraProps,
	totals,
	type ListRow,
	parsePerUnitLine,
} from "../core/grocery-page.js";
import { renderListPage } from "../core/grocery-page-render.js";
import { due, lastSgtMidnight, queue, unqueue, type PendingFile } from "../core/list-pending.js";
// @ts-expect-error — the relay is plain ESM with no types; this is the point of testing
// the edge gate and the repo parser against each other rather than trusting they agree.
import { validListAction } from "../../relay/worker.mjs";
import { parseListAction } from "../core/list-action-parse.js";
import { isListHeader, stripListHeader } from "../core/list-parse.js";

/**
 * The shopping page, and the hour before a ticked row leaves Notion.
 *
 * The failures worth guarding here are the quiet ones. A total that silently treats an
 * unpriced row as $0 is a number you would shop against and be wrong by the price of the
 * bananas. A `due()` that says "yes" on an unparseable date is a row destroyed. And the
 * one that actually bit this project's other pages: a column resolver that matches the
 * wrong column when the user renames something, because the names on this database drift
 * constantly and every one of them has a trailing space.
 */

describe("grocery page — reading the user's own columns");

// The live schema, verbatim, as of 2026-09-11. Trailing spaces included: they are real,
// and a resolver that only works on tidied names is a resolver that works on nothing.
const LIVE_SCHEMA: Record<string, { type: string }> = {
	"URL - discount/Cheap ": { type: "url" },
	"Home/Office": { type: "formula" },
	"Price , To Buy ": { type: "number" },
	"Price per kg/L": { type: "rich_text" },
	"Item Name ": { type: "formula" },
	"URL - Current ": { type: "url" },
	"List [Ingredients]": { type: "relation" },
	Tickbox: { type: "checkbox" },
	"Amount ": { type: "number" },
	"Price D%/C": { type: "formula" },
	"Current Price ": { type: "formula" },
	"Vendor %": { type: "rich_text" },
	Name: { type: "title" },
};

const extra = resolveExtraProps(LIVE_SCHEMA);
eq("Price D%/C is found among four formulas", extra.priceDC, "Price D%/C");
eq("…and Current Price is not mistaken for it", extra.currentPriceFormula, "Current Price ");
eq("the discount URL is told from the current one", extra.dealUrl, "URL - discount/Cheap ");
eq("…and the current one from the discount", extra.currentUrl, "URL - Current ");

// ⚠️ `Item Name ` and `Home/Office` are formulas too. A resolver matching "price" alone
// would be a coin toss; one matching "name" would grab the wrong thing entirely.
check(
	"a formula called Item Name is never taken for a price",
	extra.priceDC !== "Item Name " && extra.currentPriceFormula !== "Item Name ",
);

describe("grocery page — the Current Price formula, which the user writes");

eq("price and shop come out of a normal cell", parseCurrentPrice("$3.38 - NTUC"), {
	price: 3.38,
	vendor: "NTUC",
});
eq("a two-word shop survives", parseCurrentPrice("$1.6 - Sheng Siong"), {
	price: 1.6,
	vendor: "Sheng Siong",
});
eq("an empty cell is not a zero price", parseCurrentPrice(""), { price: null, vendor: null });
eq("a bare dash is not a zero price", parseCurrentPrice("-"), { price: null, vendor: null });
// ⚠️ The user owns this formula's wording. Anything unrecognisable must yield nulls, not
// throw and not guess — the row simply carries no baseline.
eq("wording we don't recognise yields nulls", parseCurrentPrice("ask in store"), {
	price: null,
	vendor: null,
});
eq("a price with no shop still gives the price", parseCurrentPrice("$4.20"), {
	price: 4.2,
	vendor: null,
});

describe("grocery page — the two totals");

const row = (over: Partial<ListRow> = {}): ListRow => ({
	pageId: "11111111-1111-1111-1111-111111111111",
	name: "Carrots",
	amount: 1,
	buyPrice: null,
	currentPrice: 2,
	currentVendor: "NTUC",
	dealVendor: null,
	priceDC: "",
	perKg: null,
	currentPerUnit: null,
	dealUrl: null,
	currentUrl: null,
	ticked: false,
	...over,
});

eq(
	"amount multiplies both totals",
	totals([row({ currentPrice: 2, buyPrice: 1.5, amount: 3 })]),
	{ full: 6, discounted: 4.5, unpriced: 0 },
);

// ⚠️⚠️ The one that matters. "Total cost with %" is what the shop costs you today, so an
// UNDISCOUNTED row counts towards it at full price. Summing only the discounted rows
// would make the second figure smaller than the shopping.
eq(
	"an undiscounted row is in BOTH totals, at full price",
	totals([row({ currentPrice: 5, buyPrice: null }), row({ currentPrice: 4, buyPrice: 3 })]),
	{ full: 9, discounted: 8, unpriced: 0 },
);

// ⚠️ Texting "bananas" files a row with no price. Treating that as $0 would be a total
// you could not shop against, so it is excluded and counted.
eq(
	"an unpriced row is in neither total, and is counted",
	totals([row({ currentPrice: null, buyPrice: null }), row({ currentPrice: 3 })]),
	{ full: 3, discounted: 3, unpriced: 1 },
);

eq(
	"a row priced only by its discount still totals",
	totals([row({ currentPrice: null, buyPrice: 2.5, amount: 2 })]),
	{ full: 5, discounted: 5, unpriced: 0 },
);

eq("an empty list totals to zero, not to NaN", totals([]), { full: 0, discounted: 0, unpriced: 0 });

describe("grocery page — the discount badge");

eq("a genuine reduction is a whole percentage", discountPct(row({ currentPrice: 1.6, buyPrice: 0.95 })), 41);
eq("no discount price, no badge", discountPct(row({ buyPrice: null })), null);
// A "discount" that is not cheaper is not a discount, and a badge saying −0% or +12% on
// a shopping list is noise at best.
eq("the same price is not a discount", discountPct(row({ currentPrice: 2, buyPrice: 2 })), null);
eq("a dearer 'discount' is not a discount", discountPct(row({ currentPrice: 2, buyPrice: 2.4 })), null);

describe("grocery page — the rendered page");

const page = renderListPage(
	[
		row({
			pageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			name: "carrots, Normal (1kg)",
			currentPrice: 1.6,
			buyPrice: 0.95,
			dealVendor: "Sheng Siong",
			perKg: "$1.90/kg",
			currentPerUnit: "1.88 /Kg",
			priceDC: "$0.95 / $1.6 - Sheng Siong\n$1.90/kg / 1.88 /Kg - Sheng Siong",
			amount: 2,
		}),
		row({ pageId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Red rice", currentPrice: 5 }),
		// ⚠️ Already ticked in Notion — one of the 16 that existed before this page did.
		row({ pageId: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Old shopping", ticked: true }),
	],
	{ repo: "owner/repo", listEndpoint: "https://relay.example/list", listSecret: "s3cret" },
);

check("the discounted row shows its percentage", page.includes("−41%"));
check("…and where to buy it", page.includes("Sheng Siong"));

// ⚠️⚠️ **One line per PRICE, not one per unit** (user, 2026-09-11). Each line has to
// carry its own price, its own per-unit figure and its own shop, so that "what do I
// normally pay, and where" is a single line rather than one figure off each of two.
const carrots = page.slice(page.indexOf("carrots, Normal"), page.indexOf("Red rice"));
const regular = carrots.slice(carrots.indexOf('class="pl reg"'), carrots.indexOf('class="pl cut"'));
const cut = carrots.slice(carrots.indexOf('class="pl cut"'));

check("the regular line carries the regular price", regular.includes("$1.60"));
check("…its own per-unit figure", regular.includes("1.88 /Kg"));
check("…and its own shop", regular.includes("NTUC"));
// The offer's figures must NOT leak onto the regular line — that was the old layout's fault.
check("…and none of the offer's numbers", !regular.includes("$0.95") && !regular.includes("$1.90/kg"));

check("the discount line carries the offer price", cut.includes("$0.95"));
check("…its own per-unit figure", cut.includes("$1.90/kg"));
check("…the percentage, in the green pill", cut.includes('class="off">−41%'));
check("…and the shop the offer is at", cut.includes("Sheng Siong"));

check("the amount is editable", page.includes('class="amt" type="number"'));
check("the totals are labelled as the user asked", page.includes("Total cost") && page.includes("Total cost with %"));
// 2×0.95 + 5 = 6.90 discounted; 2×1.60 + 5 = 8.20 full. The ticked row is not shopping.
check("the full total counts only what's left to buy", page.includes("$8.20"), page.slice(0, 0));
check("…and so does the discounted total", page.includes("$6.90"));

// ⚠️⚠️ The safety property, asserted on the page as well as in the sweep: a row already
// ticked in Notion is shopping that is DONE. It is not listed, and nothing offers to
// delete it.
check("a row already ticked in Notion is not on the page", !page.includes("Old shopping"));

// ⚠️ **An undiscounted row gets ONE line, not two.** `Price , To Buy ` is frequently equal
// to the regular price, and a second line repeating the same figure under a heading that
// means "offer" is how a page teaches you to stop reading it.
const rice = page.slice(page.indexOf("Red rice"), page.indexOf("Old shopping") + 1 || undefined);
check("an undiscounted row has a regular line", rice.includes('class="pl reg"'));
check("…and no discount line", !rice.includes('class="pl cut"'));
check("…and no percentage", !rice.includes('class="off"'));

// The same price on both sides is not an offer. Fish Sauce ($2.29 / $2.29) is the live case.
const equal = renderListPage([row({ name: "Fish Sauce", currentPrice: 2.29, buyPrice: 2.29 })], {
	repo: "owner/repo",
	listEndpoint: "https://relay.example/list",
	listSecret: "s",
});
check("an offer at the regular price gets no second line", !equal.includes('class="pl cut"'));

describe("the night before a row is cleared");

// ⚠️ Singapore is UTC+8 with no DST, so midnight SGT is 16:00 UTC the day before. The
// boundary has to be computed in SGT, not in the runner's zone: the sweep runs on
// GitHub's UTC machines, where "today" is eight hours behind the user's.
eq(
	"midnight SGT is 16:00 UTC the previous day",
	new Date(lastSgtMidnight(new Date("2026-09-11T12:00:00Z"))).toISOString(),
	"2026-09-10T16:00:00.000Z",
);
// 15:59 UTC is still 23:59 SGT on the 11th — the boundary must not have moved yet.
eq(
	"just before 16:00 UTC the boundary is still the previous midnight",
	new Date(lastSgtMidnight(new Date("2026-09-11T15:59:00Z"))).toISOString(),
	"2026-09-10T16:00:00.000Z",
);
// …and one minute later a new SGT day has begun.
eq(
	"at 16:00 UTC the boundary rolls to tonight",
	new Date(lastSgtMidnight(new Date("2026-09-11T16:00:00Z"))).toISOString(),
	"2026-09-11T16:00:00.000Z",
);

const at = (iso: string, id = "11111111-1111-1111-1111-111111111111") => ({
	pageId: id,
	tickedAt: iso,
	name: "Carrots",
});
// Just after midnight SGT on the 12th — when the sweep actually fires.
const NOW = new Date("2026-09-11T16:00:30Z");
const yesterdayAfternoon = "2026-09-11T06:00:00Z"; // 14:00 SGT on the 11th
const afterMidnight = "2026-09-11T16:00:10Z"; // 00:00:10 SGT on the 12th

const file = (pending: PendingFile["pending"]): PendingFile => ({ v: 1, pending });

eq("a tick from yesterday's shop is cleared", due(file([at(yesterdayAfternoon)]), NOW).due.length, 1);

// ⚠️⚠️ **The reason the boundary is compared against, rather than "clear whatever is
// queued".** A sweep that is delayed or retried would otherwise eat a tick made after
// midnight — on a trip that has already started.
eq("a tick made AFTER midnight survives a late sweep", due(file([at(afterMidnight)]), NOW).due.length, 0);
eq("…and is still waiting for tonight", due(file([at(afterMidnight)]), NOW).waiting.length, 1);

// ⚠️⚠️ A NaN comparison falling through to "due" is a row destroyed by a bad date.
// Erring towards leaving something on a shopping list is free; erring the other way
// is not.
eq("an unparseable date is NEVER due", due(file([at("not a date")]), NOW).due.length, 0);
eq("…and is kept, not dropped", due(file([at("not a date")]), NOW).waiting.length, 1);

// Mid-trip, nothing is cleared — the list stays stable while you are still in the shop.
// This is the behaviour the flat one-hour timer got wrong.
const middayOnTheEleventh = new Date("2026-09-11T04:00:00Z");
eq(
	"nothing clears mid-trip, however long ago it was ticked",
	due(file([at("2026-09-11T00:30:00Z")]), middayOnTheEleventh).due.length,
	0,
);

// Re-ticking must not move the timestamp, or a row re-ticked after midnight would
// survive the sweep that was about to take it.
const first = queue(file([]), at(yesterdayAfternoon));
const again = queue(first, at(afterMidnight));
eq("re-ticking does not add a second entry", again.pending.length, 1);
eq("…and does not move the timestamp", again.pending[0].tickedAt, yesterdayAfternoon);

eq("undo takes the row off the queue", unqueue(first, "11111111-1111-1111-1111-111111111111").pending, []);
eq(
	"…and leaves everyone else's alone",
	unqueue(file([at(yesterdayAfternoon), at(afterMidnight, "22222222-2222-2222-2222-222222222222")]), "11111111-1111-1111-1111-111111111111")
		.pending.length,
	1,
);

describe("a tap arriving from the browser");

eq("a tick parses", parseListAction({ v: 1, op: "tick", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" }), {
	v: 1,
	op: "tick",
	pageId: "3d469a18-4fe7-802f-8620-000b6053908d",
	amount: undefined,
});
eq(
	"an amount is rounded to a whole number of things",
	parseListAction({ v: 1, op: "amount", pageId: "3d469a18-4fe7-802f-8620-000b6053908d", amount: 2.6 }).amount,
	3,
);

const rejects = (label: string, raw: unknown) => {
	let threw = false;
	try {
		parseListAction(raw);
	} catch {
		threw = true;
	}
	check(label, threw);
};

// ⚠️ These arrive from a browser over `repository_dispatch` and go straight into a write
// path. A bad op must fail loudly rather than fall through to a no-op reporting success.
rejects("an unknown op is refused", { v: 1, op: "delete", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" });
rejects("a non-Notion page id is refused", { v: 1, op: "tick", pageId: "../../etc/passwd" });
rejects("an empty page id is refused", { v: 1, op: "tick", pageId: "" });
rejects("amount with no number is refused", { v: 1, op: "amount", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" });
rejects("a zero amount is refused", {
	v: 1,
	op: "amount",
	pageId: "3d469a18-4fe7-802f-8620-000b6053908d",
	amount: 0,
});

describe("the relay's own gate on /list");

// ⚠️ The relay turns an anonymous POST into a GitHub Actions run, so a malformed one is
// refused at the edge. Forwarding it would spend a run to learn the same thing.
eq("a tick is accepted", validListAction({ op: "tick", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" }), null);
eq(
	"an amount is accepted",
	validListAction({ op: "amount", pageId: "3d469a18-4fe7-802f-8620-000b6053908d", amount: 2 }),
	null,
);
check("a made-up op is refused", validListAction({ op: "drop", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" }) !== null);
check("a non-Notion id is refused", validListAction({ op: "tick", pageId: "'; DROP TABLE" }) !== null);
check("a missing id is refused", validListAction({ op: "tick" }) !== null);
check("a zero amount is refused", validListAction({ op: "amount", pageId: "3d469a18-4fe7-802f-8620-000b6053908d", amount: 0 }) !== null);
check("a non-object is refused", validListAction(null) !== null);

// ⚠️ The edge gate and the repo-side parser must agree, or a tap accepted by one and
// refused by the other spends an Actions run to fail.
const bothAgree = (raw: unknown) => {
	const edge = validListAction(raw) === null;
	let repo = true;
	try {
		parseListAction(raw);
	} catch {
		repo = false;
	}
	return edge === repo;
};
check("edge and repo agree on a good tick", bothAgree({ v: 1, op: "tick", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" }));
check("…and on a bad op", bothAgree({ v: 1, op: "nope", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" }));
check("…and on a bad id", bothAgree({ v: 1, op: "tick", pageId: "nope" }));

describe("a page built with no list endpoint");

// ⚠️ `npm run build-list` with an empty `.env` is the ordinary way to reach this. Controls
// that look live and silently drop every tick are worse than controls that plainly cannot.
const readOnly = renderListPage([row({ name: "Carrots", currentPrice: 2 })], {
	repo: "owner/repo",
	listEndpoint: "https://relay.example/list",
});
check("the checkbox is disabled in the markup", readOnly.includes('type="checkbox" disabled'));
check("the amount box is disabled too", readOnly.includes('value="1" disabled'));
check("the page says it cannot save", readOnly.includes("Read-only"));
check("no script is emitted at all", !readOnly.includes("<script>"));

// ⚠️⚠️ The secret is in the live page by design — but it must never leak into a build
// that was not given one, as `X-List-Secret: undefined`.
check("…and no secret header is shipped", !readOnly.includes("X-List-Secret"));
check("the live page DOES carry its secret", page.includes("X-List-Secret") && page.includes("s3cret"));

describe("the per-unit figures, read out of the user's formula");

// The live shape, verbatim from the real database.
eq(
	"both figures come out of a normal second line",
	parsePerUnitLine("$0.95 / $1.6 - Sheng Siong\n$1.90/kg / 1.88 /Kg - Sheng Siong"),
	{ discount: "$1.90/kg", current: "1.88 /Kg" },
);

// ⚠️⚠️ The one that forces the spaced-slash split. Both figures contain a slash of their
// own, so splitting on "/" alone shreds them — "$25.00/kg" would become "$25.00" and "kg".
eq(
	"a per-unit figure's own slash survives",
	parsePerUnitLine("$1.5 / $3.38 - NTUC\n$25.00/kg / 2.82 /10 pc - NTUC"),
	{ discount: "$25.00/kg", current: "2.82 /10 pc" },
);

// The unpriced row (Cutting Board) — no figures anywhere, and it must not invent any.
eq("a line of dashes yields nulls", parsePerUnitLine("- / N/A -\n- / -"), {
	discount: null,
	current: null,
});
eq("a one-line formula yields nulls", parsePerUnitLine("$2 / $3 - NTUC"), {
	discount: null,
	current: null,
});
eq("an empty formula yields nulls", parsePerUnitLine(""), { discount: null, current: null });

// ⚠️ The user owns this formula. Wording we don't recognise must yield nulls, not a guess —
// one grey figure missing on one row, rather than a wrong number presented as a fact.
eq("an unrecognisable second line yields nulls", parsePerUnitLine("a\nno separator here"), {
	discount: null,
	current: null,
});

// Only the LAST segment carries the shop, and stripping it must not eat a figure.
eq("the trailing shop is stripped, the figure is not", parsePerUnitLine("x\n$4/kg / $5/kg - Sheng Siong"), {
	discount: "$4/kg",
	current: "$5/kg",
});

describe("a header line that declares a shopping list");

// The four the user named, plus the plurals and the bare words that mean the same.
for (const h of ["grocery", "grocery list", "shopping list", "to buy", "Grocery List", "TO BUY", "groceries"]) {
	check(`"${h}" is a header`, isListHeader(h));
}
check("a trailing colon is the user's punctuation, not part of the word", isListHeader("Grocery list:"));
check("…and a bullet is decoration", isListHeader("- shopping list"));

// ⚠️⚠️ **Matched as a WHOLE line, never as a prefix.** A `startsWith` would swallow the
// first real item — the quietest possible bug, because everything else still files and
// the reply looks cheerful.
check("'grocery bags' is an item, not a header", !isListHeader("grocery bags"));
check("'to buy milk' is an item, not a header", !isListHeader("to buy milk"));
check("'shopping list for mum' is an item", !isListHeader("shopping list for mum"));

eq(
	"a declared list drops the header and keeps the items",
	stripListHeader("grocery list\n2kg chicken breast\nbananas x6").items.map((i) => i.name),
	["chicken breast", "bananas"],
);
eq("…and reports that it was declared", stripListHeader("grocery list\nmilk").declared, true);

// The comma form, which is how a one-line message is split.
eq(
	"a comma-separated list drops its header too",
	stripListHeader("To buy, milk, eggs").items.map((i) => i.name),
	["milk", "eggs"],
);

// ⚠️ An undeclared list must be untouched — plain text was always a shopping list here,
// and this feature must not change what gets written, only what the reply says.
const plain = stripListHeader("2kg chicken breast\nbananas x6");
eq("an undeclared list keeps every line", plain.items.map((i) => i.name), ["chicken breast", "bananas"]);
eq("…and is not marked declared", plain.declared, false);

// ⚠️ A header with nothing under it is "show me the list", not an empty write.
eq("a bare header declares with no items", stripListHeader("grocery list").items.length, 0);
eq("…and is still declared", stripListHeader("grocery list").declared, true);

describe("adding an item from the page");

const addOk = (raw: unknown) => {
	try {
		return parseListAction(raw);
	} catch (e: any) {
		return e.message as string;
	}
};

eq(
	"an ingredient-backed add parses",
	addOk({ v: 1, op: "add", ingredientId: "3d469a18-4fe7-802f-8620-000b6053908d", name: "Carrots" }),
	{
		v: 1,
		op: "add",
		pageId: "",
		name: "Carrots",
		ingredientId: "3d469a18-4fe7-802f-8620-000b6053908d",
		amount: 1,
	},
);

// ⚠️ A free-typed item with no match is legitimate — it is what texting an unknown item
// does. Refusing it would make the box worse than the chat.
eq("a free-typed add with no ingredient parses", addOk({ v: 1, op: "add", name: "harissa paste" }), {
	v: 1,
	op: "add",
	pageId: "",
	name: "harissa paste",
	ingredientId: undefined,
	amount: 1,
});

// ⚠️ `add` has no pageId — it is creating the row. Demanding one would make the shared
// payload shape reject the only op that cannot have it.
check("add needs no pageId", typeof addOk({ v: 1, op: "add", name: "x" }) !== "string");

check("add with no name is refused", typeof addOk({ v: 1, op: "add" }) === "string");
check("add with a blank name is refused", typeof addOk({ v: 1, op: "add", name: "   " }) === "string");
// A garbage id must never reach a relation write.
check(
	"add with a non-Notion ingredientId is refused",
	typeof addOk({ v: 1, op: "add", name: "x", ingredientId: "../../etc" }) === "string",
);
check(
	"an absurdly long name is refused",
	typeof addOk({ v: 1, op: "add", name: "x".repeat(500) }) === "string",
);

// The edge gate and the repo parser must still agree, now across four ops.
check("edge and repo agree on a good add", bothAgree({ v: 1, op: "add", name: "Carrots" }));
check("…and on a nameless add", bothAgree({ v: 1, op: "add" }));
check(
	"…and on a bad ingredientId",
	bothAgree({ v: 1, op: "add", name: "x", ingredientId: "nope" }),
);

describe("the Add box on the page");

check("a live page has the Add box", page.includes('id="addbox"'));
check("…and somewhere to put the matches", page.includes('id="hits"'));
check("…and fetches the ingredient index", page.includes("ingredients.json"));

// ⚠️ A read-only page must not offer a box that cannot write.
check("a read-only page has no Add box", !readOnly.includes('id="addbox"'));
