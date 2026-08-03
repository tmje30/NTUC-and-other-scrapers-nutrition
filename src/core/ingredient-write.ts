import { Client } from "@notionhq/client";
import { categorize, guessSize, matchCategoryOption, type CategoryKey } from "./categorize.js";
import { deriveGenericName } from "./generic-name.js";
import { INGREDIENTS_DS, ING_MACRO_PROPS, ING_PROPS } from "./ingredients-schema.js";
import type { Macros } from "./macros.js";

/**
 * Writing to the Ingredients database from the history page.
 *
 * The Node counterpart to `extension/notion-client.js`, which does the same two
 * jobs from the browser. Kept as a separate module rather than shared because
 * the extension talks raw `fetch` (it cannot bundle `@notionhq/client`), but the
 * RULES are copied across deliberately and must stay in step:
 *
 *  1. **A blank field is omitted, never written as null.** "I couldn't read a
 *     size" must not blank a size the row already had. This matters far more on
 *     replace than on create.
 *  2. **Select values are validated against the live schema.** Writing a name
 *     Notion doesn't have makes Notion INVENT the option — a schema edit to a
 *     live personal workspace, which this tool must never make. An unknown value
 *     is dropped with a warning, not created.
 *  3. **Replace touches four fields and nothing else.** Nutrition, plan formulas,
 *     `Select` tags and relations are the user's own work; a cheaper price at a
 *     different shop is no reason to disturb them.
 */

export interface IngredientFields {
	/** Title — the generic name ("Rolled Oats"). */
	name: string;
	/** Rich text — the shop's full name plus brand. */
	exactName?: string;
	priceSgd?: number | null;
	/** Grams, millilitres or a piece count — whichever `unitType` says. */
	size?: number | null;
	/** A Notion option name, already known to exist. Validated again before writing. */
	category?: string;
	/**
	 * The project's own category key ("produce", "meat"), resolved against the
	 * live options at write time. Kept separate from `category` because the key is
	 * a fact about the food and the option name is a fact about the user's Notion —
	 * and only one of those is allowed to drift.
	 */
	categoryKey?: CategoryKey | null;
	unitType?: string;
	/** The shop, in the wording the Ingredients DB uses ("NTUC"). */
	vendor?: string;
	url?: string;
	/** Only ever set by "Add to Ingredients" — replace leaves nutrition alone. */
	macros?: Macros | null;
}

export interface WriteResult {
	id: string;
	notionUrl: string;
	/** Which properties were actually sent, for the workflow's reply. */
	written: string[];
	/** Values that were dropped because the option doesn't exist in Notion. */
	skipped: string[];
}

type Schema = Record<string, { type: string; select?: { options?: { name: string }[] } }>;

async function schemaOf(client: Client): Promise<Schema> {
	const ds = (await client.dataSources.retrieve({ data_source_id: INGREDIENTS_DS })) as any;
	return (ds.properties ?? {}) as Schema;
}

function selectOptions(schema: Schema, prop: string): string[] {
	return (schema[prop]?.select?.options ?? []).map((o) => o.name);
}

const text = (s: string) => [{ text: { content: s.trim().slice(0, 1990) } }];

/**
 * Build the Notion property payload. Returns what it wrote and what it refused
 * to, so the caller can tell the user rather than leaving them to notice a
 * missing category three weeks later.
 */
function buildProps(
	f: Partial<IngredientFields>,
	schema: Schema,
): { properties: Record<string, unknown>; written: string[]; skipped: string[] } {
	const properties: Record<string, unknown> = {};
	const written: string[] = [];
	const skipped: string[] = [];

	const put = (prop: string, value: unknown, label: string) => {
		// A property the schema no longer has would make Notion reject the ENTIRE
		// request, so an unknown column is skipped rather than sent.
		if (!schema[prop]) {
			skipped.push(`${label} (no "${prop}" column)`);
			return;
		}
		properties[prop] = value;
		written.push(label);
	};

	if (f.name?.trim()) put(ING_PROPS.NAME, { title: text(f.name) }, "Name");
	if (f.exactName?.trim()) put(ING_PROPS.EXACT_NAME, { rich_text: text(f.exactName) }, "Items Exact Name");
	if (typeof f.priceSgd === "number" && Number.isFinite(f.priceSgd)) {
		put(ING_PROPS.PRICE, { number: Math.round(f.priceSgd * 100) / 100 }, "Price,SGD");
	}
	if (typeof f.size === "number" && Number.isFinite(f.size) && f.size > 0) {
		put(ING_PROPS.SIZE, { number: Math.round(f.size * 1000) / 1000 }, "Weight /Units");
	}
	if (f.vendor?.trim()) put(ING_PROPS.VENDOR_CURRENT, { rich_text: text(f.vendor) }, "Vendor, Current");
	if (f.url?.trim()) put(ING_PROPS.VENDOR_URL, { url: f.url.trim() }, "Vendor 1 URL");

	// Rule 2: both selects go through the live option list. A value that isn't
	// there is dropped — the row is filed uncategorised and the user picks one,
	// which is a small annoyance next to inventing an option in their workspace.
	for (const [prop, value, label] of [
		[ING_PROPS.CATEGORY, f.category, "Catagory"],
		[ING_PROPS.UNIT_TYPE, f.unitType, "Unit type"],
	] as const) {
		if (!value?.trim()) continue;
		const options = selectOptions(schema, prop);
		const match = options.find((o) => o.toLowerCase() === value.trim().toLowerCase());
		if (!match) {
			skipped.push(`${label} "${value}" (not an existing option — left blank)`);
			continue;
		}
		put(prop, { select: { name: match } }, label);
	}

	// Nutrition. Each column is independent: a lookup that found protein and fat
	// but not fibre writes the two it has rather than all-or-nothing.
	if (f.macros) {
		for (const [prop, value, label] of [
			[ING_MACRO_PROPS.PROTEIN, f.macros.proteinPer100g, "Protein per 100g"],
			[ING_MACRO_PROPS.FATS, f.macros.fatsPer100g, "Fats per 100 g"],
			[ING_MACRO_PROPS.CARBS, f.macros.carbsPer100g, "Carbs per 100g"],
			[ING_MACRO_PROPS.FIBER, f.macros.fiberPer100g, "Fiber per 100g"],
		] as const) {
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			put(prop, { number: value }, label);
		}
	}

	return { properties, written, skipped };
}

