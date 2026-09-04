import type { StoreProduct } from "./stores/types.js";
import type { PriceMove } from "./vendor-scan.js";
import { marketplaceSize } from "./marketplace-size.js";

/**
 * The scan's third answer: **"I found something, but I'm not sure."**
 *
 * Until now `vendor-scan` had two outcomes — write it, or find nothing — and a pack
 * it was uneasy about went into the price book exactly as confidently as one it was
 * certain of. The 2026-08-11 report is what prompted this: it would have filed a
 * **10 kg sack of carrots**, a **12 × 1 L case of milk** and **5 L of soy sauce** as
 * the Sheng Siong price for those rows. Each is the honest cheapest per kilo and none
 * is a pack anyone would buy.
 *
 * So an uncertain pick is now queued instead of written, and asked about over Telegram
 * with two buttons. The user's framing (2026-08-11):
 *
 *   > leave the large packages and sizes for me to decide … let me pick Ok or Don't use
 *   > but just because it is 'Don't use' does not mean it should not show up in
 *   > Discount page. (if i don't want it there either, it will be put into the
 *   > 'ignore forever' option.)
 *
 * ⚠️ **That last sentence is the whole design constraint of this module, and it is why
 * this is not an entry in `exclusions.ts`.** The two mean different things:
 *
 * | | scope | effect on the deals page |
 * | --- | --- | --- |
 * | **Don't use** (here) | the PRICE BOOK, for one row at one shop | **none — it still appears** |
 * | **Ignore forever** (`exclusions.ts`, `ALL_ITEMS`) | every search, everywhere | gone from the page too |
 *
 * A rejection here says "this is not the pack I'd record as my price at this shop". It
 * says nothing about whether the product is a good deal, which is a different question
 * the deals page is entitled to keep answering. Writing these into the exclusion file
 * would silently answer both at once, and the user would have lost the ability to say
 * only the first.
 *
 * Pure module — no I/O, no Telegram. Persistence is `vendor-review-file.ts`.
 */

/** Why the scan wants a human to look. Ordered most- to least-alarming when shown. */
export type ReviewReason =
	| { kind: "bulk"; grams: number; note: string }
	| { kind: "size-range"; note: string }
	| { kind: "floor-rescue"; note: string }
	| { kind: "auto-handle"; note: string }
	| { kind: "undercut"; rejected: number; note: string }
	| { kind: "outlier"; factor: number; note: string }
	/**
	 * ⚠️ **The cheaper-only rule.** This shop already has a price recorded on this row
	 * and today's find is DEARER, so it is queued instead of written. See
	 * `dearerThanRecorded`.
	 */
	/**
	 * ⚠️ `perWord` and `vendor` are carried so `review.html` can lay the comparison out
	 * as a table instead of a sentence — the two figures side by side, the new one
	 * coloured by direction. `note` stays the one-line form, because Telegram has no
	 * table and a message must still read as a message.
	 */
	| {
			kind: "dearer-than-recorded";
			recordedPer1000: number;
			foundPer1000: number;
			perWord?: string;
			vendor?: string;
			note: string;
	  }
	/**
	 * ⚠️⚠️ **A suggestion, not a find.** No product this shop returned actually MATCHED
	 * the row, but one landed in the review band — plausible, unconfirmed. Without this
	 * the pair simply goes quiet, and quiet is indistinguishable from "this shop does not
	 * stock it".
	 *
	 * ⚠️ It can never be written by the scan: carrying a reason at all is what routes a
	 * pick to the queue instead of the write path, and this one is always present.
	 */
	| { kind: "near-miss"; note: string };

