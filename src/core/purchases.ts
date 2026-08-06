import type { AddPayload } from "./grocery-list.js";
import { groceryRowTitle, vendorLabel } from "./grocery-list.js";

/**
 * The purchase log — every item ever pushed onto the Notion grocery list.
 *
 * This exists because **`cooldowns.json` is not a history**. `withCooldown` and
 * `withoutCooldown` both drop expired entries on every write, by design: that
 * file answers "what is being suppressed right now", and an entry that has
 * served its purpose is dead weight there. So the record of what was actually
 * bought had to live somewhere of its own.
 *
 * Append-only, and never trimmed. It is the only place the system remembers a
 * price it once saw, which makes it the seed of price history — the thing the
 * daily scan discards the moment a product goes back to full price.
 *
 * Each entry is what the history page needs to offer its three buttons, without
 * re-reading Notion or the store: the product, its price and pack size, the shop,
 * and the ingredient the deal was found for.
 *
 * Pure module (no I/O). File persistence lives in `purchases-file.ts`.
 */

/** What was done with a purchase afterwards — drives which buttons still show. */
export type PurchaseOutcome =
	/** Nothing yet: all three buttons are live. */
	| "open"
	/** "Add to Ingredients" created a new row. */
	| "added"
	/** "Replace Current" repointed the existing ingredient at this product. */
	| "replaced"
	/** "Never buy again" — the product is blocked; it drops off the bought list. */
	| "never";

export interface PurchaseEntry {
	/** Stable id, so an action can name exactly one row of this file. */
	id: string;
	/** Notion page id of the ingredient the deal was found for. */
	ingredientId: string;
	/** The ingredient's display name at the time of purchase. */
	ingredientName: string;
	/** Base-noun cooldown key (see `cooldownKey`). */
	key: string;
	store: string;
	/** The store's own product name — this is what gets added or blocked. */
	product: string;
	priceSgd: number;
	/** Pack size in grams/ml. Null when the shop published neither. */
	packSizeG: number | null;
	volumetric: boolean;
	url: string;
	/** The grocery-list row title this created ("Milk" — the vendor is its own column). */
	listTitle: string;
	addedAt: string;
	outcome: PurchaseOutcome;
	/** When the outcome stopped being "open", and a one-line note about it. */
	resolvedAt?: string;
	note?: string;
}

export interface PurchaseFile {
	version: 1;
	updatedAt: string;
	entries: PurchaseEntry[];
}

export const EMPTY_PURCHASES: PurchaseFile = { version: 1, updatedAt: "", entries: [] };

/**
 * A short, stable, human-readable id.
 *
 * Deliberately derived from the purchase itself rather than random: the same
 * add re-submitted twice (a double-tap, or an issue re-run) lands on the same
 * id, so `withPurchase` can recognise it as the same event instead of logging
 * the pack twice. The timestamp is included at minute precision so genuinely
 * buying the same thing again next month is a new entry, not a silent no-op.
 */
export function purchaseId(p: {
	key: string;
	store: string;
	product: string;
	addedAt: string;
}): string {
	const slug = `${p.key}-${p.store}-${p.product}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);
	return `${slug}-${p.addedAt.slice(0, 16).replace(/[^0-9]/g, "")}`;
}

/** Turn a successful Add into a log entry. */
export function purchaseFromAdd(p: AddPayload, now: Date = new Date()): PurchaseEntry {
	const addedAt = now.toISOString();
	return {
		id: purchaseId({ key: p.key, store: p.store, product: p.product, addedAt }),
		ingredientId: p.ingredientId,
		ingredientName: p.ingredient,
		key: p.key,
		store: vendorLabel(p.store),
		product: p.product,
		priceSgd: p.priceSgd,
		packSizeG: p.packSizeG,
		volumetric: p.volumetric,
		url: p.url,
		listTitle: groceryRowTitle(p),
		addedAt,
		outcome: "open",
	};
}

/**
 * Append a purchase. Re-adding the same id changes nothing — the log records
 * what was bought, and a retried workflow is not a second trip to the shop.
 *
 * Newest first, because that is the order the page reads them in and the order
 * you care about: what did I just buy, and have I filed it yet.
 */
export function withPurchase(
	file: PurchaseFile,
	entry: PurchaseEntry,
	now: Date = new Date(),
): { file: PurchaseFile; added: boolean } {
	const entries = file.entries ?? [];
	if (entries.some((e) => e.id === entry.id)) return { file, added: false };
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			entries: [entry, ...entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
		},
		added: true,
	};
}

/**
 * Record what happened to a purchase. Returns the updated entry so the caller
 * can report on it, and null when the id isn't in the file — which is a real
 * possibility (a hand-edited file, a payload from an old page) and is reported
 * rather than silently creating a phantom entry.
 */
export function withOutcome(
	file: PurchaseFile,
	id: string,
	outcome: PurchaseOutcome,
	note: string,
	now: Date = new Date(),
): { file: PurchaseFile; entry: PurchaseEntry | null } {
	const entries = file.entries ?? [];
	const found = entries.find((e) => e.id === id);
	if (!found) return { file, entry: null };
	const updated: PurchaseEntry = {
		...found,
		outcome,
		resolvedAt: now.toISOString(),
		note,
	};
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			entries: entries.map((e) => (e.id === id ? updated : e)),
		},
		entry: updated,
	};
}

/**
 * Mark every open purchase of a product as "never" — the "Never buy again"
 * button. Blocking a product is a statement about the PRODUCT, so it settles
 * every outstanding row naming it, not just the one whose button was tapped;
 * leaving the others open would put the same dead product back on tomorrow's
 * page with a live Add button.
 *
 * Only `open` rows are touched: one already filed as added or replaced is a
 * historical fact, and rewriting it would lose what actually happened.
 */
export function withNeverBuy(
	file: PurchaseFile,
	match: { store: string; product: string; url: string },
	note: string,
	now: Date = new Date(),
): { file: PurchaseFile; count: number } {
	const same = (a: string, b: string) =>
		a.trim().toLowerCase() === b.trim().toLowerCase() && !!a.trim();
	const hits = (e: PurchaseEntry) =>
		e.outcome === "open" &&
		(match.url && e.url ? same(e.url, match.url) : same(e.store, match.store) && same(e.product, match.product));

	const entries = file.entries ?? [];
	const count = entries.filter(hits).length;
	if (!count) return { file, count: 0 };
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			entries: entries.map((e) =>
				hits(e) ? { ...e, outcome: "never" as const, resolvedAt: now.toISOString(), note } : e,
			),
		},
		count,
	};
}

/** The rows the "Bought" section shows: still open, newest first. */
export function openPurchases(file: PurchaseFile): PurchaseEntry[] {
	return (file.entries ?? []).filter((e) => e.outcome === "open");
}

/** The rows the "Already filed" section shows: added or replaced, newest first. */
export function filedPurchases(file: PurchaseFile): PurchaseEntry[] {
	return (file.entries ?? []).filter((e) => e.outcome === "added" || e.outcome === "replaced");
}
