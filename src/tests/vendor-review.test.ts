import { check, describe, eq } from "./harness.js";
import {
	BULK_GRAMS,
	EMPTY_REVIEW,
	REJECT_REASONS,
	findPendingFor,
	isRejectReason,
	isRejectedPick,
	reasonsFor,
	sizeBoundsFor,
	prunePending,
	renderReviewSummary,
	reviewReasons,
	reviewToken,
	statesMultipack,
	statesSizeRange,
	withPending,
	withRejectedPick,
	withoutPending,
	type PendingReview,
	type VendorReviewFile,
} from "../core/vendor-review.js";
import type { StoreProduct } from "../core/stores/types.js";

/**
 * The price-book review queue.
 *
 * The cases that matter here are the ones where being quietly wrong is expensive: a
 * catering pack written into a live database as "your price", and — the other way — a
 * refusal leaking into the deals page, which the user drew a hard line around.
 */

describe("vendor review — what the scan should not decide alone");

const product = (over: Partial<StoreProduct> = {}): StoreProduct =>
	({
		store: "Sheng Siong",
		name: "Australia Carrot",
		url: "https://shengsiong.com.sg/product/australia-carrot-10-kg",
		priceSgd: 15.5,
		packWeightG: 10000,
		pricePer100g: 0.155,
		volumetric: false,
		...over,
	}) as StoreProduct;

// ── the bulk gate ───────────────────────────────────────────────────────────────

check(
	"a 10 kg sack is queued, not written",
	reviewReasons(product(), { packGrams: 10000 }).some((r) => r.kind === "bulk"),
);

check(
	"a 250 g pack is written without asking",
	reviewReasons(product({ name: "China Old Garlic", packWeightG: 250 }), { packGrams: 250 })
		.length === 0,
);

check(
	"the threshold is inclusive",
	reviewReasons(product(), { packGrams: BULK_GRAMS }).some((r) => r.kind === "bulk"),
);

check(
	"a 12 × 1 L case is bulk even before its weight is known",
	reviewReasons(product({ name: "Cowhead UHT Pure Milk 12 x 1 L", packWeightG: null }), {
		packGrams: null,
	}).some((r) => r.kind === "bulk"),
);

// ⚠️ A piece-priced pack has no weight at all, and that is not a reason to ask about
// it — a razor cartridge is meant to have no grams. Treating null as "suspicious"
// would queue every By-Unit row in the database.
check(
	"a piece-priced pack with no weight is not called bulk",
	reviewReasons(product({ name: "Schick Hydro 5 Refill", packWeightG: null, unitCount: 4 }), {
		packGrams: null,
	}).length === 0,
);

// ── the size-range gate ─────────────────────────────────────────────────────────

check("'600-700 g' is a range", statesSizeRange("China Purple Cabbage 600-700 g"));
check("a slug carries it too", statesSizeRange("…/china-purple-cabbage-600-700-g"));
check("'12-15-kg' in a slug is a range", statesSizeRange("…/pisang-berangan-banana-12-15-kg"));
check("a plain size is not a range", !statesSizeRange("Heinz Apple Cider Vinegar 473 ml"));
// ⚠️ A hyphenated product name must not read as a range — "Repair & Protect" style
// names are everywhere and would queue the entire scan.
check("a hyphenated name is not a range", !statesSizeRange("Rice Cooking Wine - 16% Alcohol"));

check("'50 x 1.5g' is a multipack", statesMultipack("Heritage Farm Green Tea 50 x 1.5g"));
check("'12 x 1 L' is a multipack", statesMultipack("UHT Pure Milk 12 x 1 L"));
check("a lone size is not", !statesMultipack("Fragrant Sesame Oil 2 L"));

// ── the marketplace gates ───────────────────────────────────────────────────────

check(
	"a reputation rescue is always asked about",
	reviewReasons(product({ packGrams: 500 } as any), { packGrams: 500, rescued: true }).some(
		(r) => r.kind === "floor-rescue",
	),
);

check(
	"rejected cheaper listings are surfaced",
	reviewReasons(product(), { packGrams: 500, rejectedCheaper: 3 }).some(
		(r) => r.kind === "undercut",
	),
);

