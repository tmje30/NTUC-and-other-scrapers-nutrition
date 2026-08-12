// ⚠️ Set BEFORE the sweep runs, never mind the `.env` this machine may have: the
// suite must behave identically on a laptop with real credentials and in CI with
// none. Imports are hoisted above these lines, which is harmless — `config` reads
// the environment lazily, at call time.
process.env.TELEGRAM_CHAT_ID = "7626546412";
process.env.TELEGRAM_BOT_TOKEN = "test-token";

import {
	ASK_TTL_MS,
	expiredAsks,
	sweepExpiredAsks,
	type InboxState,
} from "../core/tg-inbox.js";
import { check, describe, eq } from "./harness.js";

/**
 * The one-hour auto-file: a question nobody answers becomes a grocery-list row.
 *
 * Asked for by the user on 2026-08-12 — *"if nothing is picked within an hour the
 * items get added to the grocery list no matter, without the item being searched
 * for in 'List [Ingredients]'… without adding an item into 'Ingredient' DB"*.
 *
 * ⚠️ **Two failures are worth more than all the rest, and both are silent.** One is
 * the timeout firing when it shouldn't — filing an item seconds after asking about
 * it, which writes a Notion row the user never agreed to and looks like the bot
 * ignoring the buttons it just drew. The other is the write carrying an Ingredients
 * relation anyway: the row would then quote a price from a row the user never
 * picked, which is fault 28 (the wrong-row link) arriving through a door nobody is
 * watching. The suite is built around those two.
 */
describe("telegram inbox — the one-hour clock");

const ITEM = { raw: "Bread x 1", name: "Bread", count: 1, amountG: null, volumetric: false };

const ask = (askedAt: unknown, over: Record<string, unknown> = {}) =>
	({
		item: ITEM,
		candidates: [{ rowId: "row-1", rowName: "Bread, Wholemeal", score: 0.8 }],
		messageId: 37,
		chatId: 7626546412,
		blocking: true,
		askedAt,
		...over,
	}) as any;

const NOW = Date.parse("2026-08-12T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

eq("59 minutes is still the user's question", expiredAsks({ a: ask(ago(59 * 60_000)) }, NOW).expired, []);
// ⚠️ The boundary is inclusive. "Within an hour" was the ask, so an hour exactly is
// up — and an off-by-one here would be invisible for the fifteen minutes until the
// next sweep, which is precisely why it is pinned.
eq("an hour exactly is up", expiredAsks({ a: ask(ago(ASK_TTL_MS)) }, NOW).expired, ["a"]);
eq("and anything older", expiredAsks({ a: ask(ago(3 * 60 * 60_000)) }, NOW).expired, ["a"]);
eq("the hour is sixty minutes", ASK_TTL_MS, 3_600_000);

// ⚠️ A missing timestamp is an UNKNOWN age, not an old one. A state file written
// before 2026-08-12 carries no `askedAt`, and reading that as "expired" would file
// every open question the moment this shipped — including one the user was looking
// at. It starts the clock instead.
const legacy = expiredAsks({ a: ask(undefined) }, NOW);
eq("an ask with no timestamp is not filed", legacy.expired, []);
eq("…its clock is started instead", legacy.unstamped, ["a"]);
eq("garbage is treated the same way", expiredAsks({ a: ask("not a date") }, NOW).unstamped, ["a"]);

// Each question keeps its own clock — a fresh one must not be swept along with an
// old one just because they share a state file.
const mixed = expiredAsks({ old: ask(ago(2 * 60 * 60_000)), fresh: ask(ago(60_000)) }, NOW);
eq("only the old one expires", mixed.expired, ["old"]);

describe("telegram inbox — what the auto-file writes");

/** The live grocery List schema (2026-08-11), including the relation we must NOT write. */
const SCHEMA = {
	Name: { type: "title" },
	"Price , To Buy ": { type: "number" },
	"Current Price ": { type: "formula" },
	"Amount ": { type: "number" },
	Tickbox: { type: "checkbox" },
	"Vendor %": { type: "rich_text" },
	"Price per kg/L": { type: "rich_text" },
	"List [Ingredients]": { type: "relation" },
};

const created: any[] = [];
const notion = {
	dataSources: {
		retrieve: async () => ({ properties: SCHEMA }),
		// Nothing already on the list, so every write is a create rather than an
		// `Amount ` bump — the create is what carries the properties being asserted on.
		query: async () => ({ results: [] }),
	},
	pages: {
		create: async (args: any) => {
			created.push(args);
			return { id: "page-new" };
		},
		update: async () => ({}),
	},
} as any;

/** Every Bot API call the sweep makes, in order, with its body. */
const sent: { method: string; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
	sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body) });
	return {
		ok: true,
		text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }),
	};
}) as any;

const CARROTS = { raw: "Carrots x 1kg", name: "Carrots", count: 1, amountG: 1000, volumetric: false };

