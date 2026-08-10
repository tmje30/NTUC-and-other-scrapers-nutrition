/**
 * The **price book** — `Vendor 1..4` and the `Price [Vendor n]` / `Size[Vendor n]` /
 * `URL [Vendor n]` columns beside them.
 *
 * This is now the ONLY place a captured price lands. Until 2026-08-09 every write
 * went to `Price,SGD` + `Weight /Units of New Product ` + `Vendor, Current ` — the
 * "baseline" — and the price book was never filled on a single row. The user has
 * since inverted that: the baseline columns are renamed `… - Delete? ` and on their
 * way out, and `Price,SGD [Cheapest]` / `Cheapest Price/Kg ` / `Cheapest Vendor `
 * are formulas **derived from the slots below**. So filling a slot is what gives a
 * row a price at all.
 *
 * Pure functions only — no Notion client, no I/O — because both writers need them:
 * the Node scripts behind the deals/history pages, and `extension/notion-client.js`
 * in the browser (esbuild bundles this file straight into the extension). The rules
 * are shared rather than copied so the two surfaces cannot disagree about which
 * shop owns which slot.
 *
 * Three rules govern every write here, and all three exist to protect a database
 * the user edits by hand:
 *
 *  1. **A slot is claimed by NAME, never by position.** `Vendor 1` is NTUC on one
 *     row and Shopee on the next. A Guardian price goes to whichever slot says
 *     Guardian, or to a free one — never to "the first slot".
 *  2. **A shop that isn't already a `Vendor n` option is not written.** Notion
 *     INVENTS a select option for an unknown name, which is a schema edit to a live
 *     personal workspace. An unrecognised shop is reported and dropped.
 *  3. **A slot holding data is never silently overwritten.** It is free only when
 *     its vendor, price, size and URL are ALL empty; anything else is either the
 *     user's routing intent ("also look at Sheng Siong") or a real price, and both
 *     are theirs.
 */

/** How many `Vendor n` groups the schema has. Four as of 2026-08-09. */
export const VENDOR_SLOT_COUNT = 4;

/** The exact Notion property names for one slot, as resolved from the live schema. */
export interface VendorSlotProps {
	/** 1-based slot number, matching the column labels. */
	n: number;
	/** Select — the shop. */
	vendor: string;
	/** Number — what that shop charges for one pack. */
	price: string | null;
	/** Number — the pack, in whatever `Unit type ` says (g, ml or pieces). */
	size: string | null;
	/** URL — the product page at that shop. */
	url: string | null;
	/**
	 * Rich text — what THIS shop calls the product.
	 *
	 * Added to the schema by the user on 2026-08-09. It is the per-slot sibling of
	 * `Items Exact Name`, which records only one shop's wording for the whole row:
	 * the same ingredient is "Sensodyne Repair & Protect 100g" at one shop and
	 * "Sensodyne Toothpaste Repair and Protect (100g)" at the next, and a price is
	 * hard to check months later without the name it was quoted under.
	 */
	itemName: string | null;
}

/** What a slot currently holds. */
export interface VendorSlot extends VendorSlotProps {
	vendorName: string;
	priceValue: number | null;
	sizeValue: number | null;
	urlValue: string;
	itemNameValue: string;
}

type Schema = Record<string, { type: string; select?: { options?: { name: string }[] } }>;

/** Trim, collapse whitespace, lower-case — the shape a rename doesn't change. */
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Find a property by its normalised name.
 *
 * ⚠️ **Not a convenience.** The live names are `Price [Vendor 1]` but
 * `Price [Vendor 2] ` (trailing space), and `Size[Vendor n]` with no space at all.
 * Hardcoding four strings each for four slots is sixteen chances to be silently
 * wrong, and a mistyped property is not an error in Notion — it is a value that
 * never arrives. Matching on the normalised name survives the spacing drift this
 * schema has had in every other column.
 */