/**
 * **The cheaper-only rule: a scan may lower a recorded price, never raise one.**
 *
 * A find cheaper than what this shop already has is written as before. A dearer one is
 * queued for the user instead — one direction automatic, the other by hand.
 *
 * ⚠️⚠️ **Nothing enforced this until 2026-08-22, and the hole was total.**
 * `chooseVendorSlot` returns `update` the moment a slot names the shop being written,
 * with no price comparison at all — the cheaper-than-the-dearest test beside it lives
 * in the *eviction* branch, which `recordVendorPrice` disables outright. And
 * `referencePer100g`, the one comparison that did run, deliberately EXCLUDES the slot
 * being written: it guards against counterfeits by comparing with the row's *other*
 * shops, and only speaks up at 3×. So Guardian at $8.50 could become Guardian at
 * $12.00 in silence — 1.4× is under the flag, and the slot names Guardian.
 *
 * Run by hand that was survivable, because someone read the output. On a daily
 * unattended sweep, recorded prices could only drift upward: every morning another
 * chance to overwrite a good price with a worse one, and nothing to push them back.
 *
 * ⚠️ **A dearer find is QUEUED, never discarded** (user's call, 2026-08-22). A strict
 * "never go up" rule would freeze a stale price forever the day a shop genuinely
 * raises it or drops the pack. The review card states both figures and one tap
 * accepts it — but **the recorded price is never replaced automatically**.
 *
 * ⚠️ **The comparison is against THIS shop's own recorded price**, not the row's
 * cheapest. Each slot is one shop's price for this item; a Guardian find is not
 * disqualified by Sheng Siong being cheaper. That is exactly what `referencePer100g`
 * does *not* do, which is why it cannot be reused here.
 *
 * ⚠️ **Both figures come from `pricePer1000` — `price / size * 1000`, the same
 * expression Notion's own `Cheapest Price/Kg` formula uses.** Not `packWeightOf`:
 * that resolves a By-Unit pack to grams and can take its answer from the *item name*,
 * so a recorded pack and a candidate pack could be measured on different bases and
 * ranked against each other meaninglessly. Dividing by the stored `Size` is
 * like-for-like within a row by construction, and on a By-Unit row it is proportional
 * to the per-kilo figure anyway (grams = size × grams-per-unit), so the ordering is
 * identical where both exist.
 *
 * Returns `null` — meaning "nothing to say, carry on and write" — when the slot holds
 * no comparable price yet. An empty slot is the case this feature does not touch.
 */
export function dearerThanRecorded(args: {
	/** The shop, named as the `Vendor n` option, for the message. */
	vendor: string;
	/** `pricePer1000` of what is already in the slot; null when there is nothing to protect. */
	recordedPer1000: number | null;
	/** `pricePer1000` of the candidate about to be written. */
	foundPer1000: number | null;
	/** What the slot literally holds, e.g. `$2.40 / 20 pcs`. */
	recordedText?: string;
	/** What would replace it, same shape. */
	foundText?: string;
	/** What `pricePer1000` means on this row: `kg`, `L`, or `1000 pcs`. */
	perWord?: string;
}): ReviewReason | null {
	const { recordedPer1000, foundPer1000 } = args;
	if (recordedPer1000 == null || foundPer1000 == null) return null;
	// ⚠️ Strictly dearer. An equal price is not a regression, and re-writing it
	// refreshes the URL and item name on a slot that may have gone stale.
	if (foundPer1000 <= recordedPer1000) return null;

	/**
	 * ⚠️⚠️ **The message quotes PRICE AND SIZE, not just the per-kilo figure, and the
	 * first live run is why.** A wholemeal loaf recorded at `$2.40 / 20 pcs` was matched
	 * at `$2.40 / 17 pcs` — the same money for three fewer slices, correctly dearer per
	 * slice — but BOTH sides render as `$4.00/kg`, because `perLabel` derives grams from
	 * the row's declared 600g in either case. The card read "$4.00/kg → $4.00/kg —
	 * DEARER", which is unanswerable: the decision was right and the evidence for it
	 * was invisible. Quoting what actually changed makes every card self-explaining.
	 */
	const per = args.perWord ?? "1000";
	const side = (text: string | undefined, per1000: number) =>
		`${text && text.trim() ? `${text} = ` : ""}$${per1000.toFixed(2)}/${per}`;

	return {
		kind: "dearer-than-recorded",
		recordedPer1000,
		foundPer1000,
		perWord: per,
		vendor: args.vendor,
		note:
			`DEARER than the ${args.vendor} price already recorded: ` +
			`${side(args.recordedText, recordedPer1000)} → ${side(args.foundText, foundPer1000)}. ` +
			`Not written — accept only if the old price is gone.`,
	};
}

