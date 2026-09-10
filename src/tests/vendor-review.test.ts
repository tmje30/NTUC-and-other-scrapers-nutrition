import { check, describe, eq } from "./harness.js";
import { renderReviewPage } from "../core/review-page.js";
import {
	BULK_GRAMS,
	dearerThanRecorded,
	EMPTY_REVIEW,
	REJECT_REASONS,
	findPendingFor,
	findRecordedListing,
	groupOf,
	isRecordedUnchanged,
	mergeVendorReview,
	isRejectReason,
	isRejectedPick,
	reasonsFor,
	sizeBoundsFor,
	rateCeilingFor,
	prunePending,
	renderReviewCard,
	renderReviewSummary,
	reviewReasons,
	reviewToken,
	statesMultipack,
	statesSizeRange,
	sizeRangeIn,
	statedRangeLow,
	withPending,
	withLegacyPerFields,
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

// ⚠️ Two lines, and that is the whole message (user, 2026-09-07). The button
// explanation moved to the top of the page the link opens; the running total of clear
// writes was a number with nothing to do about it.
const summary = renderReviewSummary(3, 2, "https://example.test/review.html");
eq("the summary is two lines", summary.split("\n").length, 2);
check("it does not explain the buttons", !/deals page/i.test(summary));
check("nor count the writes that needed no call", !summary.includes("recorded already"));
check("it still says how many and where", /3 prices need your call/.test(summary));

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

// ── the price ceiling: the same argument as the size one, one dimension over ──────

/**
 * **"Too expensive" (user, 2026-09-10).** Refusing the dearest listing alone just
 * promotes the next-dearest, and the row asks the same question next week a few cents
 * lower — the ladder `sizeBoundsFor` already exists to stop, in the other dimension.
 *
 * ⚠️ It is stored as a RATE, never as the pack price. $45 is dear for 60 softgels and
 * cheap for 300, and a ceiling that could not tell those apart would refuse the good
 * pack and admit the bad one.
 */
const refusedDear = withRejectedPick(EMPTY_REVIEW, {
	ingredientId: "row-omega",
	vendor: "Iherb",
	url: "u1",
	store: "Iherb",
	product: "Prenatal DHA, 60 Softgels",
	name: "Omega 3 800",
	why: "brand",
	reason: "too-expensive",
	rate: 796, // $47.76 / 60 pcs * 1000
}).file;

check("'too expensive' becomes a rate ceiling", rateCeilingFor(refusedDear, "row-omega", "Iherb") === 796);
check("scoped to that row at that shop", rateCeilingFor(refusedDear, "row-omega", "Watsons") === null);
check("no ceiling where nothing was refused on price", rateCeilingFor(EMPTY_REVIEW, "row-omega", "Iherb") === null);

// The tightest refusal is the user's latest word on the row, so it wins.
const refusedDearTwice = withRejectedPick(refusedDear, {
	ingredientId: "row-omega",
	vendor: "Iherb",
	url: "u2",
	store: "Iherb",
	product: "Something dear, 90 Softgels",
	name: "Omega 3 800",
	why: "",
	reason: "too-expensive",
	rate: 500,
}).file;
check("a second refusal tightens the ceiling", rateCeilingFor(refusedDearTwice, "row-omega", "Iherb") === 500);

// ⚠️ A size complaint says nothing about price, and vice versa — the two ceilings must
// not leak into each other.
check("a size refusal sets no price ceiling", rateCeilingFor(refusedBig, "row-carrots", "Sheng Siong") === null);
check("a price refusal sets no size ceiling", sizeBoundsFor(refusedDear, "row-omega", "Iherb").maxGrams === null);

// A refusal carrying no rate is no opinion, never "nothing is acceptable".
check(
	"a price refusal with no rate sets no ceiling",
	rateCeilingFor(
		withRejectedPick(EMPTY_REVIEW, {
			ingredientId: "r",
			vendor: "v",
			url: "u",
			store: "v",
			product: "p",
			name: "n",
			why: "",
			reason: "too-expensive",
			rate: null,
		}).file,
		"r",
		"v",
	) === null,
);

// ⚠️ The button has to be OFFERED, and on every card — unlike "Wrong brand", which is
// only shown where the row names a brand to enforce.
check("Too expensive is offered", reasonsFor({}).some((r) => r.key === "too-expensive"));
check("…on a card with no brand too", reasonsFor({}).some((r) => r.label === "Too expensive"));
check("…and it is a real reason key", isRejectReason("too-expensive"));


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
	recordedPer: 8.5,
	foundPer: 12,
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
 * ⚠️⚠️ **The page lays this out as a table; the message keeps the sentence.** One line
 * carrying two prices, two pack sizes and two per-unit figures has to be parsed before it
 * can be judged, and judging it is the whole question. Asked for 2026-09-04.
 *
 * ⚠️ Telegram has no table, so `note` is unchanged — these fields are additive.
 */
eq("the reason carries the unit, so a page need not re-derive it", dearer?.kind === "dearer-than-recorded" ? dearer.perWord : null, "kg");
eq("…and the shop, for the heading", dearer?.kind === "dearer-than-recorded" ? dearer.vendor : null, "Guardian");

const pend = (over: any) => ({
	token: "t", ingredientId: "i", ingredientName: "Muscovado Sugar (Brown)", key: "muscovado sugar",
	unitType: "By Gram", vendor: "NTUC", slotN: 1, priceSgd: 6.05, size: 325,
	url: "https://e.test/p", itemName: "Tate and Lyle Dark Muscovado Sugar", perLabel: "",
	askedAt: "2026-09-04T00:00:00.000Z", ...over,
});
const card = renderReviewPage([pend({ reasons: [dearer!] })] as any, { repo: "o/r" });
check("the card heads the block with the shop", card.includes("Dearer than current Guardian price"));
check("…states the current figure", card.includes(">" + "$8.50/kg" + "<"));
check("…and the new one", card.includes(">" + "$12.00/kg" + "<"));
check("…paints a dearer find red, not green", card.includes('class="fig up"') && !card.includes('class="fig down"'));
// ⚠️ Colour is never the only signal — a red-green colourblind reader gets the words.
check("…and labels both rows in words", card.includes(">current<") && card.includes(">new<"));
check("…and says what accepting means", card.includes("Accept only if the price is acceptable"));

// ⚠️ Colour follows the NUMBERS, not the reason's name: the same block renders a
// near-miss whose price happens to be lower, and red there would contradict the figures.
const cheaperCmp = renderReviewPage(
	[pend({ reasons: [{ kind: "dearer-than-recorded", recordedPer: 12, foundPer: 8, perWord: "kg", vendor: "NTUC", note: "n" }] })] as any,
	{ repo: "o/r" },
);
check("a lower figure is green even under a dearer label", cheaperCmp.includes('class="fig down"'));

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
	recordedPer: 120,
	foundPer: 141.18,
	recordedText: "$2.40 / 20 pcs",
	foundText: "$2.40 / 17 pcs",
	perWord: "1000 pcs",
});
check("a card whose per-unit figures coincide still shows what changed", /20 pcs/.test(loaf?.note ?? "") && /17 pcs/.test(loaf?.note ?? ""));
check("…and names the units it is comparing in", /1000 pcs/.test(loaf?.note ?? ""));