function findProp(schema: Schema, want: string, type: string): string | null {
	const target = norm(want);
	for (const [name, def] of Object.entries(schema ?? {})) {
		if (norm(name) === target && def?.type === type) return name;
	}
	return null;
}

/**
 * The slots this database actually has, in order.
 *
 * A slot exists when its `Vendor n` select exists; its price/size/URL columns are
 * each optional and come back null when absent, so a schema missing `URL [Vendor 3]`
 * simply doesn't record a link there rather than failing the write.
 */
export function resolveVendorSlotProps(schema: Schema): VendorSlotProps[] {
	const out: VendorSlotProps[] = [];
	for (let n = 1; n <= VENDOR_SLOT_COUNT; n++) {
		const vendor = findProp(schema, `Vendor ${n}`, "select");
		if (!vendor) continue;
		out.push({
			n,
			vendor,
			price: findProp(schema, `Price [Vendor ${n}]`, "number"),
			size: findProp(schema, `Size[Vendor ${n}]`, "number"),
			url: findProp(schema, `URL [Vendor ${n}]`, "url"),
			// ⚠️ Live spelling is lowercase `item` — `item Name [Vendor 1]` — and slot 2
			// carries a trailing space. `findProp` normalises both, which is the whole
			// reason these are resolved rather than hardcoded.
			itemName: findProp(schema, `item Name [Vendor ${n}]`, "rich_text"),
		});
	}
	return out;
}

/** Every shop name the `Vendor n` selects already offer, deduped. */
export function vendorOptions(schema: Schema, slots = resolveVendorSlotProps(schema)): string[] {
	const names = new Set<string>();
	for (const slot of slots) {
		for (const o of schema[slot.vendor]?.select?.options ?? []) names.add(o.name);
	}
	return [...names];
}

/**
 * The option Notion already has for this shop, or null.
 *
 * Rule 2 lives here. Matching is case- and spacing-insensitive so "iHerb" finds the
 * option spelled `Iherb`, but a shop with NO option — Cold Storage, Giant, RedMart —
 * returns null and the caller reports it instead of writing. Creating the option is
 * the user's call, made in Notion, never ours.
 */
export function matchVendorOption(options: string[], vendor: string): string | null {
	const want = norm(vendor);
	if (!want) return null;
	return options.find((o) => norm(o) === want) ?? null;
}

const numberValue = (p: any): number | null => (typeof p?.number === "number" ? p.number : null);
const urlValue = (p: any): string => (typeof p?.url === "string" ? p.url.trim() : "");
const richTextValue = (p: any): string =>
	Array.isArray(p?.rich_text) ? p.rich_text.map((t: any) => t?.plain_text ?? "").join("").trim() : "";

/** What each slot holds on one row, read from a page's `properties`. */
export function readVendorSlots(
	pageProps: Record<string, any>,
	slots: VendorSlotProps[],
): VendorSlot[] {
	return slots.map((s) => ({
		...s,
		vendorName: pageProps?.[s.vendor]?.select?.name ?? "",
		priceValue: s.price ? numberValue(pageProps[s.price]) : null,
		sizeValue: s.size ? numberValue(pageProps[s.size]) : null,
		urlValue: s.url ? urlValue(pageProps[s.url]) : "",
		itemNameValue: s.itemName ? richTextValue(pageProps[s.itemName]) : "",
	}));
}

/**
 * Price per 1000 units — per kg, per litre, or per 1000 pieces, whichever the row's
 * `Unit type ` means. Null when either half is missing, because a price with no size
 * is not expensive or cheap, it is **unknown**, and the whole comparison rests on
 * this number.
 *
 * The same expression the user gave, and the same one Notion's own
 * `Cheapest Price/Kg ` formula uses: `Price [Vendor n] / Size[Vendor n] * 1000`.
 */
export function pricePer1000(price: number | null, size: number | null): number | null {
	if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
	if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
	return (price / size) * 1000;
}

