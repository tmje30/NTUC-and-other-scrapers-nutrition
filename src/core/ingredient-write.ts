import { Client } from "@notionhq/client";
import { categorize, guessSize, matchCategoryOption, type CategoryKey } from "./categorize.js";
import { deriveGenericName } from "./generic-name.js";
import { humanizeProductName } from "./human-name.js";
import { INGREDIENTS_DS, ING_MACRO_PROPS, ING_PROPS } from "./ingredients-schema.js";
import type { Macros } from "./macros.js";
import {
	chooseVendorSlot,
	matchVendorOption,
	readVendorSlots,
	resolveVendorSlotProps,
	vendorOptions,
	vendorSlotProperties,
	type SlotDecision,
} from "./vendor-slots.js";

/**
 * Writing to the Ingredients database from the deals and history pages.
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
 *  3. **Replace touches the price book and nothing else.** Nutrition, plan
 *     formulas, `Select` tags and relations are the user's own work; a cheaper
 *     price at a different shop is no reason to disturb them.
 *
 * ⚠️ **Where a price goes changed completely on 2026-08-09.** Every write used to
 * set `Price,SGD` + `Weight /Units of New Product ` + `Vendor, Current `. Those
 * columns are retired — the first no longer exists, the other two are renamed
 * `… - Delete? ` — and the row's price is now a FORMULA over the price book. So a
 * capture claims a `Vendor n` slot and fills `Price [Vendor n]` / `Size[Vendor n]` /
 * `URL [Vendor n]`, and `Price,SGD [Cheapest]` falls out of it. All the slot rules
 * live in `vendor-slots.ts`; this file only decides what a capture IS.
 */

export interface IngredientFields {
	/** Title — the generic name ("Rolled Oats"). */
	name: string;
	/** Rich text — the shop's full name plus brand. */
	exactName?: string;
	/** What this shop charges for the pack. Lands in `Price [Vendor n]`. */
	priceSgd?: number | null;
	/**
	 * Grams, millilitres or a piece count — whichever `unitType` says. Lands in
	 * `Size[Vendor n]`.
	 */
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
	/**
	 * The shop, in the wording the `Vendor n` selects use ("NTUC", "Sheng Siong").
	 * A name those selects don't already offer is reported and dropped — see
	 * `matchVendorOption`.
	 */
	vendor?: string;
	/** The product page at that shop. Lands in `URL [Vendor n]`. */
	url?: string;
	/**
	 * What THIS shop calls the product. Lands in `item Name [Vendor n]`.
	 *
	 * Usually the same string as `exactName`, but they are not the same field:
	 * `Items Exact Name` is row-level and records one shop's wording, while this is
	 * per-slot, so a row can carry the name each vendor quoted its own price under.
	 */
	itemName?: string;
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
	/** Which vendor slot took the price, and why — null when none did. */
	slot: SlotDecision | null;
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

