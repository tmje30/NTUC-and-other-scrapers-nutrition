/**
 * The Ingredients data source and the EXACT names of the properties the Chrome
 * extension writes. Kept in its own module so both the scraper (`notion.ts`) and
 * the extension bundle can import the same strings — importing `notion.ts`
 * itself would drag `@notionhq/client` into the browser bundle.
 *
 * ⚠️ These names are copied VERBATIM from the live schema, typos and trailing
 * spaces included. Notion matches property names exactly, so "correcting" one
 * here silently breaks the write:
 *   - `Catagory`   — misspelled in Notion
 *   - `Unit type ` — trailing space
 * If a property is ever renamed in Notion, change it here; `setupCheck()` in the
 * extension reports a missing one by name rather than writing a broken row.
 *
 * ⚠️ **Three columns left this file on 2026-08-09 and must not come back.**
 * `Price,SGD`, `Weight /Units of New Product ` and `Vendor, Current ` were the
 * "baseline" — what the user pays and where. The user has retired them: the first
 * is gone, the other two are renamed `… - Delete? `, and `Price,SGD [Cheapest]`,
 * `Cheapest Price/Kg ` and `Cheapest Vendor ` are now **formulas derived from the
 * price book** (`Vendor 1..4` + `Price [Vendor n]` + `Size[Vendor n]`). A capture
 * therefore writes a vendor SLOT and lets the baseline fall out of it — see
 * `vendor-slots.ts`, which owns those columns and resolves their names off the
 * live schema rather than listing them here.
 */

/** Ingredients data source (API 2025-09-03 queries data sources, not databases). */
export const INGREDIENTS_DS = "34b69a18-4fe7-80e6-904e-000b208cf560";

export const ING_PROPS = {
	/** Title — the stripped-down, generic name ("Round Cabbage"). */
	NAME: "Name",
	/** Rich text — the shop's full name plus brand ("Pasar Romaine Lettuce"). */
	EXACT_NAME: "Items Exact Name",
	/** Select — "[3] Fruits/Vegetables" etc. Options are read live, never invented. */
	CATEGORY: "Catagory",
	/**
	 * Select — "By Gram" | "By ml" | "By Unit".
	 *
	 * ⚠️ As of 2026-08-09 this describes what `Size[Vendor n]` counts, not the
	 * retired `Weight /Units of New Product `. Nothing about the values changed;
	 * the column it qualifies did.
	 */
	UNIT_TYPE: "Unit type ",
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

/**
 * Properties that must exist before the extension will write anything.
 *
 * ⚠️ **The price, size and vendor columns were removed from this list on
 * 2026-08-09, and that was not a relaxation — it was a repair.** They had already
 * been renamed in Notion, so `setupCheck()` was failing on all three and the
 * extension refused every capture. The columns a capture actually needs now live in
 * the price book, and they are checked separately by `resolveVendorSlotProps`,
 * which reports the missing slot rather than blocking the whole write: a database
 * with only `Vendor 1` should still capture into `Vendor 1`.
 */
export const REQUIRED_ING_PROPS: string[] = [
	ING_PROPS.NAME,
	ING_PROPS.EXACT_NAME,
	ING_PROPS.CATEGORY,
	ING_PROPS.UNIT_TYPE,
];
