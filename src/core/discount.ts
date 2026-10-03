import { PIECES_PER_QUOTE } from "./list-intake.js";
import { packWeightOf, type UnitType } from "./notion.js";

/**
 * **The three discount columns, and the rule that a promo never enters the price book.**
 *
 * `atShelfPrice` deliberately strips a promo out of every scan result before the price
 * book sees it: `Price [Vendor n]` answers "what does this normally cost here", and a
 * 35%-off tag that lands there gets locked in by the ratchet — `dearerThanRecorded`
 * then refuses the correction, because putting the real price back is a price RISE.
 * That is a live incident, not a hypothetical (Guardian's Sensodyne, $8.65 against a
 * not-on-sale $10.20; see `vendor-repair-promo.ts`).
 *
 * The offer itself was therefore kept only in `promoPriceSgd`, marked "⚠️ Nothing
 * prices off this", and shown on the deals page for a day. These three columns are
 * where it now lands instead (user, 2026-09-12) — beside the shelf price rather than
 * on top of it, so the two facts coexist and neither has to lie about the other.
 *
 * ⚠️ Names copied VERBATIM from the live schema (introspected 2026-09-12). All three
 * are `rich_text`, including the two holding money — they are read by a human, not
 * summed by a formula, and `Cheapest Price/Kg ` is deliberately not affected by them.
 * Note the lower-case `d` in `(discount)` on the rate column and the capital `D` on
 * the other two. They are not typos to tidy; they are what Notion is storing.
 */
export const DISCOUNT_PROPS = {
	/**
	 * Rich text — **the price and nothing else**, e.g. `5.95`.
	 *
	 * ⚠️ **No `$`, and no pack size** (user, 2026-10-03). It used to hold `$5.95 / 2000g`,
	 * which put two facts in a column named for one and left `Item name (Discount)` empty
	 * beside it. The pack now travels with the item it describes — see `ITEM`.
	 */
	PRICE: "Price (Discount)",
	/** Rich text — the same offer per kg/L/10 pc, e.g. `$9.80/kg`. */
	RATE: "Price per kg/L (discount)",
	/** Rich text — which shop is running it, e.g. `Guardian`. */
	LOCATION: "Location (Discount)",
	/**
	 * Rich text — **what is actually on offer, with its pack**, e.g.
	 * `Max's peanut butter (300g)` (user, 2026-10-03).
	 *
	 * ⚠️ The shop's own product name, not the row's. `Location (Discount)` says where and
	 * `Price (Discount)` says how much; without this the row said an offer existed and not
	 * what it was on — and a row's general name ("Peanut butter") is not enough to find a
	 * jar on a shelf.
	 *
	 * ⚠️ Confirmed present in the live schema (introspected 2026-10-03, `rich_text`). It is
	 * the user's column; nothing here creates it, and `discountProperties` skips it by name
	 * if it ever goes missing rather than failing the whole write.
	 */
	ITEM: "Item name (Discount)",
	/**
	 * **URL — the offer's own product page** (column created by the user, 2026-10-03).
	 *
	 * ⚠️ **A `url` property, not `rich_text` like the other three.** `discountProperties`
	 * therefore writes it by the schema's declared type rather than assuming; sending
	 * `{rich_text:[…]}` at a url column is a 400 that would take the whole update with it,
	 * including the three cells that were fine.
	 *
	 * ⚠️ It is the URL of the pack named in `ITEM`, captured from the same pick, so the two
	 * always describe one listing. The shopping page prefers it over the vendor slot's URL
	 * for the offer link — see `readIngredientUrls`.
	 */
	URL: "URL item (Discount)",
} as const;

/** Every spelling the rate column has had. **Read through this** — see `CATEGORY_ALIASES`. */
export const DISCOUNT_RATE_ALIASES = ["Price per kg/L (discount)", "Price per kg/L (Discount)"] as const;

/** What `unitWord` writes after a size, matching `priceSizeText` in the scan's report. */
function unitWord(unitType: UnitType): string {
	return unitType === "By Unit" ? " pcs" : unitType === "By ml" ? "ml" : "g";
}

export interface DiscountRate {
	/** The figure, already scaled to `label` — never a per-1000-pieces number. */
	value: number;
	/** `/kg`, `/L` or `/10 pc`. */
	label: string;
}

