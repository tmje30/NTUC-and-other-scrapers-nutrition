import { mergeDataFile, mergeList } from "../core/merge-data.js";
import { check, describe, eq } from "./harness.js";

/**
 * The three-way merge that stops two overlapping button presses losing one of them.
 *
 * ⚠️ Every failure here is silent by construction. The workflow that uses this has
 * already told the user "✓ ignored" by the time it runs; if the merge drops an
 * entry, resurrects a removed one, or keeps only one side of a collision, nothing
 * errors and nothing is logged — the correction simply is not there days later.
 * That is the same family as the 32 g serving read as 100 g, and it is why the
 * cases below check the *other* run's entry survives as carefully as they check
 * mine does.
 */
describe("merge-data — the three-way rule");

const id = (e: Record<string, unknown>) => String(e.k);
const E = (k: string, extra: Record<string, unknown> = {}) => ({ k, ...extra });

// The ordinary case: two runs each appended a different entry.
const bothAdded = mergeList([E("a")], [E("a"), E("mine")], [E("a"), E("theirs")], id);
eq("both additions survive", bothAdded.length, 3);
check("theirs is kept", bothAdded.some((e) => e.k === "theirs"));
check("mine is kept", bothAdded.some((e) => e.k === "mine"));

// ⚠️ The reason a plain union is wrong. `reset` and `never-buy` REMOVE entries; a
// union would put back exactly what someone just asked to be taken away.
const iRemoved = mergeList([E("a"), E("b")], [E("a")], [E("a"), E("b"), E("theirs")], id);
check("what I removed stays removed", !iRemoved.some((e) => e.k === "b"));
check("and their addition is untouched", iRemoved.some((e) => e.k === "theirs"));

// A removal upstream is equally binding on me — I never touched it, so I have no
// opinion, and re-adding it would undo their reset.
const theyRemoved = mergeList([E("a"), E("b")], [E("a"), E("b"), E("mine")], [E("a")], id);
check("what THEY removed stays removed", !theyRemoved.some((e) => e.k === "b"));
check("mine still lands", theyRemoved.some((e) => e.k === "mine"));

// Same identity, both edited: mine is the later intent, so mine wins — but exactly
// once, not twice.
const collision = mergeList([E("a", { v: 0 })], [E("a", { v: 1 })], [E("a", { v: 2 })], id);
eq("a collision yields one entry", collision.length, 1);
eq("and mine is the one kept", collision[0].v, 1);

// Untouched by me: theirs must not be clobbered by my stale copy of it.
const untouched = mergeList([E("a", { v: 0 })], [E("a", { v: 0 })], [E("a", { v: 9 })], id);
eq("their edit to something I did not touch stands", untouched[0].v, 9);

// Merging is not reshuffling — a file that reorders itself on every collision is
// a file whose diffs stop being readable.
const order = mergeList([], [E("m1"), E("m2")], [E("t1"), E("t2")], id);
eq("theirs keep their order, mine follow", order.map((e) => e.k).join(","), "t1,t2,m1,m2");

describe("merge-data — real files");

/**
 * A replay of the collision that actually happened at 06:17–06:19 on 2026-08-05,
 * with the shapes those runs really wrote: one run banned a word for Instant
 * Coffee while another blocked a product outright. Under the old `git pull
 * --rebase` this is precisely the pair that conflicted and lost a correction.
 */
const base = { version: 1, updatedAt: "2026-08-03T00:54:34.769Z", terms: [], products: [] };

const mine = {
	version: 1,
	updatedAt: "2026-08-05T06:17:26.000Z",
	terms: [],
	products: [
		{
			key: "*",
			store: "FairPrice",
			product: "Nescafe Instant Ipoh White Coffee - Gao Siew Dai",
			url: "https://www.fairprice.com.sg/product/nescafe-ipoh-white",
			name: "Instant Coffee (plain)",
			note: "ignored from the deals page",
			addedAt: "2026-08-05T06:17:26.000Z",
		},
	],
};

const theirs = {
	version: 1,
	updatedAt: "2026-08-05T06:17:38.121Z",
	terms: [
		{
			key: "instant coffe",
			term: "white",
			name: "Instant Coffee (plain)",
			product: "Nescafe Instant Ipoh White Coffee - Gao Siew Dai",
			addedAt: "2026-08-05T06:17:38.121Z",
		},
	],
	products: [],
};

const out = mergeDataFile("exclusions.json", base, mine, theirs) as any;
eq("the banned word survives", out.terms.length, 1);
eq("and so does the blocked product", out.products.length, 1);
eq("the word is theirs", out.terms[0].term, "white");
eq("the product is mine", out.products[0].product, "Nescafe Instant Ipoh White Coffee - Gao Siew Dai");
eq("updatedAt takes the later of the two", out.updatedAt, "2026-08-05T06:17:38.121Z");
eq("version is carried through", out.version, 1);

// ⚠️ Two Ignore-for-good presses on DIFFERENT products both key on `*`. If the
// identity were the key alone they would collide and one would be lost — which is
// the second of the three corrections that went missing that morning.
const twoStars = mergeDataFile(
	"exclusions.json",
	base,
	{
		...mine,
		products: [
			{ ...mine.products[0] },
			{
				key: "*",
				store: "FairPrice",
				product: "Darlie Double Action Freshness Toothpaste - Multi Care",
				url: "https://www.fairprice.com.sg/product/darlie-double-action",
				name: "Toothpaste  - Multi Care [Sensodyne]",
				note: "ignored from the deals page",
				addedAt: "2026-08-05T06:19:07.000Z",
			},
		],
	},
	theirs,
) as any;
eq("two ALL_ITEMS blocks on different products both survive", twoStars.products.length, 2);

// A base that never existed — the very first write of a file.
const fresh = mergeDataFile("cooldowns.json", null, { version: 1, updatedAt: "b", entries: [{ key: "x" }] }, {
	version: 1,
	updatedAt: "a",
	entries: [{ key: "y" }],
}) as any;
eq("a missing base treats mine as all additions", fresh.entries.length, 2);

// A field this merger has never heard of must survive rather than be dropped, or
// adding one to the file shape quietly deletes it on the first collision.
const unknownField = mergeDataFile(
	"cooldowns.json",
	{ version: 1, updatedAt: "a", entries: [] },
	{ version: 1, updatedAt: "b", entries: [] },
	{ version: 1, updatedAt: "a", entries: [], somethingNew: 42 } as any,
) as any;
eq("an unknown field on theirs is preserved", unknownField.somethingNew, 42);

check("an unknown file is refused loudly", (() => {
	try {
		mergeDataFile("nope.json", null, {}, {});
		return false;
	} catch {
		return true;
	}
})());