/**
 * A pack big enough that "cheapest per kilo" stops describing a shopping decision.
 *
 * Deliberately low. Over-asking costs one tap; under-asking writes a 10 kg sack into a
 * live database and the user finds out weeks later when the price book says their
 * carrots cost $1.55/kg and the shelf says $3.20.
 */
export const BULK_GRAMS = 2000;

/** A pack this many times the row's own recorded pack is a different kind of purchase. */
export const BULK_FACTOR = 3;

/** How far a per-unit price may sit from the row's existing reference before it is odd. */
export const OUTLIER_FACTOR = 3;

const collapse = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Does this text state a size as a RANGE — "600-700 g", "banana-12-15-kg"?
 *
 * ⚠️ A range is read at its TOP by the size parsers, which flatters the per-kilo figure
 * in exactly the direction that makes a pack look like a bargain: a "600-700 g" cabbage
 * recorded as 700 g prices 14% below what a 600 g one would. Worth a human glance rather
 * than a silent optimistic read.
 *
 * The URL slug is searched as well as the name because shops routinely put the size in
 * the slug and not the title (`…-pisang-berangan-banana-12-15-kg`).
 *
 * ⚠️ **Callers must not hand it a slug when the NAME already resolves** — see the
 * precedence note in `reviewReasons`. Carousell's slug writes a decimal as a hyphen, so
 * `2.1kg` arrives here as `2-1kg` and reads as a range that does not exist.
 *
 * ⚠️ **`lb`/`oz` are in the unit list deliberately.** They were missing until
 * 2026-08-31, which made this blind to `1.6-5 LBS` — the exact string
 * `stores/carousell.ts` cites as the canonical hazard, on the one shop where pounds
 * dominate. `marketplaceSize` rejects that title as a range; this function said it was
 * fine. Two range detectors that disagree are worse than one.
 */
export function statesSizeRange(text: string): boolean {
	return /\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*-?\s*(?:g|gm|gram|kg|ml|l|lt|litre|liter|lbs?|pounds?|ozs?)\b/i.test(
		String(text ?? "").replace(/-/g, "-"),
	);
}

/** A multipack stated as a count times a size — "12 x 1 L", "50 x 1.5g". */
export function statesMultipack(text: string): boolean {
	return /\b\d{1,3}\s*[x×]\s*\d+(?:\.\d+)?\s*(?:g|gm|kg|ml|l|lt)\b/i.test(String(text ?? ""));
}

/**
 * Everything about this pick that a human should be asked about, or an empty list when
 * the scan is confident.
 *
 * `reference` is the cheapest per-100g already recorded for the row at ANOTHER shop —
 * the same figure the counterfeit floor uses, and null on a row with no price yet, which
 * is most of them.
 */