/**
 * A slot is free only when NOTHING is in it — see rule 3.
 *
 * `itemNameValue` counts for the same reason the other three do: a slot naming a
 * product someone recorded is not empty space, even if the price beside it has since
 * been cleared.
 */
export function isSlotFree(slot: VendorSlot): boolean {
	return (
		!slot.vendorName &&
		slot.priceValue == null &&
		slot.sizeValue == null &&
		!slot.urlValue &&
		!slot.itemNameValue
	);
}

export type SlotDecision =
	/** This shop already owns a slot — overwrite its price, size and URL. */
	| { kind: "update"; slot: VendorSlot }
	/** An empty slot: tag it with this shop and fill it. */
	| { kind: "fill"; slot: VendorSlot }
	/** Every slot taken; this one is the dearest per kg and this product beats it. */
	| { kind: "evict"; slot: VendorSlot; evictedVendor: string; evictedPer1000: number }
	/** Nothing to do, and why — always reported, never silent. */
	| { kind: "none"; reason: string };

/**
 * Which slot this capture belongs in.
 *
 * The order is the user's, and each step exists because the one before it didn't
 * apply:
 *
 * 1. **Already tagged** → update it. A second NTUC price is the same shop quoting a
 *    new number, not a new shop; it must not consume a second slot.
 * 2. **A free slot** → claim it. This is the whole of "Add": a brand-new row has
 *    four empty slots, so the capture lands in `Vendor 1`.
 * 3. **All four taken** → only then is anything displaced, and only by
 *    `Price / Size * 1000`: the dearest per kg loses its place, and only if this
 *    product is genuinely cheaper. A slot whose price or size is missing has no
 *    figure to compare, so it is NOT a candidate — it is left alone rather than
 *    treated as infinitely expensive, because an untagged placeholder is usually
 *    the user saying "look here too" and that intent outranks an automatic tidy-up.
 *
 * `allowEvict` is false for **Add**, which only ever writes a new row (every slot
 * free, step 2 always wins) — so if a caller ever hands it a full row, doing nothing
 * is the right answer rather than displacing a shop on an "add".
 */
export function chooseVendorSlot(
	slots: VendorSlot[],
	capture: { vendor: string; price: number | null; size: number | null },
	{ allowEvict = true } = {},
): SlotDecision {
	if (!slots.length) return { kind: "none", reason: "this database has no Vendor 1–4 columns" };
	if (!capture.vendor.trim()) return { kind: "none", reason: "no shop to tag" };

	const mine = slots.find((s) => norm(s.vendorName) === norm(capture.vendor));
	if (mine) return { kind: "update", slot: mine };

	const free = slots.find(isSlotFree);
	if (free) return { kind: "fill", slot: free };

	if (!allowEvict) {
		return { kind: "none", reason: `all ${slots.length} vendor slots are taken` };
	}

	const minePer1000 = pricePer1000(capture.price, capture.size);
	if (minePer1000 == null) {
		return {
			kind: "none",
			reason:
				`all ${slots.length} vendor slots are taken, and this capture has no ` +
				`price-and-size to compare against them`,
		};
	}

	// Only slots that state BOTH a price and a size can be ranked — see step 3.
	let worst: { slot: VendorSlot; per1000: number } | null = null;
	for (const slot of slots) {
		const per1000 = pricePer1000(slot.priceValue, slot.sizeValue);
		if (per1000 == null) continue;
		if (!worst || per1000 > worst.per1000) worst = { slot, per1000 };
	}
	if (!worst) {
		return {
			kind: "none",
			reason: `all ${slots.length} vendor slots are taken and none states both a price and a size`,
		};
	}
	if (minePer1000 >= worst.per1000) {
		return {
			kind: "none",
			reason:
				`all ${slots.length} vendor slots are taken, and at ${money(minePer1000)}/kg this is ` +
				`no cheaper than the dearest already there (${worst.slot.vendorName || `Vendor ${worst.slot.n}`} ` +
				`at ${money(worst.per1000)}/kg)`,
		};
	}
	return {
		kind: "evict",
		slot: worst.slot,
		evictedVendor: worst.slot.vendorName || `Vendor ${worst.slot.n}`,
		evictedPer1000: worst.per1000,
	};
}

