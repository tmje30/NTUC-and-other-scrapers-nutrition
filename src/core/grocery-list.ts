import { Client } from "@notionhq/client";

/**
 * Pushing a deal onto the user's Notion **grocery List** database.
 *
 * The row is deliberately minimal, per the user's spec:
 *   Name    "Fish Sauce, Knife Brand, 750ml" — the INGREDIENT name (what they
 *           shop for, never the store's marketing name), then the brand and pack
 *           size of the listing that is actually on offer
 *   Price   the discounted price actually being offered
 *   Vendor  the store, in the same words the Ingredients DB uses
 *   Amount  how many to buy — 1 on a new row, +1 on each further tap
 *
 * ⚠️ **`Amount ` was left empty for the user to fill in until 2026-08-09.** Buy now
 * counts: the first tap writes 1, and a second tap on a row still outstanding makes
 * it 2 rather than doing nothing at all. That second tap used to be a deliberate
 * no-op — the dedupe existed so a double-tap couldn't leave two identical lines on
 * the list — and the change keeps that guarantee while giving the repeat press the
 * only meaning it can sensibly have: I want two of these.
 *
 * ⚠️ Name carried a "[NTUC] " prefix until 2026-08-06. The shop was always in the
 * Vendor column too; the prefix duplicated it, and the list reads better as a
 * plain column of names beside a column of shops.
 *
 * Everything here is plain `@notionhq/client`, no filesystem and no repo
 * knowledge, so it runs the same in a script or a serverless handler.
 */

// Stable data-source id for "grocery List " (via introspect; same convention as
// the Ingredients id in notion.ts). Overridable for testing against a copy.
export const GROCERY_LIST_DS =
	process.env.GROCERY_LIST_DS_ID || "3ac69a18-4fe7-802f-8620-000b6053908d";

/**
 * Property names are resolved from the live schema, never hardcoded.
 *
 * This database is edited by hand and its column names drift — trailing spaces,
 * commas, renames ("Price " became "Price , To Buy " and grew a companion
 * "Current Price " in the space of a morning). A hardcoded name turns any such
 * edit into a failed add, so instead we look the columns up by type and by a
 * keyword in the name, and skip anything we can't find rather than throwing.
 */
export interface ListProps {
	/** The title column — required; everything else is best-effort. */
	title: string;
	/** Where the discounted store price goes. */
	price: string | null;
	/** Where the user's own current pack price goes, when the column exists. */
	currentPrice: string | null;
	vendor: string | null;
	done: string | null;
	/** How many to buy. Live name is `"Amount "` — trailing space, like half this DB. */
	amount: string | null;
}

/** Trim, collapse runs of whitespace, lower-case — the shape renames don't change. */
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function resolveListProps(schema: Record<string, { type: string }>): ListProps {
	const entries = Object.entries(schema);
	const byType = (t: string) => entries.filter(([, d]) => d.type === t).map(([n]) => n);
	const pick = (names: string[], has: (n: string) => boolean) => names.find((n) => has(norm(n))) ?? null;

	const numbers = byType("number");
	// "Current Price " is claimed first, so it can't be mistaken for the buy price.
	const currentPrice = pick(numbers, (n) => n.includes("current"));
	const price =
		pick(
			numbers.filter((n) => n !== currentPrice),
			(n) => n.includes("buy"),
		) ??
		pick(
			numbers.filter((n) => n !== currentPrice),
			(n) => n.includes("price"),
		);
	// Claimed last, and excluded from the price candidates above by name rather than
	// by order: "Amount" contains neither "buy" nor "price", so the two can't collide.
	const amount = pick(numbers, (n) => n === "amount" || n.startsWith("amount"));

	return {
		title: byType("title")[0] ?? "Name",
		price,
		currentPrice,
		vendor: pick(byType("rich_text"), (n) => n.includes("vendor")),
		done: byType("checkbox")[0] ?? null,
		amount,
	};
}

async function listProps(client: Client): Promise<ListProps> {
	const ds = (await client.dataSources.retrieve({ data_source_id: GROCERY_LIST_DS })) as any;
	const props = resolveListProps(ds.properties ?? {});
	for (const [field, name] of Object.entries(props)) {
		if (!name) console.error(`Warning: no "${field}" column found on the grocery list — skipping it.`);
	}
	return props;
}

/**
 * Store module name → the vendor wording the user's own Notion uses. FairPrice
 * is "NTUC" everywhere in the Ingredients DB, so the grocery list says NTUC too.
 */
const VENDOR_LABELS: Record<string, string> = {
	FairPrice: "NTUC",
	"Sheng Siong": "Sheng Siong",
};

export function vendorLabel(store: string): string {
	return VENDOR_LABELS[store] ?? store;
}

