import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, type InboxState } from "../core/tg-inbox.js";
import { DATA_FILES, mergeDataFile } from "../core/merge-data.js";
import { check, describe, eq } from "./harness.js";

/**
 * The inbox's state file, once it stopped being machine-local.
 *
 * ⚠️ **Everything here guards one class of failure: a question the user answers
 * into the void.** In the webhook flow there is no process to hold state — every
 * update is a fresh Actions run on a fresh checkout — so an ask that does not
 * survive the file round-trip, or that a merge drops, produces a chat where the
 * buttons are live, the tap is acknowledged, and nothing is ever written. That is
 * fault 29 with a different cause, and it looks identical from the sofa.
 */
describe("telegram inbox state — the committed file");

const ITEM = { raw: "Bread x 1", name: "Bread", count: 1, amountG: null, volumetric: false };

const ASK = {
	item: ITEM,
	candidates: [{ rowId: "row-1", rowName: "Bread, Wholemeal", score: 1 }],
	messageId: 37,
	chatId: 7626546412,
	blocking: true,
};

const dir = await mkdtemp(join(tmpdir(), "tg-state-"));
const path = join(dir, "tg-inbox-state.json");

const state: InboxState = { offset: 42, pending: { smq24g: ASK }, queue: [ITEM] };
await writeState(state, path);
const back = await readState(path);

eq("an ask survives the round trip", back.pending.smq24g, ASK);
eq("the queue survives", back.queue, [ITEM]);
eq("the offset survives", back.offset, 42);

const onDisk = JSON.parse(await readFile(path, "utf8"));
// ⚠️ An ARRAY on disk, keyed by a `token` field — because the only merger this
// project has works on lists, and this is the file that collides most.
check("asks are stored as a list, not a map", Array.isArray(onDisk.asks));
eq("…with the token moved into the entry", onDisk.asks[0].token, "smq24g");
eq("…and it merges under a rule", DATA_FILES["tg-inbox-state.json"].length, 2);
// It lands in git, so it must be diffable.
check("the file is pretty-printed", (await readFile(path, "utf8")).includes("\n  "));
check("…and has an updatedAt for the merger to compare", typeof onDisk.updatedAt === "string");

// ⚠️ The ORIGINAL map shape is still read. The laptop poller's live
// `.sessions/tg-inbox.json` is in it, and a reader that silently forgot every
// outstanding question on upgrade would strand whatever was on screen at the time.
const legacyPath = join(dir, "legacy.json");
await writeFile(legacyPath, JSON.stringify({ offset: 7, pending: { old1: ASK }, queue: [ITEM] }), "utf8");
const legacy = await readState(legacyPath);
eq("the old map shape still loads", legacy.pending.old1, ASK);
eq("…with its offset", legacy.offset, 7);

const missing = await readState(join(dir, "nope.json"));
eq("a missing file is an empty state, never a crash", missing, { offset: 0, pending: {}, queue: [] });

describe("telegram inbox state — two runs at once");

/** The stored shape, as `writeState` produces it. */
const file = (asks: { token: string }[], queue: { raw: string }[], updatedAt = "a") => ({
	version: 1,
	updatedAt,
	offset: 0,
	asks,
	queue,
});

const A = { token: "aaa", ...ASK };
const B = { token: "bbb", ...ASK };

// The ordinary collision: two taps land seconds apart, each answering a different
// question. Both answers must stick.
const twoTaps = mergeDataFile(
	"tg-inbox-state.json",
	file([A, B], []),
	file([B], [], "mine"), // I answered A
	file([A], [], "theirs"), // they answered B
) as any;
eq("two questions answered at once are both gone", twoTaps.asks.length, 0);

// ⚠️ The failure that matters most, and the reason this is a merge and not a union:
// a union would put the answered question back on screen with live buttons.
const answered = mergeDataFile(
	"tg-inbox-state.json",
	file([A], []),
	file([], [], "mine"), // I answered A
	file([A], [], "theirs"), // they only added an item
) as any;
check("an answered question does not come back", !answered.asks.some((x: any) => x.token === "aaa"));

// A new question raised while another run was working must survive.
const newAsk = mergeDataFile(
	"tg-inbox-state.json",
	file([], []),
	file([A], [], "mine"),
	file([B], [], "theirs"),
) as any;
eq("a question raised by each run survives", newAsk.asks.length, 2);

// The queue is identified by the raw line the user typed — the same identity
// `handleCallback` uses when a "new" item turns out to be a known one.
const drained = mergeDataFile(
	"tg-inbox-state.json",
	file([], [{ raw: "harissa paste" }, { raw: "kefir" }]),
	file([], [{ raw: "kefir" }], "mine"), // the laptop priced harissa
	file([], [{ raw: "harissa paste" }, { raw: "kefir" }, { raw: "tahini" }], "theirs"),
) as any;
eq("a priced item leaves the queue", drained.queue.length, 2);
check("…and an item queued meanwhile stays", drained.queue.some((q: any) => q.raw === "tahini"));

describe("vendor review — merged now that taps land in the cloud");

const R = (url: string, extra: Record<string, unknown> = {}) => ({
	ingredientId: "ing-1",
	vendor: "Guardian",
	url,
	...extra,
});

const reviews = mergeDataFile(
	"vendor-review.json",
	{ version: 1, updatedAt: "a", pending: [{ token: "t1" }, { token: "t2" }], rejected: [] },
	{ version: 1, updatedAt: "mine", pending: [{ token: "t2" }], rejected: [R("/a")] },
	{ version: 1, updatedAt: "theirs", pending: [{ token: "t1" }], rejected: [R("/b")] },
) as any;
eq("both answered review cards are gone", reviews.pending.length, 0);
eq("both refusals are kept", reviews.rejected.length, 2);

// ⚠️ (ingredient, vendor, product) — refusing one pack at Guardian is not refusing
// Guardian, and keying on the vendor alone would collapse the two into one.
const twoPacks = mergeDataFile(
	"vendor-review.json",
	{ version: 1, updatedAt: "a", pending: [], rejected: [] },
	{ version: 1, updatedAt: "mine", pending: [], rejected: [R("/small"), R("/large")] },
	{ version: 1, updatedAt: "theirs", pending: [], rejected: [] },
) as any;
eq("two packs from one shop are two refusals", twoPacks.rejected.length, 2);

// A listing with no URL falls back to store + name, exactly as `isRejectedPick` does.
const noUrl = mergeDataFile(
	"vendor-review.json",
	{ version: 1, updatedAt: "a", pending: [], rejected: [] },
	{
		version: 1,
		updatedAt: "mine",
		pending: [],
		rejected: [R("", { store: "Carousell", product: "whey 1kg" }), R("", { store: "Carousell", product: "whey 2kg" })],
	},
	{ version: 1, updatedAt: "theirs", pending: [], rejected: [] },
) as any;
eq("an unlinked listing is identified by store and name", noUrl.rejected.length, 2);