export function reviewReasons(
	product: StoreProduct,
	{
		packGrams,
		sizeCeilingOk = false,
		referencePer100g = null,
		rescued = false,
		rejectedCheaper = 0,
		autoHandle = false,
	}: {
		/** What this pack weighs, per `packWeightOf` — null for a piece-priced pack. */
		packGrams: number | null;
		/**
		 * The row states a `Size - Ceiling (g/ml)` and this pack is inside it.
		 *
		 * ⚠️ Suppresses the `bulk` reason and nothing else. `BULK_GRAMS` is a guess about
		 * where "a shop" becomes "a caterer", made with no knowledge of the item; a ceiling
		 * the user typed on that row is the same judgement made with full knowledge of it,
		 * and asking anyway would be asking a question Notion already answers. A 2.5 kg tub
		 * of whey on a row that says 10 kg is simply the pack they buy.
		 *
		 * The multipack test below still runs: "12 × 1 L" is a statement about how the pack
		 * is SOLD, which a size ceiling has no opinion on.
		 */
		sizeCeilingOk?: boolean;
		referencePer100g?: number | null;
		/** Allowed back in on seller reputation despite being under the price floor. */
		rescued?: boolean;
		/** Cheaper listings dropped as implausible. */
		rejectedCheaper?: number;
		autoHandle?: boolean;
	},
): ReviewReason[] {
	const out: ReviewReason[] = [];
	const text = `${product.name ?? ""} ${product.url ?? ""}`;

	if (!sizeCeilingOk && packGrams != null && packGrams >= BULK_GRAMS) {
		out.push({
			kind: "bulk",
			grams: packGrams,
			note: `${sizeText(packGrams, product.volumetric)} pack — catering size, not a weekly shop`,
		});
	} else if (statesMultipack(text)) {
		out.push({ kind: "bulk", grams: packGrams ?? 0, note: "a multipack, not a single pack" });
	}

	/**
	 * ⚠️ **The slug is a FALLBACK here, not an equal source** — the same precedence
	 * `cardSize` documents, and for the same reason.
	 *
	 * Carousell's slug writes a decimal as a hyphen: `2.1kg` becomes
	 * `…/titan-whey-protein-2-1kg-70-serving-…`, which reads as the range "2–1 kg".
	 * It is not a range, and "2 to 1 kg" is not even ascending. Measured 2026-08-31:
	 * **all three pending Carousell reviews were this false positive**, and every one
	 * had a clean, decimal-restored name stating a single size.
	 *
	 * ⚠️ A queue full of questions that were never uncertain is not a harmless bug — it
	 * is how a review page stops being read, and the review page is the only thing
	 * standing between a marketplace guess and the price book.
	 *
	 * So: when the NAME resolves to one unambiguous size, believe it and do not
	 * range-check the slug. Only a name `marketplaceSize` cannot resolve falls back to
	 * the slug — which is exactly where genuine ranges still get caught, because
	 * `marketplaceSize` rejects `600-700 g` and `12-15 kg` as ranges in the first place.
	 */
	const namedSize = marketplaceSize(product.name ?? "");
	if (statesSizeRange(namedSize.ok ? (product.name ?? "") : text)) {
		out.push({
			kind: "size-range",
			note: "the pack size is a RANGE and was read at its top — the real pack may be smaller (and dearer per kg)",
		});
	}

	if (rescued) {
		out.push({
			kind: "floor-rescue",
			note: "under the price floor, allowed only on the seller's reputation — reviews say a deal completes, not that goods are genuine",
		});
	}

	if (autoHandle) {
		out.push({ kind: "auto-handle", note: "the seller's handle was never personalised" });
	}

	if (rejectedCheaper > 0) {
		out.push({
			kind: "undercut",
			rejected: rejectedCheaper,
			note: `${rejectedCheaper} cheaper listing${rejectedCheaper === 1 ? " was" : "s were"} rejected as implausible`,
		});
	}

	// Only meaningful when another shop has already priced this row.
	if (referencePer100g != null && referencePer100g > 0 && product.pricePer100g != null) {
		const factor = product.pricePer100g / referencePer100g;
		if (factor >= OUTLIER_FACTOR || factor <= 1 / OUTLIER_FACTOR) {
			out.push({
				kind: "outlier",
				factor,
				note:
					factor >= OUTLIER_FACTOR
						? `${factor.toFixed(1)}× DEARER than this row's other shop`
						: `${(1 / factor).toFixed(1)}× cheaper than this row's other shop`,
			});
		}
	}

	return out;
}

/** Format grams/ml the way the rest of the project does. */
export function sizeText(n: number, volumetric = false): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return n >= 1000 ? `${+(n / 1000).toFixed(2)}${big}` : `${Math.round(n)}${small}`;
}