	// ⚠️ Price, size, vendor and URL are deliberately NOT here. They belong to one
	// `Vendor n` slot, and which slot that is depends on what the row already holds
	// — a decision `vendorSlotProps` makes with the row in hand. Writing them as
	// flat columns is what this change removed.

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
 * Place a capture in the price book: pick the slot, and produce the properties that
 * fill it.
 *
 * `current` is the row's existing `properties` — null for a create, where there is
 * no row yet and every slot is free by definition. Returns empty properties (and a
 * note saying why) whenever nothing should be written, so every caller reports the
 * outcome instead of silently doing nothing.
 *
 * ⚠️ **Every refusal returns a `none` decision, never a null one**, and that is not
 * tidiness. A live test on 2026-08-09 caught the alternative: with `decision: null`
 * for an unrecognised shop, the caller's "did anything land?" check saw no `none`,
 * found `Unit type ` in the written list, and reported *"Replaced: … now records
 * $1.00 from Cold Storage"* — when the price had been correctly skipped. A button
 * that reports success it did not achieve is worse than one that fails loudly.
 * `null` now means one thing only: no shop was supplied, so nothing was attempted.
 */
export function vendorSlotProps(
	f: Partial<IngredientFields>,
	schema: Schema,
	current: Record<string, any> | null,
	{ allowEvict }: { allowEvict: boolean },
): { properties: Record<string, unknown>; written: string[]; skipped: string[]; decision: SlotDecision | null } {
	const empty = { properties: {}, written: [] as string[], skipped: [] as string[], decision: null };
	const vendor = (f.vendor ?? "").trim();
	if (!vendor) return empty;

	const refuse = (reason: string, skipped: string) => ({
		properties: {},
		written: [] as string[],
		skipped: [skipped],
		decision: { kind: "none", reason } as SlotDecision,
	});

	const slotProps = resolveVendorSlotProps(schema);
	if (!slotProps.length) {
		return refuse(
			`this database has no "Vendor 1" column`,
			`${vendor} price (this database has no "Vendor 1" column)`,
		);
	}

	// Rule 2, and the one place it bites hardest: `Vendor n` is a SELECT, so an
	// unrecognised shop would have Notion create the option. Cold Storage, Giant and
	// RedMart are all real shops with no option today — they are reported, not added.
	const option = matchVendorOption(vendorOptions(schema, slotProps), vendor);
	if (!option) {
		return refuse(
			`"${vendor}" is not an existing "Vendor n" option`,
			`${vendor} (not an existing "Vendor n" option — add it in Notion if you want it tracked; ` +
				`this tool never creates schema)`,
		);
	}

	const slots = readVendorSlots(current ?? {}, slotProps);
	const decision = chooseVendorSlot(
		slots,
		{ vendor: option, price: f.priceSgd ?? null, size: f.size ?? null },
		{ allowEvict },
	);
	if (decision.kind === "none") {
		return { ...empty, decision, skipped: [`${option} price (${decision.reason})`] };
	}

	const { properties, written } = vendorSlotProperties(
		decision.slot,
		{ vendor: option, price: f.priceSgd, size: f.size, url: f.url, itemName: f.itemName },
		// An evicted slot is re-pointed at a different shop, so anything the previous
		// one left behind is cleared rather than inherited.
		{ clearMissing: decision.kind === "evict" },
	);
	return { properties, written, skipped: [], decision };
}

/** One line for the reply, explaining which slot was chosen and why. */
export function describeSlotDecision(decision: SlotDecision | null): string {
	if (!decision) return "";
	switch (decision.kind) {
		case "update":
			return `Vendor ${decision.slot.n} was already ${decision.slot.vendorName} — updated its price, size and URL.`;
		case "fill":
			return `Vendor ${decision.slot.n} was free — tagged it and filled its price, size and URL.`;
		case "evict":
			return (
				`All vendor slots were taken, so Vendor ${decision.slot.n} ` +
				`(${decision.evictedVendor}, $${Math.round(decision.evictedPer1000 * 100) / 100}/kg — the dearest) ` +
				`was replaced by this cheaper one.`
			);
		case "none":
			return `Nothing written to the price book: ${decision.reason}.`;
	}
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
	/** Pieces in the pack, when the shop counts rather than weighs (a 30-egg tray). */
	unitCount?: number | null;
	url: string;
	ingredientName: string;
}): IngredientFields {
	// ⚠️ Before anything is derived, not after. A shop that handed over a URL slug
	// instead of a title ("cerave-pm-facial-moisturizing-lotion-52ml-630062.html")
	// would otherwise have it parsed for a size, guessed at for a category and
	// written verbatim into `Items Exact Name`, where it stays for the life of the
	// row. Nearly every product arrives with a real title and passes through
	// `humanizeProductName` untouched.
	const product = humanizeProductName(p.product);
	const generic = deriveGenericName(product, "") || p.ingredientName || product;
	// Three sources, and the ORDER is the whole point.
	//
	// 1. A published pack WEIGHT wins. ⚠️ It has to: plenty of packs state both, and
	//    "10 x 100ml" carries a count of 10 as well as 1000 ml. Taking the count
	//    first would file a litre of milk as 10 units and price it per bottle.
	// 2. Otherwise a published piece COUNT — the egg-tray case. The shop publishes no
	//    weight for a 30-egg tray, so 30 is the honest size and `By Unit` is the
	//    honest type. The tray's weight belongs in the ingredient's own Name
	//    ("Egg tray, 350g"), which is where the scan reads it from to compare 30
	//    quail eggs against 10 hen's eggs by weight — see `compare.ts`.
	// 3. Otherwise parse the product name, which is all a shop that published
	//    neither leaves us.
	const sized =
		p.packSizeG && p.packSizeG > 0
			? { amount: p.packSizeG, unitType: p.volumetric ? "By ml" : "By Gram" }
			: p.unitCount && p.unitCount > 0
				? { amount: p.unitCount, unitType: "By Unit" }
				: guessSize(product);

	return {
		name: generic,
		exactName: product,
		// The shop's own wording, recorded against the slot its price lands in as
		// well as on the row — see `IngredientFields.itemName`.
		itemName: product,
		priceSgd: p.priceSgd,
		size: sized.amount,
		// ⚠️ **No size, no unit type.** `Unit type ` says what `Size[Vendor n]` counts,
		// so claiming one without the other is an assertion we cannot back. It used to
		// default to `By Gram` here, which on a *Replace* would quietly flip a By-Unit
		// egg row to By Gram and leave its piece counts being read as grams. Undefined
		// is dropped by `buildProps`, so the row keeps the type the user gave it.
		unitType: sized.amount != null ? (sized.unitType ?? (p.volumetric ? "By ml" : "By Gram")) : undefined,
		categoryKey: categorize(generic || product),
		vendor: p.store,
		url: p.url,
	};
}