/** The ordinary case: cheaper is what the scan is FOR, and must not be interrupted. */
eq(
	"a cheaper find passes straight through",
	dearerThanRecorded({ vendor: "Guardian", recordedPer: 8.5, foundPer: 6.2 }),
	null,
);

/**
 * ⚠️ Equal is not a regression, and re-writing it refreshes a URL and item name that
 * may have gone stale. Asking about it would be a daily question with no decision in it.
 */
eq(
	"an identical price is not queried",
	dearerThanRecorded({ vendor: "NTUC", recordedPer: 4, foundPer: 4 }),
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
	dearerThanRecorded({ vendor: "NTUC", recordedPer: null, foundPer: 4 }),
	null,
);
eq(
	"…nor is a candidate whose own per-unit price cannot be worked out",
	dearerThanRecorded({ vendor: "NTUC", recordedPer: 4, foundPer: null }),
	null,
);

/**
 * ⚠️ The labels are cosmetic and `perLabel` returns "" when it cannot express the
 * figure. The note must still carry two comparable numbers rather than reading
 * "( → )", which would put an unanswerable card in front of the user.
 */
const unlabelled = dearerThanRecorded({ vendor: "Iherb", recordedPer: 10, foundPer: 25 });
check("a missing label falls back to a real number", /10\.00/.test(unlabelled?.note ?? "") && /25\.00/.test(unlabelled?.note ?? ""));