/** One pick awaiting a tap. Held in the file so it survives a poller restart. */
export interface PendingReview {
	/** Short opaque token — Telegram caps `callback_data` at 64 bytes. */
	token: string;
	ingredientId: string;
	ingredientName: string;
	/** `cooldownKey` of the row's base noun — what `exclusions.ts` keys a block by. */
	key: string;
	unitType: string;
	vendor: string;
	slotN: number;
	/**
	 * The `[bracketed]` brand from the row's Name, when it has one. Decides whether the
	 * "Wrong brand" reason is offered — `Brand Specific` has nothing to enforce without it.
	 */
	brand?: string;
	/** Exactly what would be written, so the answer records what was actually shown. */
	priceSgd: number;
	size: number;
	url: string;
	itemName: string;
	/** The human-readable per-unit figure quoted in the message. */
	perLabel: string;
	reasons: ReviewReason[];
	/** The prompt message, so its buttons can be replaced with the outcome. */
	messageId?: number;
	chatId?: number;
	askedAt: string;
}

/**
 * A pick the user said **Don't use** to.
 *
 * ⚠️ Scoped to one ingredient AND one shop, never global. The same 5 L bottle of soy
 * sauce may be exactly the right record for a different row, and is certainly still a
 * legitimate deal for the deals page — see this module's header.
 */
export interface RejectedPick {
	ingredientId: string;
	vendor: string;
	/** Product page URL — the identity where the shop gives one. */
	url: string;
	/** Store + product name, the fallback identity for a listing with no URL. */
	store: string;
	product: string;
	/** The ingredient's display name, so the file explains itself later. */
	name: string;
	/** Why it was offered at all — the reasons shown when it was refused. */
	why: string;
	/** Which button was tapped (`REJECT_REASONS`), when one was. */
	reason?: string;
	/**
	 * What the refused pack weighed, so a size complaint can steer the NEXT pick.
	 * Null for a piece-priced pack, where there is no weight to bound.
	 */
	packGrams?: number | null;
	rejectedAt: string;
}

/**
 * Size bounds this row has earned at this shop, from past "pack too large/small" answers.
 *
 * ⚠️ **This is what makes a refusal do more than skip one URL.** Excluding the 10 kg sack
 * alone just promotes the 5 kg sack — the user would be asked the same question every
 * week, in decreasing sizes, forever. Recording "too big at 10 kg" as a ceiling makes the
 * next scan pick something under it and stop asking.
 *
 * Both bounds are EXCLUSIVE of the refused pack: "10 kg is too big" says nothing about
 * whether 9.9 kg is fine, but it does say 10 kg is not, and being wrong in the direction
 * of asking again is the safe one.
 */
export function sizeBoundsFor(
	file: VendorReviewFile,
	ingredientId: string,
	vendor: string,
): { maxGrams: number | null; minGrams: number | null } {
	let maxGrams: number | null = null;
	let minGrams: number | null = null;
	for (const r of file.rejected ?? []) {
		if (!same(r.ingredientId, ingredientId) || !same(r.vendor, vendor)) continue;
		if (r.packGrams == null || r.packGrams <= 0) continue;
		if (r.reason === "too-big" && (maxGrams == null || r.packGrams < maxGrams)) maxGrams = r.packGrams;
		if (r.reason === "too-small" && (minGrams == null || r.packGrams > minGrams)) minGrams = r.packGrams;
	}
	return { maxGrams, minGrams };
}

/**
 * **What the last sweep CHANGED**, kept so a page can render it.
 *
 * ⚠️⚠️ Stored beside the queue rather than in a file of its own, because it has to
 * reach the cloud the same way and `commitAndPushData` commits one path. Splitting it
 * would mean either a second push or a partial one — a page built from half of a run.
 *
 * ⚠️ A snapshot, not a log: it is replaced whole every write sweep and holds no
 * history. Price history lives in the daily scan's commits, which is where the user
 * asked for it.
 */
