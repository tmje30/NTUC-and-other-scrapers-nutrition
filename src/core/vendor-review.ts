import type { StoreProduct } from "./stores/types.js";

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
	| { kind: "outlier"; factor: number; note: string };

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
 */
export function statesSizeRange(text: string): boolean {
	return /\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*-?\s*(?:g|gm|gram|kg|ml|l|lt|litre|liter)\b/i.test(
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
		referencePer100g = null,
		rescued = false,
		rejectedCheaper = 0,
		autoHandle = false,
	}: {
		/** What this pack weighs, per `packWeightOf` — null for a piece-priced pack. */
		packGrams: number | null;
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

	if (packGrams != null && packGrams >= BULK_GRAMS) {
		out.push({
			kind: "bulk",
			grams: packGrams,
			note: `${sizeText(packGrams, product.volumetric)} pack — catering size, not a weekly shop`,
		});
	} else if (statesMultipack(text)) {
		out.push({ kind: "bulk", grams: packGrams ?? 0, note: "a multipack, not a single pack" });
	}

	if (statesSizeRange(text)) {
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
	unitType: string;
	vendor: string;
	slotN: number;
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
	rejectedAt: string;
}

export interface VendorReviewFile {
	version: 1;
	updatedAt: string;
	pending: PendingReview[];
	rejected: RejectedPick[];
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
 * ⚠️ **A stale question is dropped, not answered.** A pending pick quotes a price that
 * was true when the scan ran; tapping OK on a fortnight-old question would write a price
 * the shop has since changed. The scan re-queues anything still uncertain, so dropping
 * costs nothing but a repeat.
 */
export const PENDING_TTL_DAYS = 7;

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
 * The header that precedes the cards.
 *
 * ⚠️ It states what happens on each button, because the two are **not** opposites and
 * guessing wrong is costly in one direction. "Don't use" is about the price book alone;
 * the deals page is untouched either way, and the button that removes something from the
 * deals page is a different one, on the page itself.
 */
export function renderReviewHeader(count: number, written: number): string {
	return (
		`🧾 <b>${count} price${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your call</b>` +
		(written ? ` · ${written} clear one${written === 1 ? "" : "s"} recorded already` : "") +
		`\n<b>OK</b> records it in the price book. <b>Don't use</b> doesn't.\n` +
		`<i>Either way it still shows on your deals page — to drop it from there too, use Ignore on the page itself.</i>`
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
