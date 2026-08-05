import { Client } from "@notionhq/client";

/**
 * Pushing a deal onto the user's Notion **grocery List** database.
 *
 * The row is deliberately minimal, per the user's spec:
 *   Name    "[NTUC] Milk"  — vendor tag + the INGREDIENT name (what they shop
 *                            for), not the store's marketing name for it
 *   Price   the discounted price actually being offered
 *   Vendor  the store, in the same words the Ingredients DB uses
 *   Amount  left empty — the user fills that in themselves
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

	return {
		title: byType("title")[0] ?? "Name",
		price,
		currentPrice,
		vendor: pick(byType("rich_text"), (n) => n.includes("vendor")),
		done: byType("checkbox")[0] ?? null,
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
 * is "NTUC" everywhere in the Ingredients DB (and in the user's example,
 * "[NTUC] Milk"), so the grocery list says NTUC too.
 */
const VENDOR_LABELS: Record<string, string> = {
	FairPrice: "NTUC",
	"Sheng Siong": "Sheng Siong",
};

export function vendorLabel(store: string): string {
	return VENDOR_LABELS[store] ?? store;
}

/** The row title: "[NTUC] Milk". */
export function groceryRowTitle(store: string, ingredientName: string): string {
	return `[${vendorLabel(store)}] ${ingredientName}`;
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
		priceSgd,
		myPriceSgd: Number.isFinite(myPrice) && myPrice > 0 ? myPrice : undefined,
		packSizeG: packSizeG != null && Number.isFinite(packSizeG) ? packSizeG : null,
		volumetric: Boolean(o.volumetric),
		monthlyAmount: Number.isFinite(Number(o.monthlyAmount)) ? Number(o.monthlyAmount) : 0,
		weeklyBuy: Boolean(o.weeklyBuy),
		url: typeof o.url === "string" ? o.url : "",
	};
}

export interface AddResult {
	title: string;
	pageId: string;
	/** True when an identical un-ticked row was already there and we left it alone. */
	alreadyListed: boolean;
}

/**
 * Look for an outstanding (un-ticked) row with this exact title, so a double-tap
 * on the Add button doesn't leave two identical lines on the shopping list.
 */
async function findOpenRow(client: Client, props: ListProps, title: string): Promise<string | null> {
	const filters: any[] = [{ property: props.title, title: { equals: title } }];
	if (props.done) filters.push({ property: props.done, checkbox: { equals: false } });
	const res = (await client.dataSources.query({
		data_source_id: GROCERY_LIST_DS,
		page_size: 25,
		filter: filters.length > 1 ? { and: filters } : filters[0],
	} as any)) as any;
	return res.results[0]?.id ?? null;
}

const money = (n: number) => Math.round(n * 100) / 100;

/** Creates the grocery-list row (or reports the one that's already there). */
export async function addToGroceryList(client: Client, p: AddPayload): Promise<AddResult> {
	const props = await listProps(client);
	const title = groceryRowTitle(p.store, p.ingredient);

	const existing = await findOpenRow(client, props, title).catch(() => null);
	if (existing) return { title, pageId: existing, alreadyListed: true };

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
	// Amount is intentionally left unset — the user fills it in.

	const page = (await client.pages.create({
		parent: { type: "data_source_id", data_source_id: GROCERY_LIST_DS },
		properties,
	} as any)) as any;

	return { title, pageId: page.id, alreadyListed: false };
}