/**
 * The row title — what you actually have to find in the shop:
 *
 *     Fish Sauce, Knife Brand, 750ml
 *     ↑ ingredient  ↑ brand     ↑ the pack being offered
 *
 * Brand and size are the STORE's, not the ingredient's: this row exists because a
 * particular pack is on offer, and the brand and size are how you pick it off the
 * shelf. Both are optional and each segment is dropped when it is missing, so a
 * shop that publishes no brand still gives a usable line rather than a stray comma.
 *
 * ⚠️ **The brand is used verbatim, never with the word "brand" appended.** Many
 * real brands already end in it — `Tiger Brand`, `Snow Brand`, `House Brand`, five
 * of the 264 in one Sheng Siong scan — and "Snow Brand brand" is how that would
 * read.
 *
 * ⚠️ **A brand the ingredient's own name already states is not repeated.** An
 * ingredient written in the bracket standard as `Fish Sauce [Knife]` would
 * otherwise produce "Fish Sauce [Knife], Knife, 750ml".
 *
 * ⚠️ **It carried a `[NTUC] ` prefix until 2026-08-06.** The shop goes in the
 * list's own `Vendor ` column instead (it always did as well; the prefix was a
 * duplicate of it), because a shopping list reads better as a column of names.
 *
 * ⚠️ **The shop is therefore recorded in exactly one place now.** If
 * `resolveListProps` ever fails to find the vendor column — it looks for a
 * `rich_text` property whose name contains "vendor" — the shop is lost silently,
 * with only a console warning. It used to survive in the title. Live schema as of
 * 2026-08-06 has `"Vendor "` (rich_text, trailing space) and resolves fine.
 */
