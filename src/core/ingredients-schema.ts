/**
 * The Ingredients data source and the EXACT names of the properties the Chrome
 * extension writes. Kept in its own module so both the scraper (`notion.ts`) and
 * the extension bundle can import the same strings — importing `notion.ts`
 * itself would drag `@notionhq/client` into the browser bundle.
 *
 * ⚠️ These names are copied VERBATIM from the live schema, typos and trailing
 * spaces included. Notion matches property names exactly, so "correcting" one
 * here silently breaks the write:
 *   - `Catagory`                      — misspelled in Notion
 *   - `Unit type `                    — trailing space
 *   - `Weight /Units of New Product ` — space before the slash AND trailing
 *   - `Vendor, Current `              — trailing space
 * If a property is ever renamed in Notion, change it here; `setupCheck()` in the
 * extension reports a missing one by name rather than writing a broken row.
 */

/** Ingredients data source (API 2025-09-03 queries data sources, not databases). */
export const INGREDIENTS_DS = "34b69a18-4fe7-80e6-904e-000b208cf560";

export const ING_PROPS = {
	/** Title — the stripped-down, generic name ("Round Cabbage"). */
	NAME: "Name",
	/** Rich text — the shop's full name plus brand ("Pasar Romaine Lettuce"). */
	EXACT_NAME: "Items Exact Name",
	/** Number — pack price in SGD. */
	PRICE: "Price,SGD",
	/** Number — grams, millilitres, or a piece count (whichever `Unit type ` says). */
	SIZE: "Weight /Units of New Product ",
	/** Select — "[3] Fruits/Vegetables" etc. Options are read live, never invented. */
	CATEGORY: "Catagory",
	/** Select — "By Gram" | "By ml" | "By Unit". */
	UNIT_TYPE: "Unit type ",
	/** Rich text — the shop this price came from ("NTUC", "Sheng Siong"). */
	VENDOR_CURRENT: "Vendor, Current ",
	/** URL — the product page, so a re-visit is recognised as already added. */
	VENDOR_URL: "Vendor 1 URL",
} as const;

/**
 * The four nutrition columns, per 100 g — filled in by the history page's
 * "Add to Ingredients" (see `macros.ts`).
 *
 * ⚠️ Same verbatim-copy rule as above, and these are the worst offenders in the
 * whole schema. `Fats per 100 g ` has a space BEFORE the g as well as a trailing
 * one; `Carbs` and `Fiber` are trailing-space only; `Protein` has neither. They
 * are not typos to fix here — they are what Notion is storing.
 *
 * Deliberately NOT in `REQUIRED_ING_PROPS`: the extension writes prices and sizes
 * and has no business refusing to work because a nutrition column was renamed.
 */
export const ING_MACRO_PROPS = {
	PROTEIN: "Protein per 100g",
	FATS: "Fats per 100 g ",
	CARBS: "Carbs per 100g ",
	FIBER: "Fiber per 100g ",
} as const;

/** Properties that must exist before the extension will write anything. */
export const REQUIRED_ING_PROPS: string[] = [
	ING_PROPS.NAME,
	ING_PROPS.EXACT_NAME,
	ING_PROPS.PRICE,
	ING_PROPS.SIZE,
	ING_PROPS.CATEGORY,
	ING_PROPS.UNIT_TYPE,
	ING_PROPS.VENDOR_CURRENT,
];