/** The data is kept as numbers too — the note is for a human, these are for a later report. */
eq("the recorded figure is kept", unlabelled?.kind === "dearer-than-recorded" ? unlabelled.recordedPer : -1, 10);
eq("the found figure is kept", unlabelled?.kind === "dearer-than-recorded" ? unlabelled.foundPer : -1, 25);

describe("a stated range is read at its BOTTOM, and shown as the shop wrote it");

// The shop's own words, tidied — a slug writes `850-900g`, a title writes `850 - 900g`.
eq("a range in a title is picked up", sizeRangeIn("Carrots 850 - 900g"), "850 - 900g");
eq("a range in a slug reads the same way", sizeRangeIn("au-china-carrots-850-900g"), "850 - 900g");
// ⚠️ The slug's hyphen before the UNIT is a separator, not a minus.
eq("the unit's own hyphen is not a range bound", sizeRangeIn("pisang-banana-12-15-kg"), "12 - 15kg");
check("a single size is not a range", sizeRangeIn("Carrots 900g") === null);
check("the detector and the display agree", statesSizeRange("Carrots 850-900g") === (sizeRangeIn("Carrots 850-900g") !== null));

// ⚠️ The LOW end, per the user 2026-09-06 — the top is the optimistic read, and a price
// book that errs should err against itself.
eq(
	"the low end is what the pack is measured at",
	statedRangeLow({ name: "Australia / China Carrots", url: "https://s.test/au-china-carrots-850-900g" }),
	850,
);
eq("kilos convert", statedRangeLow({ name: "Banana 12-15 kg" }), 12000);
check("no range, no opinion", statedRangeLow({ name: "Carrots 900g" }) === null);

describe("the card names the pack and the maker");

const shown = renderReviewPage(
	[pend({ reasons: [], statedSize: "850 - 900g", brandName: "Greenfields", itemName: "Skimmed Milk" })] as any,
	{ repo: "o/r" },
);
check("the pack is quoted as the shop describes it", shown.includes("(850 - 900g)"));
// ⚠️ Sheng Siong titles a product `Skimmed Milk` and nothing else; without the brand the
// question "is this the right product?" has no answer at all.
check("the brand is bracketed after the name", shown.includes("[Greenfields]"));

describe("several picks for one slot are one deck, closest first");