/**
 * Everything the page knows about a bought product, turned into row fields.
 *
 * The derivations are the project's own — `deriveGenericName`, `categorize` and
 * `guessSize` are the same functions the daily scan and the Chrome extension
 * use, so a row created from the history page is shaped exactly like one created
 * from a product page. The store's product name becomes `Items Exact Name`; the
 * stripped-down generic becomes the title, because the title is what the matcher
 * searches on and "Seara Frozen Chicken Thigh 2kg" is not a search term.
 */
export function fieldsFromPurchase(p: {
	product: string;
	store: string;
	priceSgd: number;
	packSizeG: number | null;
	volumetric: boolean;
	url: string;
	ingredientName: string;
}): IngredientFields {
	const generic = deriveGenericName(p.product, "") || p.ingredientName || p.product;
	// A pack size already in grams doesn't need re-parsing; guessSize is only for
	// turning a printed "500 g" into a number and a unit type. Feed it the size we
	// have so the UNIT comes out right (By ml for a volumetric pack, By Gram else).
	const sized =
		p.packSizeG && p.packSizeG > 0
			? { amount: p.packSizeG, unitType: p.volumetric ? "By ml" : "By Gram" }
			: guessSize(p.product);

	return {
		name: generic,
		exactName: p.product,
		priceSgd: p.priceSgd,
		size: sized.amount,
		unitType: sized.unitType || (p.volumetric ? "By ml" : "By Gram"),
		categoryKey: categorize(generic || p.product),
		vendor: p.store,
		url: p.url,
	};
}

/** "Add to Ingredients" — a new row. */
export async function createIngredient(
	client: Client,
	fields: IngredientFields,
): Promise<WriteResult> {
	if (!fields.name?.trim()) throw new Error("an ingredient needs a name");
	const schema = await schemaOf(client);

	// The category guess is resolved against the LIVE options here rather than at
	// the call site, so a renamed option degrades to "uncategorised" instead of
	// throwing. An explicit `category` wins — it came from a human.
	const resolved: IngredientFields = {
		...fields,
		category:
			fields.category ||
			matchCategoryOption(fields.categoryKey ?? null, selectOptions(schema, ING_PROPS.CATEGORY)) ||
			"",
	};

	const { properties, written, skipped } = buildProps(resolved, schema);
	const page = (await client.pages.create({
		parent: { type: "data_source_id", data_source_id: INGREDIENTS_DS },
		properties,
	} as any)) as any;

	return { id: page.id, notionUrl: page.url, written, skipped };
}

/**
 * "Replace Current" — repoint an existing row at this product.
 *
 * Writes ONLY price, size and vendor (plus the URL, which is what makes the row
 * recognisable as this product next time). The name is deliberately left alone,
 * unlike the Chrome extension's "Replace With This": there, the user is looking
 * at the product page and has explicitly chosen to rename the row. Here the row
 * is an ingredient they already maintain and the button means "same thing, new
 * price" — silently renaming "Chicken thigh, Boneless" to whatever the shop calls
 * this week's pack would be a change nobody asked for.
 */
export async function replaceIngredientPrice(
	client: Client,
	pageId: string,
	fields: Pick<IngredientFields, "priceSgd" | "size" | "unitType" | "vendor" | "url">,
): Promise<WriteResult> {
	if (!pageId) throw new Error("no ingredient row to replace");
	const schema = await schemaOf(client);
	const { properties, written, skipped } = buildProps(fields, schema);
	if (!Object.keys(properties).length) throw new Error("nothing to write — no price, size or vendor");

	const page = (await client.pages.update({ page_id: pageId, properties } as any)) as any;
	return { id: page.id, notionUrl: page.url, written, skipped };
}