export interface MovesSnapshot {
	generatedAt: string;
	/** Written at the price already recorded — a count, never itemised. */
	reconfirmed: number;
	moves: PriceMove[];
}

export interface VendorReviewFile {
	version: 1;
	updatedAt: string;
	pending: PendingReview[];
	rejected: RejectedPick[];
	/** The last write sweep's price movements — see `MovesSnapshot`. */
	moves?: MovesSnapshot;
}

export const EMPTY_REVIEW: VendorReviewFile = {
	version: 1,
	updatedAt: "",
	pending: [],
	rejected: [],
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
	collapse(a ?? "").toLowerCase() === collapse(b ?? "").toLowerCase() && !!collapse(a ?? "");

/**
 * Has this exact pick already been refused for this row at this shop?
 *
 * URL first — a shop renames a product far more often than it re-issues its page — with
 * store + name as the fallback, the same identity rule `exclusions.isBlocked` uses.
 */
export function isRejectedPick(
	file: VendorReviewFile,
	ingredientId: string,
	vendor: string,
	product: { url?: string; store?: string; name?: string },
): boolean {
	return (file.rejected ?? []).some((r) => {
		if (!same(r.ingredientId, ingredientId) || !same(r.vendor, vendor)) return false;
		if (r.url && product.url) return same(r.url, product.url);
		return same(r.store, product.store) && same(r.product, product.name);
	});
}

/** Record a refusal. Refusing the same pick twice changes nothing. */
export function withRejectedPick(
	file: VendorReviewFile,
	entry: Omit<RejectedPick, "rejectedAt">,
	now: Date = new Date(),
): { file: VendorReviewFile; added: boolean } {
	if (isRejectedPick(file, entry.ingredientId, entry.vendor, entry)) {
		return { file, added: false };
	}
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			pending: file.pending ?? [],
			rejected: [...(file.rejected ?? []), { ...entry, rejectedAt: now.toISOString() }],
		},
		added: true,
	};
}

/**
 * A token no live pending question is already using.
 *
 * Collisions are avoided by checking the live map rather than by making the token long
 * — there are never more than a handful outstanding. Same rule as `tg-inbox.token`.
 */
export function reviewToken(file: VendorReviewFile): string {
	const taken = new Set((file.pending ?? []).map((p) => p.token));
	let t = "";
	do {
		t = Math.random().toString(36).slice(2, 8);
	} while (taken.has(t));
	return t;
}

/**
 * A question already outstanding about this row/shop/product, if there is one.
 *
 * ⚠️ **Without this the queue grows every run.** The scan re-finds the same 10 kg sack
 * of carrots tomorrow, and an unconditional queue would mint a fresh token, append a
 * second pending record and text the same card again — every day, until answered. The
 * user's inbox is the thing that breaks first, and a person who has been asked the same
 * question five times stops reading the buttons.
 *
 * An outstanding question that has never been SENT (`messageId` unset — the send failed,
 * or the run was `--no-ask`) is a different case: it should be re-offered, reusing its
 * token so the record and the card stay the same question.
 */
export function findPendingFor(
	file: VendorReviewFile,
	ingredientId: string,
	vendor: string,
	product: { url?: string; name?: string },
): PendingReview | undefined {
	return (file.pending ?? []).find(
		(p) =>
			same(p.ingredientId, ingredientId) &&
			same(p.vendor, vendor) &&
			(p.url && product.url ? same(p.url, product.url) : same(p.itemName, product.name)),
	);
}

/** Queue a question. */
export function withPending(
	file: VendorReviewFile,
	entry: PendingReview,
	now: Date = new Date(),
): VendorReviewFile {
	return {
		version: 1,
		updatedAt: now.toISOString(),
		pending: [...(file.pending ?? []).filter((p) => p.token !== entry.token), entry],
		rejected: file.rejected ?? [],
	};
}