check(
	"an auto-generated handle is asked about",
	reviewReasons(product(), { packGrams: 500, autoHandle: true }).some(
		(r) => r.kind === "auto-handle",
	),
);

// ── the outlier gate ────────────────────────────────────────────────────────────

check(
	"5× dearer than the row's other shop is odd",
	reviewReasons(product({ pricePer100g: 5 }), { packGrams: 500, referencePer100g: 1 }).some(
		(r) => r.kind === "outlier",
	),
);

check(
	"a genuinely better price is not an outlier",
	!reviewReasons(product({ pricePer100g: 0.8 }), { packGrams: 500, referencePer100g: 1 }).some(
		(r) => r.kind === "outlier",
	),
);

// ⚠️ Most rows have no price recorded anywhere yet — that is the hole this whole
// feature exists to fill — so a null reference must not be treated as zero.
check(
	"no reference means no outlier check, not a divide by zero",
	!reviewReasons(product({ pricePer100g: 5 }), { packGrams: 500, referencePer100g: null }).some(
		(r) => r.kind === "outlier",
	),
);

// ── "Don't use" is scoped, and never global ─────────────────────────────────────

describe("vendor review — a refusal is about the price book, nothing else");

const rejected = (): VendorReviewFile =>
	withRejectedPick(EMPTY_REVIEW, {
		ingredientId: "row-carrots",
		vendor: "Sheng Siong",
		url: "https://shengsiong.com.sg/product/australia-carrot-10-kg",
		store: "Sheng Siong",
		product: "Australia Carrot",
		name: "carrots, Normal",
		why: "10kg pack",
	}).file;

check(
	"the refused pack is not offered again for that row",
	isRejectedPick(rejected(), "row-carrots", "Sheng Siong", product()),
);

check(
	"the SAME pack is still fair game for a different row",
	!isRejectedPick(rejected(), "row-soup", "Sheng Siong", product()),
);

check(
	"and still fair game at a different shop",
	!isRejectedPick(rejected(), "row-carrots", "NTUC", product()),
);

check(
	"a different pack at the same shop is untouched",
	!isRejectedPick(
		rejected(),
		"row-carrots",
		"Sheng Siong",
		product({ url: "https://shengsiong.com.sg/product/australia-carrot-1-kg" }),
	),
);

check(
	"refusing twice is a no-op",
	withRejectedPick(rejected(), {
		ingredientId: "row-carrots",
		vendor: "Sheng Siong",
		url: "https://shengsiong.com.sg/product/australia-carrot-10-kg",
		store: "Sheng Siong",
		product: "Australia Carrot",
		name: "carrots, Normal",
		why: "again",
	}).added === false,
);

// ⚠️ The line the user drew: a refusal here must never read as an exclusion. This
// checks the shape of the file, because the only way "Don't use" could reach the
// deals page is by growing a `terms` or `products` key like `exclusions.json` has.
eq("a refusal file has no exclusion-shaped keys", Object.keys(rejected()).sort(), [
	"pending",
	"rejected",
	"updatedAt",
	"version",
]);

check(
	"the summary tells the user the deals page is unaffected",
	/deals page/i.test(renderReviewSummary(3, 2, "https://example.test/review.html")),
);

// ⚠️ ONE message per scan, linking to the page — never one per pick. 16 notifications
// from a single run is what prompted this, and a muted bot loses the daily digest too.
check(
	"the summary links to the page rather than listing the picks",
	renderReviewSummary(16, 50, "https://example.test/review.html").includes(
		'<a href="https://example.test/review.html">',
	),
);

check(
	"nothing to ask about still reports what was recorded",
	/50 prices recorded/i.test(renderReviewSummary(0, 50, "https://example.test/review.html")),
);

// ── the queue does not grow without bound ───────────────────────────────────────

describe("vendor review — asked once, not every day");

const pending = (over: Partial<PendingReview> = {}): PendingReview => ({
	token: "abc123",
	ingredientId: "row-carrots",
	ingredientName: "carrots, Normal",
	key: "carrot",
	unitType: "By Gram",
	vendor: "Sheng Siong",
	slotN: 2,
	priceSgd: 15.5,
	size: 10000,
	url: "https://shengsiong.com.sg/product/australia-carrot-10-kg",
	itemName: "Australia Carrot",
	perLabel: "$1.55/kg",
	reasons: [{ kind: "bulk", grams: 10000, note: "10kg pack" }],
	askedAt: new Date().toISOString(),
	...over,
});