export function groceryRowTitle(p: { ingredient: string; brand?: string; size?: string }): string {
	const name = p.ingredient.trim();
	const brand = (p.brand ?? "").trim();
	const size = (p.size ?? "").trim();

	const parts = [name];
	if (brand && !name.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
	if (size) parts.push(size);
	return parts.join(", ");
}

/**
 * Everything the Add button hands over. It travels through a GitHub issue body
 * (or a `repository_dispatch` payload), so it must stay small, JSON-safe and
 * readable — the user sees it before submitting.
 */
export interface AddPayload {
	v: 1;
	/** Notion page id of the ingredient, for traceability. */
	ingredientId: string;
	/** The ingredient's own name — this is what goes in the row title. */
	ingredient: string;
	/** Base-noun cooldown key, precomputed at page-build time. */
	key: string;
	store: string;
	/** The store's product name — kept for the cooldown log, not for the row. */
	product: string;
	/**
	 * The store's brand, verbatim, for the row title ("Knife Brand"). Optional:
	 * roughly 4% of Sheng Siong listings publish none, and a payload built before
	 * this field existed simply produces the older, shorter title.
	 */
	brand?: string;
	/**
	 * The offered pack, as it should READ on a shopping list — "750ml", "1.5kg",
	 * "30 pcs". A formatted string rather than a number because the unit is the
	 * point: a counted pack has no weight to show, and `packSizeG` has already
	 * converted one for the cooldown's sake.
	 */
	size?: string;
	/** Discounted (current) price of the store pack, SGD. */
	priceSgd: number;
	/**
	 * What the user pays for their own pack today — the card's yellow "Price".
	 * Optional: payloads built before this field existed simply leave the
	 * "Current Price" column empty rather than failing.
	 */
	myPriceSgd?: number;
	/** Size of the pack being bought, in grams/ml. Drives the cooldown length. */
	packSizeG: number | null;
	/**
	 * Pieces in the pack, where the shop counts instead of weighing (a 30-egg tray).
	 *
	 * ⚠️ **Carried separately from `packSizeG` on purpose, and they are not the same
	 * number.** `packSizeG` above is a *cooldown* figure and is deliberately
	 * converted to grams for a counted pack (30 eggs at 55 g each → 1650 g), because
	 * "how long until I need more" is a question about quantity consumed. The
	 * Ingredients row wants the opposite: the count itself, `By Unit`. Deriving one
	 * from the other in either direction is how a 30-egg tray gets filed as 1650 g.
	 */
	unitCount?: number | null;
	volumetric: boolean;
	/** Monthly usage of the ingredient, grams/ml. 0 when it isn't in the plan. */
	monthlyAmount: number;
	/**
	 * The ingredient is tagged `Weekly Buy` in Notion: the cooldown is a flat 5
	 * days and `packSizeG` is ignored.
	 *
	 * Optional, like `myPriceSgd`: a payload built before this field existed (an
	 * issue still open from an earlier page) parses fine and simply takes the old
	 * pack-size route. Absent is not the same as false in meaning, but it is in
	 * effect, and losing an in-flight add to a schema change would be worse.
	 */
	weeklyBuy?: boolean;
	url: string;
}

/** Narrow an untrusted object (issue body / webhook JSON) into an AddPayload. */
export function parseAddPayload(raw: unknown): AddPayload {
	const o = raw as Record<string, any>;
	if (!o || typeof o !== "object") throw new Error("payload is not an object");
	const str = (k: string, required = true): string => {
		const v = o[k];
		if (typeof v !== "string" || (required && !v.trim())) {
			throw new Error(`payload.${k} must be a non-empty string`);
		}
		return v;
	};
	const num = (k: string): number => {
		const v = Number(o[k]);
		if (!Number.isFinite(v)) throw new Error(`payload.${k} must be a number`);
		return v;
	};
	const priceSgd = num("priceSgd");
	if (priceSgd <= 0) throw new Error("payload.priceSgd must be positive");
	const packSizeG = o.packSizeG == null ? null : Number(o.packSizeG);
	const myPrice = Number(o.myPriceSgd);
	return {
		v: 1,
		ingredientId: str("ingredientId"),
		ingredient: str("ingredient"),
		key: str("key"),
		store: str("store"),
		product: str("product", false),
		// ⚠️ Not `str(k, false)` — that still demands a string and would throw on an
		// issue raised before these fields existed. Absent means "older payload".
		brand: typeof o.brand === "string" && o.brand.trim() ? o.brand : undefined,
		size: typeof o.size === "string" && o.size.trim() ? o.size : undefined,
		priceSgd,
		myPriceSgd: Number.isFinite(myPrice) && myPrice > 0 ? myPrice : undefined,
		packSizeG: packSizeG != null && Number.isFinite(packSizeG) ? packSizeG : null,
		// Same leniency as `brand` and `size`: absent means an older payload, not an
		// error. An issue raised before this field existed must still parse.
		unitCount: Number.isFinite(Number(o.unitCount)) && Number(o.unitCount) > 0 ? Number(o.unitCount) : null,
		volumetric: Boolean(o.volumetric),
		monthlyAmount: Number.isFinite(Number(o.monthlyAmount)) ? Number(o.monthlyAmount) : 0,
		weeklyBuy: Boolean(o.weeklyBuy),
		url: typeof o.url === "string" ? o.url : "",
	};
}

export interface AddResult {
	title: string;
	pageId: string;
	/** True when an identical un-ticked row was already there — its `Amount ` went up by 1. */
	alreadyListed: boolean;
	/** What `Amount ` now reads. Null when the list has no Amount column. */
	amount: number | null;
}

/**
 * Look for an outstanding (un-ticked) row with this exact title, so a double-tap
 * on the Add button doesn't leave two identical lines on the shopping list.
 *
 * ⚠️ **What this dedupes on changed twice on 2026-08-06** — it matches the whole
 * title, and the title's contents moved. Dropping the `[NTUC] ` prefix briefly
 * made it "one row per ingredient, across shops"; adding brand and size narrowed
 * it to **one row per (ingredient, brand, pack size)**.
 *
 * That is the right granularity: the same listing tapped twice collapses to one
 * row, which is the double-tap this exists to stop, while two genuinely different
 * packs list separately because they are different things to buy. A shop that
 * publishes neither brand nor size falls back to matching on the ingredient alone.
 */
async function findOpenRow(client: Client, props: ListProps, title: string): Promise<any | null> {
	const filters: any[] = [{ property: props.title, title: { equals: title } }];
	if (props.done) filters.push({ property: props.done, checkbox: { equals: false } });
	const res = (await client.dataSources.query({
		data_source_id: GROCERY_LIST_DS,
		page_size: 25,
		filter: filters.length > 1 ? { and: filters } : filters[0],
	} as any)) as any;
	// The whole page, not just its id: the repeat tap now bumps `Amount `, and it can
	// only add 1 to a number it has read.
	return res.results[0] ?? null;
}

const money = (n: number) => Math.round(n * 100) / 100;

/** Creates the grocery-list row (or reports the one that's already there). */
export async function addToGroceryList(client: Client, p: AddPayload): Promise<AddResult> {
	const props = await listProps(client);
	const title = groceryRowTitle(p);

	const existing = await findOpenRow(client, props, title).catch(() => null);
	if (existing) {
		// A repeat tap means "make it two". Read-then-add rather than a blind write, so
		// an Amount the user set by hand ("get 3") is added to, never overwritten — the
		// same reasoning as every other write in this project: their column, their value.
		if (!props.amount) return { title, pageId: existing.id, alreadyListed: true, amount: null };
		const before = existing.properties?.[props.amount]?.number;
		const amount = (typeof before === "number" && Number.isFinite(before) ? before : 0) + 1;
		await client.pages.update({
			page_id: existing.id,
			properties: { [props.amount]: { number: amount } },
		} as any);
		return { title, pageId: existing.id, alreadyListed: true, amount };
	}

	// Built up conditionally: a column the schema no longer has is skipped, not
	// sent — Notion rejects the whole request for one unknown property name.
	const properties: Record<string, unknown> = {
		[props.title]: { title: [{ text: { content: title } }] },
	};
	if (props.price) properties[props.price] = { number: money(p.priceSgd) };
	if (props.currentPrice && p.myPriceSgd) {
		properties[props.currentPrice] = { number: money(p.myPriceSgd) };
	}
	if (props.vendor) {
		properties[props.vendor] = { rich_text: [{ text: { content: vendorLabel(p.store) } }] };
	}
	// One pack, because that is what pressing Buy once means.
	if (props.amount) properties[props.amount] = { number: 1 };

	const page = (await client.pages.create({
		parent: { type: "data_source_id", data_source_id: GROCERY_LIST_DS },
		properties,
	} as any)) as any;

	return { title, pageId: page.id, alreadyListed: false, amount: props.amount ? 1 : null };
}