/**
 * A promo price expressed in the dimension the ROW is priced in — the user's rule,
 * stated 2026-09-12: *By Unit = per 10 pcs, By gram = per kg, By ml = per L.*
 *
 * ⚠️ **This mirrors `perLabel` in `vendor-scan.ts` deliberately, and must keep
 * mirroring it.** That function decides what the scan's report prints and it already
 * follows the same three-way rule, which is itself Notion's own `Cheapest Price/Kg `
 * formula (`multiplier = if(Unit type == "By Unit", 10, 1000)`). Three places now say
 * "ten pieces"; a fourth convention is how a factor of ten gets into a money column.
 * See the warning on `perLabel` — that mistake has already cost one live incident.
 *
 * ⚠️ `packWeightOf` decides whether there is a weight to divide by, so a counted pack
 * that states its grams is quoted per kg like everything else, and one that genuinely
 * has no weight — a razor cartridge, a stock cube — falls back to per 10 pieces rather
 * than inventing one. Pass the item name of the slot whose price this is, and no other.
 */
export function discountRate(args: {
	unitType: UnitType;
	price: number | null;
	size: number | null;
	/** The row's general `Name`, for a weight written in words. */
	rowName: string;
	/** `Item Name [Vendor n]` for THIS shop — asked first, because it describes this pack. */
	itemName: string;
}): DiscountRate | null {
	const { unitType, price, size } = args;
	if (price == null || price <= 0) return null;
	const grams = packWeightOf(unitType, size, args.rowName, args.itemName);
	if (grams != null && grams > 0) {
		return { value: (price / grams) * 1000, label: unitType === "By ml" ? "/L" : "/kg" };
	}
	if (unitType === "By Unit" && size != null && size > 0) {
		return { value: (price / size) * PIECES_PER_QUOTE, label: `/${PIECES_PER_QUOTE} pc` };
	}
	return null;
}

export interface DiscountCapture {
	/** The `Vendor n` option running the offer — exactly as Notion spells it. */
	vendor: string;
	unitType: UnitType;
	/** What the shop is charging TODAY (`promoPriceSgd`), never the shelf price. */
	promoSgd: number;
	/** Pack size in the row's own units, i.e. what `Size[Vendor n]` holds. */
	size: number | null;
	rowName: string;
	itemName: string;
	/** The offer listing's own page at that shop. Absent when the module gave none. */
	url?: string | null;
}

export interface DiscountText {
	/** Bare figure — `5.95`, no currency and no pack. See `DISCOUNT_PROPS.PRICE`. */
	price: string;
	rate: string;
	location: string;
	/** The shop's product name with its pack — `Max's peanut butter (300g)`. */
	itemName: string;
	/** That listing's page, or `""` when the shop published none. */
	url: string;
	/** The rate as a number, for `discountBeats`. Null when the pack has no divisor. */
	rateValue: number | null;
}

/** The five cells exactly as they go into Notion. */
export function formatDiscount(c: DiscountCapture): DiscountText {
	const rate = discountRate({
		unitType: c.unitType,
		price: c.promoSgd,
		size: c.size,
		rowName: c.rowName,
		itemName: c.itemName,
	});
	return {
		// ⚠️ **The figure alone.** Two decimals, because it is money being read by a human,
		// but no `$` and no size — the column is named `Price` and now holds only that.
		price: c.promoSgd.toFixed(2),
		rate: rate ? `$${rate.value.toFixed(2)}${rate.label}` : "",
		location: c.vendor,
		// ⚠️ The pack moved HERE from the price column, in the shape the user asked for:
		// `name (size)`. A pack the shop never stated leaves the brackets off entirely
		// rather than writing an empty pair.
		itemName: c.itemName + (c.size != null ? ` (${c.size}${unitWord(c.unitType)})` : ""),
		// ⚠️ `""`, never undefined: `discountProperties` reads an empty value as "clear this
		// cell", which is the right answer for a shop that published no link for the offer —
		// and leaves no previous offer's URL sitting under this one's name.
		url: c.url ?? "",
		rateValue: rate?.value ?? null,
	};
}

/**
 * The rate back out of whatever is sitting in the column, for the cross-shop compare.
 *
 * ⚠️ Returns null for anything it cannot read, and null must mean "treat as no
 * discount" at the call site — an unparseable cell is usually one a human typed, and
 * the safe reading of "I don't understand this" is "let the fresh, machine-written
 * figure replace it", not "refuse forever".
 */
