import { stem, tokens } from "./match.js";
import type { StoreProduct } from "./stores/types.js";

/**
 * Per-item exclusions — the page's "Mismatch item" and "Almost, but no" buttons.
 *
 * The matcher in `match.ts` is a general engine: it knows that "3 in 1" is a
 * drink mix and that "tissue" is not food, because those rules were written into
 * it after seeing a bad match. This module is the OTHER half — the corrections a
 * user makes from their phone, on the item they were looking at, without editing
 * code:
 *
 *   terms    — words that must never appear in a candidate for this item again.
 *              "Instant Coffee" matched "Indocafe 3 in 1": excluding "3 in 1"
 *              calibrates every later search, not just today's.
 *   products — one specific product, blocked for this item. For a near-miss that
 *              is genuinely close but can't be confirmed (the item wants
 *              unpasteurized and the shop simply doesn't say), there is no word
 *              to exclude — the product itself is the answer.
 *
 * Both are keyed by `cooldownKey` (the item's stemmed base noun), the same key
 * cooldowns use, so a correction made on "Onion (White)" also applies to
 * "Onion (not red)" — they are one shopping decision spelled two ways.
 *
 * Pure module (no I/O): file persistence lives in `exclusions-file.ts`, so the
 * static page builder, the daily scan and the privileged workflow all share one
 * definition of what an exclusion means.
 */

/** A word or phrase that disqualifies a candidate for this item. */
export interface ExcludedTerm {
	/** Base-noun key this applies to (see `cooldownKey`). */
	key: string;
	/** The word or phrase itself, as the user left it ("3 in 1"). */
	term: string;
	/** The ingredient's display name, so the file explains itself later. */
	name: string;
	/** The product that prompted the exclusion — evidence, never matched on. */
	product: string;
	addedAt: string;
}

/** One specific store product, blocked for this item. */
export interface BlockedProduct {
	key: string;
	store: string;
	product: string;
	/** Product page URL — the identity when the store gives one. */
	url: string;
	name: string;
	/** Why it was blocked ("not pasteurized"), for the file and the log. */
	note: string;
	addedAt: string;
}

export interface ExclusionFile {
	version: 1;
	updatedAt: string;
	terms: ExcludedTerm[];
	products: BlockedProduct[];
}

export const EMPTY_EXCLUSIONS: ExclusionFile = {
	version: 1,
	updatedAt: "",
	terms: [],
	products: [],
};

const collapse = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * A term as a regex over a raw product title.
 *
 * Deliberately NOT the token test the matcher uses for requirements: `tokens()`
 * drops every number, so "3 in 1" tokenizes to `["in"]` — it would match
 * everything and exclude the whole shop. Instead the term's alphanumeric chunks
 * are joined by optional separators, so one written form covers the spellings
 * shops actually use: "3 in 1", "3-in-1" and "3in1" are all the same term.
 *
 * Lookarounds rather than `\b` because a term may start or end with a digit,
 * where `\b` sits in the wrong place: they stop "3 in 1" matching "23 in 10".
 */
export function termRegex(term: string): RegExp | null {
	const chunks = String(term ?? "")
		.toLowerCase()
		.match(/[a-z0-9]+/g);
	if (!chunks?.length) return null;
	return new RegExp(`(?<![a-z0-9])${chunks.join("[\\s\\-_]*")}(?![a-z0-9])`, "i");
}

/**
 * Does this product's title carry the term?
 *
 * A single plain word gets a second chance through the matcher's own tokenizer,
 * so it folds the way every other word in this system folds: "tissue" catches
 * "Bathroom Tissues", "berry" catches "berries", and a synonym-register entry
 * applies here too. The user typed what they saw on one label — the exclusion has
 * to survive the next shop writing it in the plural.
 *
 * Only for a lone word. A phrase goes through the regex alone, because stemming
 * "3 in 1" yields "in", which would exclude the entire shop.
 */
