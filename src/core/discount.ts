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
	/** Rich text — what you pay today, with the pack, e.g. `$4.90 / 500g`. */
	PRICE: "Price (Discount)",
	/** Rich text — the same offer per kg/L/10 pc, e.g. `$9.80/kg`. */
	RATE: "Price per kg/L (discount)",
	/** Rich text — which shop is running it, e.g. `Guardian`. */
	LOCATION: "Location (Discount)",
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
}

export interface DiscountText {
	price: string;
	rate: string;
	location: string;
	/** The rate as a number, for `discountBeats`. Null when the pack has no divisor. */
	rateValue: number | null;
}

/** The three strings exactly as they go into Notion. */
export function formatDiscount(c: DiscountCapture): DiscountText {
	const rate = discountRate({
		unitType: c.unitType,
		price: c.promoSgd,
		size: c.size,
		rowName: c.rowName,
		itemName: c.itemName,
	});
	return {
		price: `$${c.promoSgd.toFixed(2)}` + (c.size != null ? ` / ${c.size}${unitWord(c.unitType)}` : ""),
		rate: rate ? `$${rate.value.toFixed(2)}${rate.label}` : "",
		location: c.vendor,
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
	rate: number | null;
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
		rate: parseRecordedRate(rateText),
	};
}

/** True when any of the three cells holds something — i.e. a clear would do work. */
export function hasDiscount(props: Record<string, any>): boolean {
	const d = readDiscount(props);
	return Boolean(d.price || d.location || d.rate != null);
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
	const put = (prop: string, value: string) => {
		if (!schema[prop]) {
			skipped.push(`no "${prop}" column`);
			return;
		}
		properties[prop] = { rich_text: value ? [{ type: "text", text: { content: value } }] : [] };
		written.push(prop);
	};
	put(DISCOUNT_PROPS.PRICE, text?.price ?? "");
	put(rateProp, text?.rate ?? "");
	put(DISCOUNT_PROPS.LOCATION, text?.location ?? "");
	return { properties, written, skipped };
}
