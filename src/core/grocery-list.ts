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

/** Property names carry the user's original spelling — trailing spaces included. */
const PROP = { name: "Name", price: "Price ", amount: "Amount ", vendor: "Vendor ", done: "Checkbox" };

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
	/** Size of the pack being bought, in grams/ml. Drives the cooldown length. */
	packSizeG: number | null;
	volumetric: boolean;
	/** Monthly usage of the ingredient, grams/ml. 0 when it isn't in the plan. */
	monthlyAmount: number;
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
	return {
		v: 1,
		ingredientId: str("ingredientId"),
		ingredient: str("ingredient"),
		key: str("key"),
		store: str("store"),
		product: str("product", false),
		priceSgd,
		packSizeG: packSizeG != null && Number.isFinite(packSizeG) ? packSizeG : null,
		volumetric: Boolean(o.volumetric),
		monthlyAmount: Number.isFinite(Number(o.monthlyAmount)) ? Number(o.monthlyAmount) : 0,
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
async function findOpenRow(client: Client, title: string): Promise<string | null> {
	const res = (await client.dataSources.query({
		data_source_id: GROCERY_LIST_DS,
		page_size: 25,
		filter: {
			and: [
				{ property: PROP.name, title: { equals: title } },
				{ property: PROP.done, checkbox: { equals: false } },
			],
		},
	} as any)) as any;
	return res.results[0]?.id ?? null;
}

/** Creates the grocery-list row (or reports the one that's already there). */
export async function addToGroceryList(client: Client, p: AddPayload): Promise<AddResult> {
	const title = groceryRowTitle(p.store, p.ingredient);

	const existing = await findOpenRow(client, title).catch(() => null);
	if (existing) return { title, pageId: existing, alreadyListed: true };

	const page = (await client.pages.create({
		parent: { type: "data_source_id", data_source_id: GROCERY_LIST_DS },
		properties: {
			[PROP.name]: { title: [{ text: { content: title } }] },
			[PROP.price]: { number: Math.round(p.priceSgd * 100) / 100 },
			[PROP.vendor]: { rich_text: [{ text: { content: vendorLabel(p.store) } }] },
			// Amount is intentionally left unset — the user fills it in.
		},
	} as any)) as any;

	return { title, pageId: page.id, alreadyListed: false };
}