const two = renderReviewPage(
	[
		pend({ token: "t2", rank: 1, itemName: "Cerave AM SPF50", reasons: [] }),
		pend({ token: "t1", rank: 0, itemName: "Cerave AM", reasons: [] }),
	] as any,
	{ repo: "o/r" },
);
eq("one card, not two", (two.match(/<article class="card/g) ?? []).length, 1);
eq("two slides inside it", (two.match(/class="slide"/g) ?? []).length, 2);
// ⚠️ The queue holds the alternatives BEFORE the primary, so unsorted the wrong SPF leads.
check("the closest match is the first slide", two.indexOf("Cerave AM<") < two.indexOf("Cerave AM SPF50"));
check("accepting settles the whole slot", two.includes('data-hide-card="group"'));

// A lone question keeps the plain card — a one-slide carousel advertises something to see.
const one = renderReviewPage([pend({ reasons: [] })] as any, { repo: "o/r" });
check("a single pick is not a deck", !one.includes("class=\"slide\""));
// ⚠️ The attribute, not the bare word — the one-tap script names it in a comment.
check("and it does not remove itself on tap", !one.includes(String.fromCharCode(100) + "ata-hide-card=" + String.fromCharCode(34)));

describe("a field rename in the source is not a field rename on disk");

// ⚠️ The exact shape that killed run 34044851432: a question queued BEFORE the
// per-100 rename, carrying `recordedPer1000`/`foundPer1000`.
const preRename: any = {
	version: 1,
	updatedAt: "",
	rejected: [],
	pending: [
		pend({
			reasons: [
				{ kind: "dearer-than-recorded", recordedPer1000: 76.01, foundPer1000: 178, perWord: "kg", vendor: "My Protein", note: "x" },
			],
		}),
	],
	moves: { generatedAt: "", reconfirmed: 0, moves: [{ recordedPer1000: 1.68, foundPer1000: 1.78 }] },
};
const repaired: any = withLegacyPerFields(preRename);
eq("a queued reason gains the new name", repaired.pending[0].reasons[0].recordedPer, 76.01);
eq("both sides of it", repaired.pending[0].reasons[0].foundPer, 178);
eq("and the moves snapshot too", repaired.moves.moves[0].foundPer, 1.78);

// ⚠️ null is a REAL value — an empty slot has no recorded price — so the test must be
// `undefined`, never falsy, or a first-price move would be rewritten as a reduction.
const emptySlot: any = { version: 1, updatedAt: "", rejected: [], pending: [], moves: { generatedAt: "", reconfirmed: 0, moves: [{ recordedPer: null, foundPer: 2 }] } };
check("a null recorded price survives", withLegacyPerFields(emptySlot).moves!.moves[0]!.recordedPer === null);

// ⚠️ The backstop: the page build runs INSIDE the sweep, so one bad card must not be
// able to take down a run that has already written prices to Notion.
const broken = renderReviewPage(
	[pend({ reasons: [{ kind: "dearer-than-recorded", perWord: "kg", note: "no figures at all" } as any] })] as any,
	{ repo: "o/r" },
);
// ⚠️ The rendered element, not the class name — the stylesheet mentions .cmp-h too.
check("a reason with no figures renders nothing rather than throwing", !broken.includes("<div class=\"cmp-h\">"));
check("and the rest of the card still renders", broken.includes("Tate and Lyle Dark Muscovado Sugar"));

describe("a slug's hyphens are not always a range — measured on the 2026-09-06 sweep");

// The two REAL ranges Sheng Siong publishes, which is what the feature is for.
eq("a genuine tolerance survives", sizeRangeIn("shengsiong.com.sg/product/australia-china-carrots-850-900-g"), "850 - 900g");
eq("and its low end is what gets recorded", statedRangeLow({ url: "…/australia-china-carrots-850-900-g" }), 850);
eq("so does the cabbage", sizeRangeIn("…/china-purple-cabbage-600-700-g"), "600 - 700g");

// ⚠️ Four slugs that are NOT ranges, every one produced by a real sweep. Before this,
// each added a false "pack size is a RANGE" question — and worse, the low-end rule then
// wrote the wrong pack size from it.
check(
	"SPF50 is not the bottom of a range",
	sizeRangeIn("…/cerave-facial-moisturising-lotion-am-spf50-52ml-13270899") === null,
);
check("a product named Jumbo 600 beside a 600g pack is not 600-to-600", sizeRangeIn("…/gardenia-white-bread-jumbo-600-600-g") === null);
check("1.12 kg written with a hyphen is not 1 to 12 kg", sizeRangeIn("…/ecuador-philippines-indonesia-cavendish-banana-1-12-kg") === null);
check("50 x 1.5g is a multipack, not 1 to 5 grams", sizeRangeIn("…/osk-new-family-japan-roast-tea-pu-er-50-x-1-5g") === null);

// ⚠️ The canonical Carousell hazard this module already treats as genuine stays genuine —
// 3.1x is a wide range, but it is a range someone actually typed.
eq("a wide but real stated range is kept", sizeRangeIn("Titan Whey 1.6-5 LBS"), "1.6 - 5LBS");

describe("the counter watches for removed cards, not for its own writes");

const script = renderReviewPage([pend({ reasons: [] })] as any, { repo: "o/r" });
// ⚠️⚠️ The page hung on 2026-09-07 because this observer watched the SUBTREE: writing
// the count is itself a mutation, so it re-triggered on its own write and spun forever.
// It did not even need a card removed to start — the one-tap script paints its label on
// load and that was enough. Cards are direct children of body, so childList alone sees
// every removal while the counter and the toggle, both one level down, stay invisible.
check("the observer does not watch the subtree", !/observe\(document\.body, \{ childList: true, subtree/.test(script));
check("it still watches for children being removed", script.includes("observe(document.body, { childList: true })"));
// The second lock on the same door: no write at all when the number has not changed.
check("and it does not write an unchanged count", /if \(n === last\) return;/.test(script));

describe("a deck is dragged sideways, not paged by its dots");

const deckHtml = renderReviewPage(
	[pend({ token: "d1", rank: 0, reasons: [] }), pend({ token: "d2", rank: 1, reasons: [] })] as any,
	{ repo: "o/r" },
);
// ⚠️ Mouse ONLY. A touchscreen already scrolls this strip natively, with momentum the
// platform tunes and this cannot match — intercepting touch would replace something
// good with something worse.
check("the drag handler ignores anything but a mouse", deckHtml.includes('ev.pointerType !== "mouse"'));
// ⚠️ The whole card body is a link to the shop, so a drag ending on it would open the
// product. The click is swallowed in the CAPTURE phase, before the anchor sees it.
check("a click after a real drag is swallowed", /addEventListener\("click", function \(ev\) \{\s*if \(!swallow\) return;/.test(deckHtml));
check("and swallowed before the link sees it", deckHtml.includes("ev.stopPropagation();"));
// ⚠️ A vertical drag is the user scrolling the PAGE; stealing it traps them in the deck.
check("a vertical drag is left alone", deckHtml.includes("Math.abs(dx) <= Math.abs(ev.clientY - drag.y)"));
// ⚠️ scroll-snap does not re-snap after a scrollLeft set from script, so a drag that
// stops between two options would leave both half shown.
check("a drag lands on a slide rather than between two", deckHtml.includes('behavior: "smooth"'));
// The dots stay: they are the only way to move between options from a keyboard.
check("the dots remain for keyboard users", deckHtml.includes('class="dots"'));

describe("a slide does not state its position three times");

const nearMiss = (n: string) => ({ kind: "near-miss" as const, note: n });
const ALT2 = "no product here MATCHED this row — this is alternative 2 of 3, offered as a suggestion. Accept only if it is the same thing.";
const LONE = "no product here MATCHED this row — this is the closest one, offered as a suggestion. Accept only if it is the same thing.";

const inDeck = renderReviewPage(
	[
		pend({ token: "p1", rank: 0, reasons: [nearMiss("no product here MATCHED this row — this is the closest of 3 offered, best first. Accept only if it is the same thing.")] }),
		pend({ token: "p2", rank: 1, reasons: [nearMiss(ALT2)] }),
	] as any,
	{ repo: "o/r" },
);
const bullets = (h: string) => (h.match(/<li class="r-near-miss">[^<]*<\/li>/g) ?? []).join(" ");
// ⚠️ Measured on the visible bullets only. The raw note also travels in data-payload and
// in the pre-filled issue body, where it SHOULD stay whole — that is the record of what
// was shown, and it is not what the reader sees.
check("a slide drops the position the label above already gives", !/alternative 2 of|the closest of/.test(bullets(inDeck)));
check("but keeps the part nothing else says", bullets(inDeck).includes("no product here MATCHED this row. Accept only if it is the same thing."));
check("the payload still records the note whole", inDeck.includes("alternative 2 of 3"));

// ⚠️ A lone suggestion has no deck and no OPTION label above it, so its sentence reads
// correctly as written and is left alone.
const alone = renderReviewPage([pend({ reasons: [nearMiss(LONE)] })] as any, { repo: "o/r" });
check("a lone suggestion keeps its wording", bullets(alone).includes("this is the closest one"));

// ⚠️ Telegram gets the stored note untouched — no deck, no label, so the position earns
// its place there. The page knows it is a deck; the note does not have to.
check("the Telegram card is unchanged", renderReviewCard(pend({ reasons: [nearMiss(ALT2)] }) as any).includes("alternative 2 of 3"));

/**
 * ⚠️⚠️ **The row is settled; the shop still sells the pack; the page asked anyway.**
 * (user, 2026-09-08) The CeraVe and creatine rows offered the same worse-value siblings
 * every morning against a recorded price that had not moved. A dearer suggestion is only
 * worth a card when the recorded pick has gone UP or gone AWAY — so the sweep has to be
 * able to find the recorded pick among today's results first.
 */
describe("the recorded pick is found among today's results");

const slotAt = { urlValue: "https://shop.test/p/42", itemNameValue: "CeraVe AM Lotion SPF30 52ML" };
const offered = [
	{ url: "https://shop.test/p/9", name: "Something else" },
	{ url: "https://shop.test/p/42", name: "renamed since it was recorded" },
	{ url: "https://shop.test/p/7", name: "CeraVe AM Lotion SPF30 52ML" },
];

// ⚠️ The URL wins. A shop that re-words its own title has not changed the product;
// a shop that reuses a title across two packs has.
eq(
	"the URL identifies it, even after the shop re-words the title",
	findRecordedListing(slotAt, offered)?.url,
	"https://shop.test/p/42",
);
eq(
	"the recorded name is the fallback when no URL matches",
	findRecordedListing({ itemNameValue: "CeraVe AM Lotion SPF30 52ML" }, offered)?.url,
	"https://shop.test/p/7",
);
// Case and stray spacing are the shop's, not a difference in the product.
eq(
	"…matched without regard to case or padding",
	findRecordedListing({ itemNameValue: "  cerave am lotion spf30 52ml " }, offered)?.url,
	"https://shop.test/p/7",
);
// ⚠️ The whole point of the gate: nothing found means the pack is GONE, and that is
// exactly when the dearer alternatives stop being noise and start being the answer.
check("an empty slot matches nothing", findRecordedListing({}, offered) === undefined);
check(
	"a pack the shop no longer lists matches nothing",
	findRecordedListing({ urlValue: "https://shop.test/p/gone" }, offered) === undefined,
);

/**
 * ⚠️ **Every slide states what it would replace.** The slides compete for one slot, so
 * the price each would overwrite is the same fact for all of them — showing it only on
 * the closest match made the runners-up look like they had nothing to displace.
 */
describe("a runner-up states what it would replace");

const bothCmp = renderReviewPage(
	[
		pend({ token: "a1", rank: 0, reasons: [{ kind: "near-miss", note: "closest of 2" }] }),
		pend({
			token: "a2",
			rank: 1,
			reasons: [
				{ kind: "near-miss", note: "alternative 2 of 2" },
				{ kind: "dearer-than-recorded", recordedPer: 42.13, foundPer: 90.38, perWord: "kg", vendor: "Iherb", note: "n" },
			],
		}),
	] as any,
	{ repo: "o/r" },
);
check("the second slide carries the comparison block", bothCmp.includes("Dearer than current Iherb price"));
eq("…once, on the slide that holds the reason", (bothCmp.match(/Dearer than current Iherb price/g) ?? []).length, 1);
check("…with both figures", bothCmp.includes(">$42.13/kg<") && bothCmp.includes(">$90.38/kg<"));

/**
 * ⚠️⚠️ **The morning two sweeps reverted each other.** 2026-09-08: the laptop pushed
 * `03b17f0`, re-asking three iHerb questions and retiring a Watsons one it had just
 * matched; the cloud sweep's push was rejected, it reset onto that commit, re-applied its
 * own minutes-old copy and pushed `1c766ec` — the iHerb timestamps went back a day and
 * the retired Watsons card came back. Both runs reported success.
 */
describe("two sweeps race, and neither reverts the other");

const q = (over: Partial<PendingReview>): PendingReview => pending({ ...over });
const cloudPairs = new Set(["row-a|NTUC", "row-b|Guardian"]);
const visitedPair = (p: PendingReview) => cloudPairs.has(`${p.ingredientId}|${p.vendor}`);

const laptopPushed = {
	version: 1 as const,
	updatedAt: "2026-09-08T02:03:42.975Z",
	pending: [
		q({ token: "iherb-new", ingredientId: "row-c", vendor: "Iherb", askedAt: "2026-09-08T02:03:42.975Z" }),
	],
	rejected: [{ ingredientId: "row-z", url: "https://x.test/1", reason: "wrong-item" } as any],
};
const cloudHas = {
	version: 1 as const,
	updatedAt: "2026-09-08T02:05:00.000Z",
	pending: [
		q({ token: "ntuc-new", ingredientId: "row-a", vendor: "NTUC" }),
		// The copy this run read BEFORE the laptop pushed — a day stale, and about a shop
		// this run never scanned.
		q({ token: "iherb-old", ingredientId: "row-c", vendor: "Iherb", askedAt: "2026-09-07T03:08:26.328Z" }),
		q({ token: "watsons-zombie", ingredientId: "row-d", vendor: "Watsons", askedAt: "2026-09-07T03:06:10.678Z" }),
	],
	rejected: [],
	moves: { generatedAt: "2026-09-08T02:05:00.000Z", reconfirmed: 56, moves: [] } as any,
};

const merged = mergeVendorReview(laptopPushed as any, cloudHas as any, visitedPair);
const tokens = merged.pending.map((p) => p.token).sort().join(",");
eq("the other runner's fresh question survives our push", tokens, "iherb-new,ntuc-new");
check("…and our own stale copy of it does not", !merged.pending.some((p) => p.token === "iherb-old"));
// ⚠️ The card the laptop had just RETIRED. Our copy still listed it, and re-applying our
// copy wholesale is what brought it back onto the page.
check("a question the other runner retired stays retired", !merged.pending.some((p) => p.token === "watsons-zombie"));
check("our own pair's question is kept", merged.pending.some((p) => p.token === "ntuc-new"));
// ⚠️ Standing refusals are only ever added by a tap, so the union is the only safe rule.
eq("a refusal recorded by the other side is not lost", merged.rejected.length, 1);
eq("…and the moves snapshot is this run's", merged.moves?.reconfirmed, 56);

/**
 * ⚠️⚠️ **A standing doubt does not expire, so it was asked forever.** The whey row's
 * recorded pick is 4.8× its cheapest other shop; that `outlier` reason is a fact about the
 * product, not an event, so the same pick was re-queued every sweep — a question already
 * answered by letting the price into the slot. Measured 2026-09-08: 5 of 27 questions one
 * sweep raised were the row's own recorded price and pack.
 */
describe("a pick already in the slot is re-confirmed, not re-asked");

const slotHolds = {
	priceValue: 349,
	sizeValue: 2250,
	urlValue: "https://myprotein.test/p/11052699?variation=17784492",
	itemNameValue: "Essential Whey Protein 2.25kg - 90servings Strawberry Cream",
};
const samePack = {
	url: "https://myprotein.test/p/11052699?variation=17784492",
	name: "Essential Whey Protein 2.25kg - 90servings Strawberry Cream",
	priceSgd: 349,
};

check("the same listing at the same price and pack is unchanged", isRecordedUnchanged(slotHolds, samePack, 2250));
check("a price move is not unchanged", !isRecordedUnchanged(slotHolds, { ...samePack, priceSgd: 359 }, 2250));
check("a pack change is not unchanged", !isRecordedUnchanged(slotHolds, samePack, 2000));

/**
 * ⚠️⚠️ **Identity is required, not just the numbers.** A different product costing the
 * same for the same weight is a SUBSTITUTION — passing it on price alone would silently
 * repoint the slot's URL and item name at another product without asking.
 */
check(
	"a different product at the identical price and pack still asks",
	!isRecordedUnchanged(slotHolds, { url: "https://myprotein.test/p/other", name: "Impact Whey 2.25kg", priceSgd: 349 }, 2250),
);
// A shop that re-words its own title has not changed the product — the URL still says so.
check(
	"…but the same URL under a re-worded title does not",
	isRecordedUnchanged(slotHolds, { ...samePack, name: "Essential Whey Protein 2.25kg Strawberry" }, 2250),
);
// An empty slot has nothing to be unchanged against.
check("an empty slot is never 'unchanged'", !isRecordedUnchanged({ priceValue: null, sizeValue: null }, samePack, 2250));

/**
 * ⚠️ **Four tabs, and no JavaScript in them** (user, 2026-09-09). Radio inputs plus a
 * sibling selector, so with scripting off every section is simply shown — the same
 * standard the deck holds itself to. A tabbed page that goes blank without JS would hide
 * the queue rather than degrade it.
 */
describe("the review page groups its cards into tabs");

// ⚠️ A distinct ingredientId per card on purpose: a DECK is one row at one shop, so
// cards sharing an id are one deck and take their tab from the row, not the card.
const catCard = (token: string, category: string) =>
	pend({ token, ingredientId: `row-${token}`, rank: 0, reasons: [], category });
const tabbedPage = renderReviewPage(
	[
		catCard("f1", "[3] Fruits/Vegetables"),
		catCard("s1", "Suppliments"),
		catCard("s2", "Protein Powder"),
		catCard("h1", "Household Supplies"),
		catCard("c1", "Cosmetics/ Tooth paste etc"),
	] as any,
	{ repo: "o/r" },
);
for (const k of ["food", "supplements", "household", "cosmetics"]) {
	check(`${k} has a radio, a label and a panel`, tabbedPage.includes(`id="tab-${k}"`) && tabbedPage.includes(`for="tab-${k}"`) && tabbedPage.includes(`class="panel p-${k}"`));
}
// ⚠️ Counts are per CARD, not per deck — a deck of three is three prices to decide.
check("supplements counts both of its rows", /Supplements <span class="n">2<\/span>/.test(tabbedPage));
check("cosmetics counts its one", /Cosmetics <span class="n">1<\/span>/.test(tabbedPage));
// ⚠️ The floor when CSS or scripting fails: panels are display:block until a radio is
// checked, so the queue is never hidden by a stylesheet that did not load.
check("panels are shown before any radio is checked", tabbedPage.includes(".panel { display:block; }"));
check("hiding only begins once a radio IS checked", tabbedPage.includes(".tabin:checked ~ .panel { display:none; }"));

/**
 * ⚠️ `groupOf` matches a normalised SUBSTRING, never the exact option text: this database
 * spells it `Suppliments`, and has shipped `[5[ Sugar/Sweetners` and `Don'r Search` too.
 */
describe("a category lands in the right tab despite the spelling");

eq("the database's own spelling", groupOf("Suppliments"), "supplements");
eq("…and the correct one", groupOf("Supplements"), "supplements");
eq("protein powder is a supplement", groupOf("Protein Powder"), "supplements");
eq("household supplies", groupOf("Household Supplies"), "household");
eq("cosmetics and toothpaste", groupOf("Cosmetics/ Tooth paste etc"), "cosmetics");
eq("a food category", groupOf("[1] Meats/Dairy/Proteins"), "food");
// ⚠️ Food is the fallback, so a blank or renamed value lands there rather than vanishing.
eq("a blank category is food, not nowhere", groupOf(""), "food");
eq("an unrecognised one is food too", groupOf("Something New"), "food");