export function termHits(term: string, product: StoreProduct): boolean {
	const title = `${product.name} ${product.brand ?? ""}`;
	const re = termRegex(term);
	if (re?.test(title)) return true;
	if (!/^\s*[a-z]+\s*$/i.test(String(term ?? ""))) return false;
	const folded = tokens(term);
	return folded.length === 1 && new Set(tokens(title)).has(folded[0]);
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
	collapse(a ?? "").toLowerCase() === collapse(b ?? "").toLowerCase() && !!collapse(a ?? "");

/**
 * Is this the blocked product? The URL is the identity where both sides have one
 * — a store renames a product far more often than it re-issues its page — and
 * store + name is the fallback for a listing with no URL.
 */
export function isBlocked(b: BlockedProduct, product: StoreProduct): boolean {
	if (b.url && product.url) return same(b.url, product.url);
	return same(b.store, product.store) && same(b.product, product.name);
}

/**
 * Why this product is excluded for this item, or null if it is fair game.
 * Returns the reason rather than a boolean so the scan can log what it dropped —
 * a silently vanishing product is how a bad exclusion goes unnoticed for weeks.
 */
export function exclusionReason(
	file: ExclusionFile,
	key: string,
	product: StoreProduct,
): string | null {
	for (const t of file.terms ?? []) {
		if (t.key === key && termHits(t.term, product)) return `excluded term "${t.term}"`;
	}
	for (const b of file.products ?? []) {
		if (b.key === key && isBlocked(b, product)) return b.note ? `blocked (${b.note})` : "blocked";
	}
	return null;
}

/** Add terms for a key, skipping any already recorded. Returns what was new. */
export function withExcludedTerms(
	file: ExclusionFile,
	entries: Omit<ExcludedTerm, "addedAt">[],
	now: Date = new Date(),
): { file: ExclusionFile; added: ExcludedTerm[] } {
	const existing = new Set(
		(file.terms ?? []).map((t) => `${t.key}|${collapse(t.term).toLowerCase()}`),
	);
	const added: ExcludedTerm[] = [];
	for (const e of entries) {
		const term = collapse(e.term);
		const id = `${e.key}|${term.toLowerCase()}`;
		if (!term || existing.has(id)) continue;
		existing.add(id);
		added.push({ ...e, term, addedAt: now.toISOString() });
	}
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			terms: [...(file.terms ?? []), ...added],
			products: file.products ?? [],
		},
		added,
	};
}

/** Block one product for a key. Blocking it twice changes nothing. */
export function withBlockedProduct(
	file: ExclusionFile,
	entry: Omit<BlockedProduct, "addedAt">,
	now: Date = new Date(),
): { file: ExclusionFile; added: boolean } {
	const products = file.products ?? [];
	const dupe = products.some(
		(b) =>
			b.key === entry.key &&
			(entry.url && b.url ? same(b.url, entry.url) : same(b.store, entry.store) && same(b.product, entry.product)),
	);
	if (dupe) return { file, added: false };
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			terms: file.terms ?? [],
			products: [...products, { ...entry, addedAt: now.toISOString() }],
		},
		added: true,
	};
}

// Words that carry no product meaning, so they are never worth excluding: units,
// pack words and the connectives that survive the split below. Shorter than the
// matcher's own stop list on purpose — this one only has to keep obvious noise
// out of a suggestion the user is about to read.
const NOISE = new Set([
	"the", "and", "for", "with", "per", "pack", "packs", "packet", "value", "new",
	"ml", "cl", "dl", "kg", "kgs", "gm", "gms", "gram", "grams", "ltr", "litre", "liter",
	"pcs", "pkt", "approx", "about", "each", "assorted", "type", "size", "large", "small",
]);

// Compound forms worth offering whole, because their parts mean nothing apart.
// "3 in 1" is the case that prompted this: split into words it is "in", which no
// exclusion could ever be built from.
const PHRASE_RES = [/\d+\s*-?\s*in\s*-?\s*\d+/gi];

/**
 * The words in a product's title that the item never asked for — the starting
 * suggestion for "Mismatch item".
 *
 * A suggestion, not a decision: the user edits the list before it is saved,
 * because "extra" honestly includes the brand ("Indocafe"), and whether a brand
 * should be banned for an item is a judgement only they can make.
 *
 * Both sides are stemmed through the matcher, so a word the item DOES ask for is
 * never suggested in one of its other forms ("coffee" vs "coffees").
 */
export function suggestExclusionTerms(itemText: string, title: string, max = 6): string[] {
	const mine = new Set(tokens(itemText));
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const v = collapse(raw);
		const k = v.toLowerCase();
		if (v && !seen.has(k) && out.length < max) {
			seen.add(k);
			out.push(v);
		}
	};

	// Phrases first, and removed from the text, so their parts are not offered
	// again as useless single words.
	let rest = String(title ?? "");
	for (const re of PHRASE_RES) {
		rest = rest.replace(re, (m) => {
			push(m.replace(/\s*-\s*/g, " ").toLowerCase());
			return " ";
		});
	}

	for (const w of rest.toLowerCase().match(/[a-z]+/g) ?? []) {
		if (w.length < 3 || NOISE.has(w)) continue;
		const s = stem(w);
		if (!s || mine.has(s)) continue;
		push(w);
	}
	return out;
}