export function parseRecordedRate(text: string | null | undefined): number | null {
	const m = String(text ?? "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * **Who owns the discount columns when two shops are both running an offer.**
 *
 * There is one set of three columns and four vendor slots, so a sweep that wrote
 * unconditionally would leave whichever shop happened to be scanned LAST — an order
 * that is an implementation detail of `ROUTES`, not a fact about prices.
 *
 * The rule, matching the rest of the project: **cheapest per kg wins**, and the shop
 * already named in `Location (Discount)` may always refresh its own figure (including
 * upwards — an offer that got less good is still today's offer, and the alternative is
 * a stale number that outlives the promo).
 */
export function discountBeats(args: {
	/** What `Location (Discount)` currently names, if anything. */
	recordedLocation: string | null | undefined;
	/** What `Price per kg/L (discount)` currently reads as. */
	recordedRate: number | null;
	vendor: string;
	/** This offer's rate. Null when the pack has no divisor — see `discountRate`. */
	rate: number | null;
}): boolean {
	const held = (args.recordedLocation ?? "").trim();
	// Nobody holds it, or the cell is empty → take it.
	if (!held) return true;
	// This shop's own entry: always its to refresh, in either direction.
	if (held.toLowerCase() === args.vendor.trim().toLowerCase()) return true;
	// Another shop holds it. Without two comparable rates there is nothing to decide
	// on, and displacing a named shop on no evidence is the worse of the two errors.
	if (args.rate == null || args.recordedRate == null) return false;
	return args.rate < args.recordedRate;
}

/** The three cells as they currently read, straight off a page's raw properties. */
export function readDiscount(props: Record<string, any>): {
	price: string;
	location: string;
	itemName: string;
	url: string;
	rate: number | null;
	/** The rate cell VERBATIM (`$18.40/kg`), for anything that re-displays it. */
	rateText: string;
} {
	const text = (name: string) =>
		((props?.[name]?.rich_text ?? []) as any[])
			.map((r) => r?.plain_text ?? "")
			.join("")
			.trim();
	let rateText = "";
	for (const n of DISCOUNT_RATE_ALIASES) {
		rateText = text(n);
		if (rateText) break;
	}
	return {
		price: text(DISCOUNT_PROPS.PRICE),
		location: text(DISCOUNT_PROPS.LOCATION),
		itemName: text(DISCOUNT_PROPS.ITEM),
		// A `url` property, so read as one rather than through `text` — see DISCOUNT_PROPS.URL.
		url: String(props?.[DISCOUNT_PROPS.URL]?.url ?? "").trim(),
		rate: parseRecordedRate(rateText),
		rateText,
	};
}

/** True when any of the five cells holds something — i.e. a clear would do work. */
export function hasDiscount(props: Record<string, any>): boolean {
	const d = readDiscount(props);
	return Boolean(d.price || d.location || d.itemName || d.url || d.rate != null);
}

/**
 * The Notion `properties` payload for the three columns, or for clearing them.
 *
 * ⚠️ **Only columns that EXIST in `schema` are sent.** A database missing one of the
 * three still gets the other two, and the missing one is reported by name rather than
 * failing the whole update — the same posture as `resolveVendorSlotProps`. A write that
 * refuses to work because a column was renamed is how the extension came to reject every
 * capture on 2026-08-09.
 */
export function discountProperties(
	schema: Record<string, any>,
	text: DiscountText | null,
): { properties: Record<string, any>; written: string[]; skipped: string[] } {
	const properties: Record<string, any> = {};
	const written: string[] = [];
	const skipped: string[] = [];
	const rateProp = DISCOUNT_RATE_ALIASES.find((n) => schema[n]) ?? DISCOUNT_PROPS.RATE;
	/**
	 * ⚠️ **Written by the column's DECLARED TYPE, not by assuming rich text.** `URL item
	 * (Discount)` is a `url` property and the other four are `rich_text`; sending
	 * `{rich_text:[…]}` at a url column is a 400 that takes the WHOLE update with it,
	 * including the cells that were fine. Reading the type is also what lets the user
	 * change one of these to a url column later without this quietly breaking.
	 */
	const put = (prop: string, value: string) => {
		const type = schema[prop]?.type;
		if (!type) {
			skipped.push(`no "${prop}" column`);
			return;
		}
		if (type === "url") properties[prop] = { url: value || null };
		else if (type === "rich_text")
			properties[prop] = { rich_text: value ? [{ type: "text", text: { content: value } }] : [] };
		else {
			// Neither shape fits, so write nothing rather than guess at a cell the user owns.
			skipped.push(`"${prop}" is a ${type} column, not rich text or url`);
			return;
		}
		written.push(prop);
	};
	put(DISCOUNT_PROPS.PRICE, text?.price ?? "");
	put(rateProp, text?.rate ?? "");
	put(DISCOUNT_PROPS.LOCATION, text?.location ?? "");
	put(DISCOUNT_PROPS.ITEM, text?.itemName ?? "");
	put(DISCOUNT_PROPS.URL, text?.url ?? "");
	return { properties, written, skipped };
}
