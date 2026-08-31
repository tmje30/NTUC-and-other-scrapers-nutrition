import { check, describe, eq } from "./harness.js";
import {
	BULK_GRAMS,
	dearerThanRecorded,
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
	withoutPendingForSlot,
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

// ⚠️ Pounds were missing from the unit list until 2026-08-31, which made this blind to
// the exact string stores/carousell.ts cites as the canonical hazard — on the one shop
// where pounds dominate. marketplaceSize rejected it as a range while this said it was
// fine; two range detectors that disagree are worse than one.
check("'1.6-5 LBS' is a range", statesSizeRange("ON Gold Standard 1.6-5 LBS"));
check("'2-3 lb' is a range", statesSizeRange("MuscleTech Whey 2-3 lb tub"));

// ── the slug is a FALLBACK, not an equal source ─────────────────────────────────
//
// ⚠️ Carousell's slug writes a decimal as a hyphen, so "2.1kg" arrives as "2-1kg" and
// reads as the range "2–1 kg" — which is not a range, and does not even ascend. All
// three pending Carousell reviews on 2026-08-31 were this false positive. A queue full
// of questions that were never uncertain is how a review page stops being read.
const carousellSlugPick = product({
	store: "Carousell",
	name: "titan whey protein 2.1kg 70 serving",
	url: "https://www.carousell.sg/p/titan-whey-protein-2-1kg-70-serving-1208280679/",
	packWeightG: 2100,
});
check(
	"a slug decimal is not asked about when the name resolves",
	!reviewReasons(carousellSlugPick, { packGrams: 2100 }).some((r) => r.kind === "size-range"),
);

// ...but the fallback must still fire when the NAME cannot be resolved, which is the
// case the flag exists for: the shop states a range and the weight came from elsewhere.
check(
	"a genuine range in the name is still asked about",
	reviewReasons(
		product({ name: "China Purple Cabbage 600-700 g", url: "…/china-purple-cabbage-600-700-g", packWeightG: 700 }),
		{ packGrams: 700 },
	).some((r) => r.kind === "size-range"),
);
check(
	"a genuine range carried only by the slug is still asked about",
	reviewReasons(
		product({ name: "Pisang Berangan Banana", url: "…/pisang-berangan-banana-12-15-kg", packWeightG: 15000 }),
		{ packGrams: 15000, sizeCeilingOk: true },
	).some((r) => r.kind === "size-range"),
);

// ── a question answered by WRITING leaves the queue ─────────────────────────────
//
// ⚠️ Live on 2026-08-31: three Carousell picks were queued on a false size-range flag,
// the flag was fixed, the next run wrote all three into Notion — and all three questions
// stayed on the review page. Tapping OK would have re-written a price already recorded.
{
	const q = (over: Partial<PendingReview>): PendingReview =>
		({
			token: "aaa111",
			ingredientId: "row-1",
			ingredientName: "Whey [Titan]",
			key: "whei",
			unitType: "By Gram",
			vendor: "Carousell",
			slotN: 2,
			priceSgd: 60,
			size: 2100,
			url: "https://example/a",
			itemName: "titan whey 2.1kg",
			perLabel: "$28.57/kg",
			reasons: [],
			askedAt: new Date().toISOString(),
			...over,
		}) as PendingReview;

	const file = {
		version: 1 as const,
		updatedAt: new Date().toISOString(),
		pending: [
			q({}),
			q({ token: "bbb222", ingredientId: "row-2" }),
			q({ token: "ccc333", vendor: "Watsons", slotN: 3 }),
		],
		rejected: [],
	};

	const after = withoutPendingForSlot(file, "row-1", "Carousell");
	check("the answered row/shop question is dropped", !after.pending.some((p) => p.token === "aaa111"));
	check("another ROW's question survives", after.pending.some((p) => p.token === "bbb222"));
	check("the same row at another SHOP survives", after.pending.some((p) => p.token === "ccc333"));

	// ⚠️ Matched on row + shop, NOT on the product: once a Carousell price is recorded for
	// this row, a question about a DIFFERENT Carousell listing for it is stale too —
	// answering it would overwrite the newer figure with an older one.
	const other = withoutPendingForSlot(
		{ ...file, pending: [q({ url: "https://example/z", itemName: "some other listing" })] },
		"row-1",
		"Carousell",
	);
	check("a different listing for the same slot is dropped too", other.pending.length === 0);

	// Returns the SAME object when nothing matched, which is what lets the caller tell
	// "queue changed" from "queue untouched" without a deep compare.
	check("an untouched queue is returned unchanged", withoutPendingForSlot(file, "row-9", "Carousell") === file);
}

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

// ⚠️ The published page is built from the COMMITTED queue file. If the push failed, a
// link would open questions that are not there — the message says so instead of sending
// the user to a page that looks empty and reads as broken.
const unpublished = renderReviewSummary(4, 2, undefined);
check("an unpushed queue is not linked", !unpublished.includes("<a href="));
check("and says why", /not published/i.test(unpublished));

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


describe("the cheaper-only rule — a scan may lower a recorded price, never raise one");

/**
 * ⚠️ **The case that existed unguarded until 2026-08-22, and cost nothing to hit.**
 * Guardian is recorded at $8.50/kg; the scan matches a Guardian product at $12.00/kg.
 * That is 1.4× — under `OUTLIER_FACTOR`, never compared against Guardian's OWN price
 * by `referencePer100g`, and `chooseVendorSlot` updates any slot that names the shop.
 * It was written silently, replacing the cheaper figure.
 */
const dearer = dearerThanRecorded({
	vendor: "Guardian",
	recordedPer1000: 8.5,
	foundPer1000: 12,
	recordedText: "$0.85 / 100g",
	foundText: "$1.20 / 100g",
	perWord: "kg",
});
check("a dearer find is flagged rather than written", dearer !== null);
eq("…and it carries its own reason kind", dearer?.kind, "dearer-than-recorded");
check("…the note names the shop", /Guardian/.test(dearer?.note ?? ""));
check("…and quotes BOTH figures, so the card can be judged", /\$8\.50\/kg/.test(dearer?.note ?? "") && /\$12\.00\/kg/.test(dearer?.note ?? ""));
check("…and says plainly that nothing was written", /not written/i.test(dearer?.note ?? ""));
check("…and the pack behind each of them", /\$0\.85 \/ 100g/.test(dearer?.note ?? ""));

/**
 * ⚠️⚠️ **The case the first live run produced, and the reason the note quotes packs.**
 * A wholemeal loaf recorded at `$2.40 / 20 pcs` matched at `$2.40 / 17 pcs` — same
 * money, three fewer slices, correctly dearer per slice. Both sides render as
 * `$4.00/kg` because the per-kilo figure is derived from the row's declared 600g
 * either way, so a card quoting only that read "$4.00/kg → $4.00/kg — DEARER" and
 * could not be answered.
 */
const loaf = dearerThanRecorded({
	vendor: "NTUC",
	recordedPer1000: 120,
	foundPer1000: 141.18,
	recordedText: "$2.40 / 20 pcs",
	foundText: "$2.40 / 17 pcs",
	perWord: "1000 pcs",
});
check("a card whose per-unit figures coincide still shows what changed", /20 pcs/.test(loaf?.note ?? "") && /17 pcs/.test(loaf?.note ?? ""));
check("…and names the units it is comparing in", /1000 pcs/.test(loaf?.note ?? ""));

/** The ordinary case: cheaper is what the scan is FOR, and must not be interrupted. */
eq(
	"a cheaper find passes straight through",
	dearerThanRecorded({ vendor: "Guardian", recordedPer1000: 8.5, foundPer1000: 6.2 }),
	null,
);

/**
 * ⚠️ Equal is not a regression, and re-writing it refreshes a URL and item name that
 * may have gone stale. Asking about it would be a daily question with no decision in it.
 */
eq(
	"an identical price is not queried",
	dearerThanRecorded({ vendor: "NTUC", recordedPer1000: 4, foundPer1000: 4 }),
	null,
);

/**
 * ⚠️⚠️ **An empty slot is the whole point of the scan.** 36 of the 120 tagged
 * row×vendor pairs had no price at all when this was built (measured 2026-08-22);
 * gating those would stop the price book ever filling — the exact circularity
 * `readScanRows` was written to break.
 */
eq(
	"a slot with no price recorded is never blocked",
	dearerThanRecorded({ vendor: "NTUC", recordedPer1000: null, foundPer1000: 4 }),
	null,
);
eq(
	"…nor is a candidate whose own per-unit price cannot be worked out",
	dearerThanRecorded({ vendor: "NTUC", recordedPer1000: 4, foundPer1000: null }),
	null,
);

/**
 * ⚠️ The labels are cosmetic and `perLabel` returns "" when it cannot express the
 * figure. The note must still carry two comparable numbers rather than reading
 * "( → )", which would put an unanswerable card in front of the user.
 */
const unlabelled = dearerThanRecorded({ vendor: "Iherb", recordedPer1000: 10, foundPer1000: 25 });
check("a missing label falls back to a real number", /10\.00/.test(unlabelled?.note ?? "") && /25\.00/.test(unlabelled?.note ?? ""));

/** The data is kept as numbers too — the note is for a human, these are for a later report. */
eq("the recorded figure is kept", unlabelled?.kind === "dearer-than-recorded" ? unlabelled.recordedPer1000 : -1, 10);
eq("the found figure is kept", unlabelled?.kind === "dearer-than-recorded" ? unlabelled.foundPer1000 : -1, 25);