/**
 * "Add" — a new Ingredients row, with this shop as its first vendor.
 *
 * The slot logic runs here too, even though a brand-new row has four empty slots
 * and the answer is therefore always `Vendor 1`. Going through `chooseVendorSlot`
 * rather than hardcoding "1" is what keeps Add and Replace provably in step: there
 * is one rule for where a price goes, and both buttons obey it. Eviction is
 * disallowed — nothing on a row that didn't exist a moment ago can be displaced.
 */
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

	const base = buildProps(resolved, schema);
	const slot = vendorSlotProps(resolved, schema, null, { allowEvict: false });

	const page = (await client.pages.create({
		parent: { type: "data_source_id", data_source_id: INGREDIENTS_DS },
		properties: { ...base.properties, ...slot.properties },
	} as any)) as any;

	return {
		id: page.id,
		notionUrl: page.url,
		written: [...base.written, ...slot.written],
		skipped: [...base.skipped, ...slot.skipped],
		slot: slot.decision,
	};
}

/**
 * The row as it stands, so the slot rules can see what is already there.
 *
 * Both replace paths need this and neither can skip it: which slot a price belongs
 * in is a fact about the ROW, not about the product, and guessing it is how a
 * Guardian price ends up under the Watsons tag.
 */
async function currentProps(client: Client, pageId: string): Promise<Record<string, any>> {
	const page = (await client.pages.retrieve({ page_id: pageId } as any)) as any;
	return page.properties ?? {};
}

/**
 * "Replace Current" — repoint an existing row at this product.
 *
 * Writes ONLY the vendor slot this shop belongs in. The name is deliberately left
 * alone, unlike the Chrome extension's "Replace With This": there, the user is
 * looking at the product page and has explicitly chosen to rename the row. Here the
 * row is an ingredient they already maintain and the button means "same thing, new
 * price" — silently renaming "Chicken thigh, Boneless" to whatever the shop calls
 * this week's pack would be a change nobody asked for.
 */
export async function replaceIngredientPrice(
	client: Client,
	pageId: string,
	fields: Pick<IngredientFields, "priceSgd" | "size" | "unitType" | "vendor" | "url" | "itemName">,
): Promise<WriteResult> {
	if (!pageId) throw new Error("no ingredient row to replace");
	const schema = await schemaOf(client);
	const base = buildProps(fields, schema);
	const slot = vendorSlotProps(fields, schema, await currentProps(client, pageId), { allowEvict: true });

	const properties = { ...base.properties, ...slot.properties };
	// A refusal to write is a legitimate outcome now — "every slot is taken and this
	// isn't cheaper" is an answer, not a failure — so it reports rather than throws.
	// Only a payload with nothing in it at all is an error.
	if (!Object.keys(properties).length && !slot.skipped.length) {
		throw new Error("nothing to write — no price, size or vendor");
	}
	if (!Object.keys(properties).length) {
		return {
			id: pageId,
			notionUrl: "",
			written: [],
			skipped: [...base.skipped, ...slot.skipped],
			slot: slot.decision,
		};
	}

	const page = (await client.pages.update({ page_id: pageId, properties } as any)) as any;
	return {
		id: page.id,
		notionUrl: page.url,
		written: [...base.written, ...slot.written],
		skipped: [...base.skipped, ...slot.skipped],
		slot: slot.decision,
	};
}

/**
 * What a background price scan is allowed to write: ONE already-tagged vendor slot.
 *
 * ⚠️ **This is deliberately not `replaceIngredientPrice`, and the difference is the
 * whole safety argument for letting a scan write at all.** That function serves a
 * button — a person looked at one product and chose it — so it may claim a free slot
 * and even evict the dearest. A scan has made no such judgement, so it obeys the
 * stricter rule stated in `docs/vendor-scoping.md` and repeated in `HANDOVER.md`:
 *
 *   > Find the index by matching the vendor NAME. **If no index names that shop,
 *   > write nothing.** Do not add the vendor to a free slot — the tags are the user's
 *   > statement of where an item can be found.
 *
 * So only `chooseVendorSlot`'s `update` case is accepted here. A `fill` means the user
 * never said this shop sells this item, and an `evict` means throwing away a price they
 * recorded; both are refusals, with a reason, never a silent no-op.
 *
 * ⚠️ **It also writes NOTHING outside the four slot columns — in particular not
 * `Unit type `.** That column is row-level and says whether every `Size[Vendor n]` on
 * the row counts grams or pieces. `replaceIngredientPrice` sets it (correctly, for a
 * human capture); a scan doing the same would let one shop's gram-size silently
 * re-interpret every other slot's size on the row. A candidate whose unit kind disagrees
 * with the row is refused by the caller instead.
 */