const state: InboxState = {
	offset: 0,
	pending: {
		aaa: ask(ago(2 * 60 * 60_000)), // blocking near-miss, never queued
		bbb: ask(ago(90 * 60_000), { item: CARROTS, blocking: false }), // "new", queued
		ccc: ask(ago(60_000)), // asked a minute ago
	},
	// ⚠️ The non-blocking ask's item is on the pricing queue, because that is what
	// "I'll price it at the shops either way" meant when the question was asked.
	queue: [CARROTS],
};

const result = await sweepExpiredAsks({ notion }, state, NOW);

eq("both expired questions are filed", result.filed.sort(), ["aaa", "bbb"]);
eq("the fresh one is left alone", Object.keys(state.pending), ["ccc"]);
eq("two rows were written", created.length, 2);

const props = created.map((c) => c.properties);
eq("the name is the typed one", props[0].Name.title[0].text.content, "Bread");
// The size the user typed still reaches the row — it is part of what they wrote,
// not a guess about which ingredient they meant.
eq("…with the size they stated", props[1].Name.title[0].text.content, "Carrots (1kg)");
eq("the count lands in Amount", props[0]["Amount "].number, 1);

// ⚠️ **The point of the whole feature.** No relation, and therefore no Ingredients
// row invented to point at: the user asked for the name copied across and nothing
// else. A price or vendor here would be quoting a row nobody picked.
check("no Ingredients relation is written", props.every((p) => !("List [Ingredients]" in p)));
check("no price is written", props.every((p) => !("Price , To Buy " in p)));
check("no vendor is written", props.every((p) => !("Vendor %" in p)));

// ⚠️ A queued item stays queued. Filing the row is not pricing it, and dropping it
// here would mean the shop comparison it was promised never happens.
eq("the queued item is still queued", state.queue.length, 1);

const methods = sent.map((s) => s.method);
eq("each question is settled in place, then one summary", methods, [
	"editMessageText",
	"editMessageText",
	"sendMessage",
]);
// ⚠️ The edit must carry NO reply_markup — a live keyboard on a settled question is
// a tap that writes the item a second time.
check("the buttons are gone", sent.slice(0, 2).every((s) => !s.body.reply_markup));
check("the edit says why", sent[0].body.text.includes("No answer in an hour"));

const summary = sent[2].body.text;
check("the summary counts them", summary.includes("2 questions"));
check("…names both items", summary.includes("Bread") && summary.includes("Carrots"));
// The user has to know the row is unlinked, or they will wonder why it has no price.
check("…says the rows are unlinked", summary.includes("no Ingredients link"));
check("…and that nothing reached the Ingredients DB", summary.includes("nothing was added"));
check("…and that the queued one is still coming", summary.includes("queued for a shop price"));

describe("telegram inbox — when the auto-file cannot write");

created.length = 0;
sent.length = 0;

const broken = {
	dataSources: { retrieve: async () => ({ properties: SCHEMA }), query: async () => ({ results: [] }) },
	pages: {
		create: async () => {
			throw new Error("Notion is down");
		},
	},
} as any;

const failing: InboxState = { offset: 0, pending: { zzz: ask(ago(ASK_TTL_MS)) }, queue: [] };
const failed = await sweepExpiredAsks({ notion: broken }, failing, NOW);

// ⚠️ The question is retired even though the write failed — the same choice
// `handleCallback` makes. A structural failure fails identically on the next sweep,
// and a question that re-tries every fifteen minutes for ever is a worse outcome
// than one ❌ in the chat.
eq("a failed write still retires the question", Object.keys(failing.pending), []);
eq("…and is still reported as filed", failed.filed, ["zzz"]);
check("the failure is visible in the chat", sent.some((s) => s.body.text?.includes("Notion is down")));
check("…with an ❌, not a ✅", !sent[0].body.text.includes("✅"));

describe("telegram inbox — a sweep with nothing to do");

sent.length = 0;
created.length = 0;

const quiet: InboxState = { offset: 0, pending: { ccc: ask(ago(60_000)) }, queue: [] };
const nothing = await sweepExpiredAsks({ notion }, quiet, NOW);
eq("nothing is filed", nothing.filed, []);
// It runs every fifteen minutes: a sweep that finds nothing must cost no Notion
// write and no message, or the chat becomes unreadable and the run costs money.
eq("…and nothing is sent", sent.length, 0);
eq("…and nothing is written", created.length, 0);

// A legacy ask is stamped in place, so the NEXT sweep an hour later can act on it.
const stampMe: InboxState = { offset: 0, pending: { old: ask(undefined) }, queue: [] };
const stamped = await sweepExpiredAsks({ notion }, stampMe, NOW);
eq("the legacy ask is stamped", stamped.stamped, 1);
eq("…with now", stampMe.pending.old.askedAt, new Date(NOW).toISOString());
eq("…and not filed", stamped.filed, []);
// An hour after being stamped, it goes the ordinary way.
eq("…so an hour later it files", expiredAsks(stampMe.pending, NOW + ASK_TTL_MS).expired, ["old"]);

globalThis.fetch = realFetch;