const money = (n: number) => `$${Math.round(n * 100) / 100}`;

/**
 * The Notion properties that write a capture into one slot.
 *
 * `vendor` is always set — on an update it is already that shop, and on a fill or an
 * evict the tag IS the claim. Price, size and URL are each omitted when blank rather
 * than written as null: "I couldn't read a size off this page" must never blank a
 * size the row already had. On an **evict** that leniency is deliberately dropped by
 * `clearMissing`, because the slot now describes a different shop and leaving the
 * old shop's price under the new shop's name is the one outcome worse than a gap.
 */
export function vendorSlotProperties(
	slot: VendorSlotProps,
	capture: {
		vendor: string;
		price?: number | null;
		size?: number | null;
		url?: string;
		/** What this shop calls it — lands in `item Name [Vendor n]`. */
		itemName?: string;
	},
	{ clearMissing = false } = {},
): { properties: Record<string, unknown>; written: string[] } {
	const properties: Record<string, unknown> = {};
	const written: string[] = [];

	properties[slot.vendor] = { select: { name: capture.vendor } };
	written.push(`${slot.vendor} = ${capture.vendor}`);

	const price = typeof capture.price === "number" && Number.isFinite(capture.price) && capture.price > 0
		? Math.round(capture.price * 100) / 100
		: null;
	const size = typeof capture.size === "number" && Number.isFinite(capture.size) && capture.size > 0
		? Math.round(capture.size * 1000) / 1000
		: null;
	const url = (capture.url ?? "").trim();
	// Notion's rich_text cap is 2000; the same 1990 headroom the other writers use.
	const itemName = (capture.itemName ?? "").trim().slice(0, 1990);

	if (slot.price && (price != null || clearMissing)) {
		properties[slot.price] = { number: price };
		written.push(price == null ? `${slot.price} cleared` : `${slot.price} = ${price}`);
	}
	if (slot.size && (size != null || clearMissing)) {
		properties[slot.size] = { number: size };
		written.push(size == null ? `${slot.size} cleared` : `${slot.size} = ${size}`);
	}
	if (slot.url && (url || clearMissing)) {
		properties[slot.url] = { url: url || null };
		written.push(url ? slot.url : `${slot.url} cleared`);
	}
	if (slot.itemName && (itemName || clearMissing)) {
		properties[slot.itemName] = { rich_text: itemName ? [{ text: { content: itemName } }] : [] };
		written.push(itemName ? `${slot.itemName} = ${itemName}` : `${slot.itemName} cleared`);
	}
	return { properties, written };
}

/**
 * The cheapest slot on a row — the baseline the whole deal comparison is measured
 * against, and the local equivalent of Notion's `Price,SGD [Cheapest]` and
 * `Cheapest Vendor ` formulas.
 *
 * Computed here rather than read off those formulas because the scan needs the pack
 * **size** as well as the price (cooldown lengths, per-piece maths and the "is this
 * pack bigger than yours" comparison all rest on it), and no formula publishes the
 * size of the pack it picked. Same rule as the formulas — lowest `price/size*1000`
 * among slots stating both — so the two agree by construction, and the vendor TAG is
 * ignored exactly as the formulas ignore it (a row can hold a price in an untagged
 * slot, and that price still counts).
 */
export function cheapestVendorSlot(slots: VendorSlot[]): {
	slot: VendorSlot;
	per1000: number;
} | null {
	let best: { slot: VendorSlot; per1000: number } | null = null;
	for (const slot of slots) {
		const per1000 = pricePer1000(slot.priceValue, slot.sizeValue);
		if (per1000 == null) continue;
		if (!best || per1000 < best.per1000) best = { slot, per1000 };
	}
	return best;
}