export async function recordVendorPrice(
	client: Client,
	pageId: string,
	capture: {
		vendor: string;
		priceSgd?: number | null;
		size?: number | null;
		url?: string;
		itemName?: string;
	},
): Promise<WriteResult> {
	if (!pageId) throw new Error("no ingredient row to record against");
	const vendor = capture.vendor.trim();
	if (!vendor) throw new Error("no shop to record against");

	const schema = await schemaOf(client);
	const slotDefs = resolveVendorSlotProps(schema);
	if (!slotDefs.length) {
		return refusal(pageId, `this database has no "Vendor 1" column`);
	}

	const option = matchVendorOption(vendorOptions(schema, slotDefs), vendor);
	if (!option) {
		return refusal(pageId, `"${vendor}" is not an existing "Vendor n" option`);
	}

	const slots = readVendorSlots(await currentProps(client, pageId), slotDefs);
	const decision = chooseVendorSlot(
		slots,
		{ vendor: option, price: capture.priceSgd ?? null, size: capture.size ?? null },
		// Never displace a shop the user recorded; a full row simply has no free slot,
		// and this refuses on anything but `update` regardless.
		{ allowEvict: false },
	);
	if (decision.kind !== "update") {
		return refusal(
			pageId,
			decision.kind === "none"
				? decision.reason
				: `no Vendor slot names ${option} on this row (a scan never claims a free slot)`,
		);
	}

	const { properties, written } = vendorSlotProperties(decision.slot, {
		vendor: option,
		price: capture.priceSgd,
		size: capture.size,
		url: capture.url,
		itemName: capture.itemName,
	});

	const page = (await client.pages.update({ page_id: pageId, properties } as any)) as any;
	return { id: page.id, notionUrl: page.url, written, skipped: [], slot: decision };
}

/** A write that correctly did not happen, reported as an outcome rather than a throw. */
function refusal(pageId: string, reason: string): WriteResult {
	return {
		id: pageId,
		notionUrl: "",
		written: [],
		skipped: [reason],
		slot: { kind: "none", reason },
	};
}

/**
 * "Replace" on the DEALS page — re-base an ingredient on the product that beat it.
 *
 * ⚠️ **This is not `replaceIngredientPrice` above, and merging them would be a
 * bug.** They differ on exactly the two fields that matter:
 *
 * - **It renames the row**, to a generic name derived from the product. The
 *   history page's version deliberately does not, because there the button means
 *   "same thing, new price". Here it means "this cheaper product is what this
 *   ingredient should be from now on" — and the row's name is the search term the
 *   daily scan uses, so leaving it would keep hunting for the thing you just
 *   replaced.
 *
 * ⚠️ **It now writes the URL, which it deliberately did not before 2026-08-09.**
 * The old reasoning was that `Vendor 1 URL` belonged to whatever shop `Vendor 1`
 * named, so writing this product's link there could misfile it — a real bug, logged
 * in `docs/vendor-scoping.md`. The slot rules fix the cause: the URL goes to
 * `URL [Vendor n]` for the n that names THIS shop, so there is nothing left to
 * misfile and the link is worth keeping.
 *
 * Everything else on the row — tags, plan formulas, the columns nothing here
 * names — is untouched, same as every other write in this file.
 */
export async function rebaseIngredient(
	client: Client,
	pageId: string,
	fields: Pick<
		IngredientFields,
		"name" | "priceSgd" | "size" | "unitType" | "vendor" | "url" | "itemName" | "macros"
	>,
): Promise<WriteResult> {
	if (!pageId) throw new Error("no ingredient row to re-base");
	if (!fields.name?.trim()) throw new Error("re-basing needs a name — refusing to blank the title");
	const schema = await schemaOf(client);
	const base = buildProps(fields, schema);
	const slot = vendorSlotProps(fields, schema, await currentProps(client, pageId), { allowEvict: true });

	const properties = { ...base.properties, ...slot.properties };
	if (!Object.keys(properties).length) throw new Error("nothing to write");

	const page = (await client.pages.update({ page_id: pageId, properties } as any)) as any;
	return {
		id: page.id,
		notionUrl: page.url,
		written: [...base.written, ...slot.written],
		skipped: [...base.skipped, ...slot.skipped],
		slot: slot.decision,
	};
}