/** Take a question off the queue once it has been answered. */
export function withoutPending(
	file: VendorReviewFile,
	token: string,
	now: Date = new Date(),
): VendorReviewFile {
	return {
		version: 1,
		updatedAt: now.toISOString(),
		pending: (file.pending ?? []).filter((p) => p.token !== token),
		rejected: file.rejected ?? [],
	};
}

/**
 * Drop every question about one row's slot at one shop, whatever pick it named.
 *
 * ⚠️ **A question the scan has since ANSWERED BY WRITING must leave the queue, or the
 * review page asks about a price that is already recorded.** Found live on 2026-08-31:
 * three Carousell picks were queued on a false size-range flag, the flag was fixed, the
 * next run wrote all three into Notion — and all three questions stayed on the page.
 * Tapping OK on one would have re-written a price that was already there, and the page
 * would have gone on asking until the 7-day TTL expired it.
 *
 * ⚠️ **Matched on row + shop, NOT on the product**, unlike `findPendingFor`. The unit of
 * the price book is the slot: once a Carousell price is recorded for this row, a question
 * about some *other* Carousell listing for the same row is stale too — answering it would
 * overwrite the newer figure with an older one.
 */
export function withoutPendingForSlot(
	file: VendorReviewFile,
	ingredientId: string,
	vendor: string,
	now: Date = new Date(),
): VendorReviewFile {
	const pending = (file.pending ?? []).filter(
		(p) => !(same(p.ingredientId, ingredientId) && same(p.vendor, vendor)),
	);
	if (pending.length === (file.pending ?? []).length) return file;
	return { version: 1, updatedAt: now.toISOString(), pending, rejected: file.rejected ?? [] };
}

/**
 * ⚠️ **A stale question is dropped, not answered.** A pending pick quotes a price that
 * was true when the scan ran; tapping OK on a fortnight-old question would write a price
 * the shop has since changed. The scan re-queues anything still uncertain, so dropping
 * costs nothing but a repeat.
 */
export const PENDING_TTL_DAYS = 7;

/**
 * Why a pick was refused — and every one of these exists because it changes what the
 * system does NEXT. A free-text "no" teaches nothing; these each route somewhere.
 *
 * ⚠️ **`wrong-item` is the one reason that DOES reach the deals page** — the user's
 * decision, 2026-08-11, asked explicitly because it is the single exception to their own
 * rule that "Don't use" is a price-book decision. The reasoning: *"that is not the
 * product"* is a statement about MATCHING, not about pack size, and a matcher left
 * uncorrected would go on surfacing the same wrong product as a deal for this row forever.
 *
 * It writes a per-item block (`exclusions.withBlockedProduct`, keyed by the ingredient),
 * **never** `ALL_ITEMS` — that stays reserved for the deals page's own red Ignore button,
 * which is the user's "ignore forever". So the product keeps competing for every other
 * item in the database; it just stops being offered for this one.
 *
 * Every other reason here leaves the deals page completely untouched.
 */
export const REJECT_REASONS = [
	{
		key: "too-big",
		label: "Pack too large",
		hint: "right product, catering size",
		/** Re-search preferring packs nearer the row's own size. */
		research: true,
	},
	{
		key: "too-small",
		label: "Pack too small",
		hint: "right product, sample/trial size",
		research: true,
	},
	{
		key: "wrong-item",
		label: "Wrong item",
		hint: "not this product — also stops it appearing as a deal for this row",
		research: true,
	},
	{
		// ⚠️ Only offered when the row's Name carries a [brand] — `brandOnly` below.
		// Without a bracketed brand there is nothing for `Brand Specific` to enforce, and
		// the tag would silently reject every candidate for that row.
		key: "wrong-brand",
		label: "Wrong brand",
		hint: "tags this row Brand Specific, so only the [bracketed] brand matches",
		research: true,
		brandOnly: true,
	},
	{
		key: "missing-property",
		label: "Item is slightly off criteria",
		hint: "unpasteurized, organic, steel-cut, unflavoured…",
		research: true,
	},
	{
		// ⚠️ Not a shopping decision — a PARSER bug report. Every size fault this project
		// has found (the 32 g serving read as 100 g, "2 large" as two litres, a piece count
		// as grams) looked exactly like a suspiciously good price first.
		key: "bad-price",
		label: "Price or size looks misread",
		hint: "the number is wrong, not the product",
		research: false,
	},
] as const;