const queued = withPending(EMPTY_REVIEW, pending({ messageId: 42 }));

check(
	"an outstanding question is found again next run",
	findPendingFor(queued, "row-carrots", "Sheng Siong", {
		url: "https://shengsiong.com.sg/product/australia-carrot-10-kg",
	})?.token === "abc123",
);

check(
	"a different pack is a different question",
	!findPendingFor(queued, "row-carrots", "Sheng Siong", { url: "…/carrot-1-kg" }),
);

check("answering removes it", withoutPending(queued, "abc123").pending.length === 0);

check(
	"re-queueing the same token replaces rather than duplicates",
	withPending(queued, pending({ priceSgd: 14 })).pending.length === 1,
);

check("a fresh token avoids the live one", reviewToken(queued) !== "abc123");

// ⚠️ A fortnight-old question quotes a price the shop has since changed; tapping OK
// on it would write a stale number. Dropping costs nothing — the scan re-queues
// anything still uncertain.
const stale = withPending(EMPTY_REVIEW, pending({ askedAt: "2020-01-01T00:00:00.000Z" }));
check("a stale question is dropped, not answered", prunePending(stale).pending.length === 0);
check("a fresh one survives the prune", prunePending(queued).pending.length === 1);

// ── the reasons, and what each one is allowed to do ─────────────────────────────

describe("vendor review — a refusal with a reason");

check(
	"Wrong brand is offered only when the row names a [brand]",
	!reasonsFor({}).some((r) => r.key === "wrong-brand") &&
		reasonsFor({ brand: "Sensodyne" }).some((r) => r.key === "wrong-brand"),
);

// ⚠️ Exactly ONE reason may reach the deals page — the user's explicit decision. If a
// second ever gains that power it must be a deliberate edit here, not a quiet default.
eq(
	"only wrong-item is allowed to touch the deals page",
	REJECT_REASONS.filter((r) => r.key === "wrong-item").map((r) => r.key),
	["wrong-item"],
);

check("a hand-edited reason is rejected", !isRejectReason("delete-everything"));
check("a real one is accepted", isRejectReason("too-big"));

// ── size bounds: the difference between skipping a URL and answering the question ──

const refusedBig = withRejectedPick(EMPTY_REVIEW, {
	ingredientId: "row-carrots",
	vendor: "Sheng Siong",
	url: "u1",
	store: "Sheng Siong",
	product: "Australia Carrot 10kg",
	name: "carrots, Normal",
	why: "bulk",
	reason: "too-big",
	packGrams: 10000,
}).file;

eq("'too big at 10kg' becomes a ceiling", sizeBoundsFor(refusedBig, "row-carrots", "Sheng Siong"), {
	maxGrams: 10000,
	minGrams: null,
});

check(
	"the ceiling is scoped to that row at that shop",
	sizeBoundsFor(refusedBig, "row-carrots", "NTUC").maxGrams === null,
);

// ⚠️ Without this the user is asked the same question every week in a smaller pack:
// excluding the 10 kg sack alone just promotes the 5 kg one.
const refusedTwice = withRejectedPick(refusedBig, {
	ingredientId: "row-carrots",
	vendor: "Sheng Siong",
	url: "u2",
	store: "Sheng Siong",
	product: "Australia Carrot 5kg",
	name: "carrots, Normal",
	why: "bulk",
	reason: "too-big",
	packGrams: 5000,
}).file;
check(
	"a second refusal tightens the ceiling rather than replacing it",
	sizeBoundsFor(refusedTwice, "row-carrots", "Sheng Siong").maxGrams === 5000,
);

check(
	"a refusal with no size reason sets no bound",
	sizeBoundsFor(
		withRejectedPick(EMPTY_REVIEW, {
			ingredientId: "r",
			vendor: "v",
			url: "u",
			store: "v",
			product: "p",
			name: "n",
			why: "",
			reason: "wrong-item",
			packGrams: 900,
		}).file,
		"r",
		"v",
	).maxGrams === null,
);