export type RejectReasonKey = (typeof REJECT_REASONS)[number]["key"];

/** Reasons offered for this pick — brand-only ones need a `[brand]` in the row's Name. */
export function reasonsFor(pick: { brand?: string }): readonly (typeof REJECT_REASONS)[number][] {
	return REJECT_REASONS.filter((r) => !("brandOnly" in r && r.brandOnly) || !!pick.brand);
}

/** Is this a reason we issued? Guards a payload arriving from a hand-edited issue. */
export function isRejectReason(k: string): k is RejectReasonKey {
	return REJECT_REASONS.some((r) => r.key === k);
}

/** Local HTML escape — this module stays free of the Telegram client. */
const h = (s: string) =>
	String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One review card, as Telegram `parse_mode: HTML`.
 *
 * The shape answers the only question the user is being asked — *should this pack be
 * my recorded price at this shop?* — so it leads with the pack and the per-unit figure,
 * then says plainly why it is being asked rather than written. A card that just showed
 * a product and two buttons would make every question look the same.
 */
export function renderReviewCard(p: PendingReview): string {
	const reasons = p.reasons.map((r) => `⚠️ ${h(r.note)}`).join("\n");
	return (
		`🧾 <b>${h(p.ingredientName)}</b> — <b>${h(p.vendor)}</b> (Vendor ${p.slotN})\n` +
		`<a href="${h(p.url)}">${h(p.itemName)}</a>\n` +
		`<b>$${p.priceSgd.toFixed(2)}</b> / ${p.size}${p.unitType === "By Unit" ? " pcs" : p.unitType === "By ml" ? "ml" : "g"}` +
		(p.perLabel ? `  =  <b>${h(p.perLabel)}</b>` : "") +
		(reasons ? `\n${reasons}` : "")
	);
}

/**
 * The single message that links to the review page.
 *
 * ⚠️ **One message for the whole scan, not one per pick.** Sixteen notifications from one
 * run (measured 2026-08-11) trains a person to mute the bot, and the same bot carries the
 * daily digest. The cards live on `review.html`; this just says how many and where.
 *
 * It still states what each button does, because the two are **not** opposites and
 * guessing wrong is costly in one direction: "Don't use" is about the price book alone.
 */
export function renderReviewSummary(count: number, written: number, url?: string): string {
	if (!count) {
		return written
			? `🧾 <b>${written} price${written === 1 ? "" : "s"} recorded.</b> Nothing needed your call.`
			: `🧾 Nothing to record and nothing to check.`;
	}
	return (
		`🧾 <b>${count} price${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your call</b>` +
		(written ? ` · ${written} clear one${written === 1 ? "" : "s"} recorded already` : "") +
		`\n<b>OK</b> records it. <b>Don't use</b> doesn't — the item still shows on your deals page either way.` +
		// ⚠️ No link when the queue never reached the repo: the published page is built
		// from the committed file, so a link would open questions that are not there yet.
		// Saying so is better than sending someone to a page that looks empty.
		(url
			? `\n<a href="${url}">Tap to review →</a>`
			: `\n⚠️ Not published — the queue could not be pushed, so the review page is still showing the previous scan.`)
	);
}

export function prunePending(file: VendorReviewFile, now: Date = new Date()): VendorReviewFile {
	const cutoff = now.getTime() - PENDING_TTL_DAYS * 86_400_000;
	const kept = (file.pending ?? []).filter((p) => {
		const t = Date.parse(p.askedAt);
		return Number.isFinite(t) ? t >= cutoff : false;
	});
	if (kept.length === (file.pending ?? []).length) return file;
	return { version: 1, updatedAt: now.toISOString(), pending: kept, rejected: file.rejected ?? [] };
}
