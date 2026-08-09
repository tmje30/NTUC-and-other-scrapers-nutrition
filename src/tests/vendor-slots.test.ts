import { fieldsFromPurchase, vendorSlotProps } from "../core/ingredient-write.js";
import {
	cheapestVendorSlot,
	chooseVendorSlot,
	matchVendorOption,
	pricePer1000,
	readVendorSlots,
	resolveVendorSlotProps,
	vendorOptions,
	vendorSlotProperties,
} from "../core/vendor-slots.js";
import { check, describe, eq } from "./harness.js";

/**
 * The price book — which `Vendor n` slot a captured price lands in.
 *
 * ⚠️ **This is the highest-stakes pure function in the project, and every failure
 * here is silent.** A slot chosen wrongly writes a Guardian price under the Watsons
 * tag: nothing errors, the row looks filled in, and the number is simply attributed
 * to the wrong shop forever. An eviction rule that compares the wrong way round
 * throws away the cheapest source and keeps the dearest. Neither announces itself,
 * and both are only visible by reading the row months later.
 *
 * The rules under test are the user's, stated 2026-08-09:
 *   Add     → first free slot gets tagged with this site's vendor.
 *   Replace → this shop's own slot if it has one; else the first free slot; else the
 *             slot with the highest `Price / Size * 1000`, and ONLY if this product
 *             is cheaper per kg than that.
 */
describe("price book — resolving the columns");

// The live schema, verbatim, spacing included. `Price [Vendor 2] ` has a trailing
// space and `Price [Vendor 1]` does not; `Size[Vendor n]` has no space after "Size".
// Sixteen names, four of them irregular — which is exactly why the resolver matches
// on the normalised name instead of a hardcoded list.
const SCHEMA: Record<string, any> = {
	Name: { type: "title" },
	"Unit type ": { type: "select", select: { options: [{ name: "By Gram" }] } },
	"Vendor 1": { type: "select", select: { options: [{ name: "NTUC" }, { name: "Sheng Siong" }, { name: "Watsons" }, { name: "Guardian" }, { name: "Iherb" }] } },
	"Price [Vendor 1]": { type: "number" },
	"Size[Vendor 1]": { type: "number" },
	"URL [Vendor 1]": { type: "url" },
	"Vendor 2": { type: "select", select: { options: [{ name: "NTUC" }, { name: "Sheng Siong" }, { name: "Watsons" }, { name: "Guardian" }, { name: "Iherb" }] } },
	"Price [Vendor 2] ": { type: "number" },
	"Size[Vendor 2]": { type: "number" },
	"URL [Vendor 2]": { type: "url" },
	"Vendor 3": { type: "select", select: { options: [{ name: "NTUC" }] } },
	"Price [Vendor 3]": { type: "number" },
	"Size[Vendor 3]": { type: "number" },
	"URL [Vendor 3]": { type: "url" },
	"Vendor 4": { type: "select", select: { options: [{ name: "NTUC" }] } },
	"Price [Vendor 4]": { type: "number" },
	"Size[Vendor 4]": { type: "number" },
	"URL [Vendor 4]": { type: "url" },
};

const defs = resolveVendorSlotProps(SCHEMA);

eq("all four slots are found", defs.length, 4);
eq(
	"the trailing space in Price [Vendor 2] is preserved verbatim",
	defs[1].price,
	"Price [Vendor 2] ",
);
eq("Size[Vendor 1] has no space after Size", defs[0].size, "Size[Vendor 1]");
eq("URL [Vendor 3] is found — it exists now", defs[2].url, "URL [Vendor 3]");

// A slot's price/size/URL are each independently optional. A DB missing one records
// less rather than failing the whole write.
const partial = resolveVendorSlotProps({
	"Vendor 1": { type: "select", select: { options: [] } },
	"Price [Vendor 1]": { type: "number" },
});
eq("a slot with no size or URL column still resolves", partial.length, 1);
eq("and reports the missing columns as null", [partial[0].size, partial[0].url], [null, null]);
eq("a database with no Vendor columns resolves to nothing", resolveVendorSlotProps({ Name: { type: "title" } }).length, 0);

// ⚠️ Type matters as much as name. A `Vendor 1` that someone turned into rich text
// is not a select, and writing `{select:{name}}` to it fails the whole request.
eq(
	"a Vendor column of the wrong type is not claimed",
	resolveVendorSlotProps({ "Vendor 1": { type: "rich_text" } }).length,
	0,
);

describe("price book — never inventing a shop");

const options = vendorOptions(SCHEMA, defs);
eq("options are deduped across the four selects", options.sort(), ["Guardian", "Iherb", "NTUC", "Sheng Siong", "Watsons"]);

// ⚠️ The whole point: `Vendor n` is a SELECT, so an unknown name makes Notion CREATE
// the option — a schema edit to a live personal workspace this tool must never make.
eq("a known shop matches", matchVendorOption(options, "NTUC"), "NTUC");
eq("matching ignores case and spacing", matchVendorOption(options, " sheng  siong "), "Sheng Siong");
eq("iHerb finds the option spelled Iherb", matchVendorOption(options, "iHerb"), "Iherb");
eq("a shop with no option is refused, not created", matchVendorOption(options, "Cold Storage"), null);
eq("and so is a bare hostname from an unmapped site", matchVendorOption(options, "coldstorage.com.sg"), null);
eq("an empty vendor is refused", matchVendorOption(options, "   "), null);

describe("price book — price per kg");

eq("the user's own expression: price / size * 1000", pricePer1000(9.95, 2000), 4.975);
// A price with no size is not cheap or dear, it is unknown — and the entire
// comparison rests on this number, so it must refuse rather than guess.
eq("no size means no figure", pricePer1000(9.95, null), null);
eq("no price means no figure", pricePer1000(null, 2000), null);
eq("a zero size never divides", pricePer1000(9.95, 0), null);
eq("a free item is not a comparable price", pricePer1000(0, 500), null);

describe("price book — choosing the slot");

/** One row's slots, from a compact `[vendor, price, size]` per slot. */
const row = (...spec: [string, number | null, number | null][]) => {
	const props: Record<string, any> = {};
	spec.forEach(([vendor, price, size], i) => {
		const d = defs[i];
		if (vendor) props[d.vendor] = { select: { name: vendor } };
		if (price != null) props[d.price!] = { number: price };
		if (size != null) props[d.size!] = { number: size };
	});
	return readVendorSlots(props, defs);
};

// ── 1. A shop that already owns a slot keeps it ────────────────────────────────
// A second NTUC price is the same shop quoting a new number, not a new shop. If
// this fell through to "first free slot" the row would carry NTUC twice and the
// stale price would keep competing against the fresh one.
const tagged = chooseVendorSlot(row(["NTUC", 5, 500], ["Sheng Siong", 6, 500]), {
	vendor: "NTUC",
	price: 4,
	size: 500,
});
eq("an already-tagged shop updates its own slot", [tagged.kind, tagged.kind !== "none" ? tagged.slot.n : 0], ["update", 1]);

const taggedSecond = chooseVendorSlot(row(["NTUC", 5, 500], ["Sheng Siong", 6, 500]), {
	vendor: "Sheng Siong",
	price: 4,
	size: 500,
});
eq(
	"the slot is found by NAME, not by position",
	[taggedSecond.kind, taggedSecond.kind !== "none" ? taggedSecond.slot.n : 0],
	["update", 2],
);

// ⚠️ A slot tagged with a shop but holding no price is the user saying "also look
// here". It is that shop's slot, and a capture from that shop fills it in — the case
// that matters most, because `Vendor 2 = Sheng Siong` with no price is the single
// most common shape in the live database.
const placeholder = chooseVendorSlot(row(["NTUC", 5, 500], ["Sheng Siong", null, null]), {
	vendor: "Sheng Siong",
	price: 4,
	size: 500,
});
eq(
	"a tagged-but-empty slot is filled by its own shop",
	[placeholder.kind, placeholder.kind !== "none" ? placeholder.slot.n : 0],
	["update", 2],
);

// ── 2. Otherwise the first free slot ───────────────────────────────────────────
const fresh = chooseVendorSlot(row(), { vendor: "NTUC", price: 4, size: 500 });
eq("a brand-new row takes Vendor 1", [fresh.kind, fresh.kind !== "none" ? fresh.slot.n : 0], ["fill", 1]);

const next = chooseVendorSlot(row(["NTUC", 4, 500]), { vendor: "Watsons", price: 9, size: 500 });
eq("a new shop takes the next free slot", [next.kind, next.kind !== "none" ? next.slot.n : 0], ["fill", 2]);

// ⚠️ Free means EMPTY, not untagged. The live DB has rows holding a price in a slot
// whose vendor tag was never set (Notion's own Cheapest formulas ignore the tag too).
// Treating that as free would silently overwrite a real price with a different shop's.
const untagged = chooseVendorSlot(row(["", 6.95, 10]), { vendor: "Watsons", price: 9, size: 500 });
eq(
	"a slot holding a price is not free, even with no vendor tag",
	[untagged.kind, untagged.kind !== "none" ? untagged.slot.n : 0],
	["fill", 2],
);

// ── 3. All four taken: the dearest per kg gives way, and only to a cheaper one ──
// $/kg: NTUC 10, Sheng Siong 20, Watsons 40 ← dearest, Guardian 30.
const full: [string, number | null, number | null][] = [
	["NTUC", 5, 500],
	["Sheng Siong", 10, 500],
	["Watsons", 20, 500],
	["Guardian", 15, 500],
];

const cheaper = chooseVendorSlot(row(...full), { vendor: "Iherb", price: 12, size: 500 });
eq(
	"the dearest per kg is the one displaced",
	[cheaper.kind, cheaper.kind !== "none" ? cheaper.slot.n : 0],
	["evict", 3],
);
check(
	"and the reply names who lost their place",
	cheaper.kind === "evict" && cheaper.evictedVendor === "Watsons" && cheaper.evictedPer1000 === 40,
);

// ⚠️ The gate that stops the price book degrading. Without it, every capture would
// displace something and the four slots would drift towards whatever was tapped last
// rather than the four cheapest sources.
const dearer = chooseVendorSlot(row(...full), { vendor: "Iherb", price: 25, size: 500 });
eq("a dearer product displaces nothing", dearer.kind, "none");
check(
	"and says why, naming both figures",
	dearer.kind === "none" && dearer.reason.includes("Watsons") && dearer.reason.includes("$50"),
);
eq(
	"an equal price displaces nothing either — a tie is not an improvement",
	chooseVendorSlot(row(...full), { vendor: "Iherb", price: 20, size: 500 }).kind,
	"none",
);

// ⚠️ Cheaper per KG, not cheaper per pack. A $12 pack beats a $20 pack outright, but
// at half the size it is the same price per kg — and this is the error that makes a
// bad deal look spectacular, the same family as the 32 g serving read as 100 g.
eq(
	"a smaller, cheaper pack at the same price per kg is refused",
	chooseVendorSlot(row(...full), { vendor: "Iherb", price: 10, size: 250 }).kind,
	"none",
);

// A capture with no size cannot be ranked, so it cannot displace anything. It is
// still perfectly welcome in a free slot — see `fill` above.
eq(
	"a sizeless capture never evicts",
	chooseVendorSlot(row(...full), { vendor: "Iherb", price: 5, size: null }).kind,
	"none",
);

// Only slots stating BOTH halves are candidates. A tagged placeholder has no figure,
// and displacing it would throw away the user's own routing intent on a technicality.
eq(
	"a full row of placeholders offers nothing to displace",
	chooseVendorSlot(
		row(["NTUC", null, null], ["Sheng Siong", null, null], ["Watsons", null, null], ["Guardian", null, null]),
		{ vendor: "Iherb", price: 1, size: 500 },
	).kind,
	"none",
);

// ── Add never displaces ────────────────────────────────────────────────────────
// Add only ever writes a NEW row, where step 2 always wins. If a caller ever hands
// it a full row, doing nothing beats silently unseating a shop on an "add".
eq(
	"Add refuses to evict even when it would be cheaper",
	chooseVendorSlot(row(...full), { vendor: "Iherb", price: 1, size: 500 }, { allowEvict: false }).kind,
	"none",
);

eq(
	"no shop, no slot",
	chooseVendorSlot(row(), { vendor: "", price: 4, size: 500 }).kind,
	"none",
);

describe("price book — what gets written");

const filled = vendorSlotProperties(defs[0], { vendor: "NTUC", price: 4.005, size: 500.0004, url: " x " });
eq("the vendor tag is always set", (filled.properties["Vendor 1"] as any).select.name, "NTUC");
eq("money is rounded to cents", (filled.properties["Price [Vendor 1]"] as any).number, 4.01);
eq("a size is rounded to 3dp", (filled.properties["Size[Vendor 1]"] as any).number, 500);
eq("the URL is trimmed", (filled.properties["URL [Vendor 1]"] as any).url, "x");

// ⚠️ Rule 1 of both writers: a blank field is OMITTED, never written as null. "I
// couldn't read a size off this page" must not blank a size the row already had.
const sparse = vendorSlotProperties(defs[0], { vendor: "NTUC", price: null, size: null, url: "" });
eq("a blank price is omitted, not nulled", "Price [Vendor 1]" in sparse.properties, false);
eq("a blank size is omitted", "Size[Vendor 1]" in sparse.properties, false);
eq("a blank URL is omitted", "URL [Vendor 1]" in sparse.properties, false);
eq("but the tag still lands", "Vendor 1" in sparse.properties, true);

// ⚠️ …except on an eviction, where the slot now names a DIFFERENT shop. Leaving the
// old shop's price under the new shop's tag is the one outcome worse than a gap.
const evicted = vendorSlotProperties(defs[0], { vendor: "Iherb", price: 3, size: null, url: "" }, { clearMissing: true });
eq("an eviction clears what it cannot fill", (evicted.properties["Size[Vendor 1]"] as any).number, null);
eq("and clears the old shop's URL too", (evicted.properties["URL [Vendor 1]"] as any).url, null);

// A schema without a URL column simply records no link, rather than failing.
const noUrlCol = vendorSlotProperties({ n: 1, vendor: "Vendor 1", price: null, size: null, url: null }, {
	vendor: "NTUC",
	price: 4,
	url: "https://x",
});
eq("a missing column is skipped, never sent", Object.keys(noUrlCol.properties), ["Vendor 1"]);

describe("price book — counted packs (the egg tray)");

/**
 * ⚠️ **The precedence between a pack weight and a piece count, which is invisible
 * when wrong.** A 30-egg tray must land as `Size[Vendor n] = 30` / `By Unit`, with
 * the tray's weight living in the ingredient's own Name ("Egg tray, 350g") — that
 * name-weight is what lets the scan compare 30 quail eggs against 10 hen's eggs by
 * weight instead of pretending a quail egg and a hen's egg are both "1".
 *
 * But a pack can state BOTH. "10 x 100ml" is a litre of milk *and* a count of 10,
 * and reading the count first files a litre as ten units — priced per bottle, which
 * flatters it tenfold. So: a published weight always wins, and the count is used
 * only when there is no weight.
 */
const sizedAs = (p: { packSizeG: number | null; unitCount?: number | null; volumetric?: boolean; product?: string }) => {
	const f = fieldsFromPurchase({
		product: p.product ?? "Pasar Fresh Eggs",
		store: "NTUC",
		priceSgd: 5,
		packSizeG: p.packSizeG,
		unitCount: p.unitCount ?? null,
		volumetric: Boolean(p.volumetric),
		url: "https://x",
		ingredientName: "Eggs",
	});
	return [f.size, f.unitType];
};

eq("a 30-egg tray with no published weight lands as 30 By Unit", sizedAs({ packSizeG: null, unitCount: 30 }), [30, "By Unit"]);
eq("a weighed pack is unaffected", sizedAs({ packSizeG: 2000, unitCount: null }), [2000, "By Gram"]);
eq("a volumetric pack is unaffected", sizedAs({ packSizeG: 1500, unitCount: null, volumetric: true }), [1500, "By ml"]);
// The trap this ordering exists for.
eq(
	"a pack stating BOTH is a weight, never a count — 10 x 100ml is a litre",
	sizedAs({ packSizeG: 1000, unitCount: 10, volumetric: true, product: "Milk 10 x 100ml" }),
	[1000, "By ml"],
);
// Neither published: fall back to reading the product name, as it always did.
eq(
	"neither published falls back to the product name",
	sizedAs({ packSizeG: null, unitCount: null, product: "Fresh Eggs 10s" }),
	[10, "By Unit"],
);
eq("a zero count is not a count", sizedAs({ packSizeG: null, unitCount: 0, product: "Bananas" }), [null, undefined]);
// ⚠️ And with no size, NO unit type is claimed. It used to default to `By Gram`,
// which on a Replace would flip a By-Unit egg row and leave its piece counts being
// read as grams — now that `Unit type ` is what says whether `Size[Vendor n]` is
// grams or pieces, that default was actively dangerous.
eq(
	"an unreadable pack asserts no unit type at all",
	sizedAs({ packSizeG: null, unitCount: null, product: "Loose Bananas" }),
	[null, undefined],
);

describe("price book — the baseline it feeds");

// This reproduces Notion's own `Price,SGD [Cheapest]` / `Cheapest Vendor `, and the
// daily scan now reads it instead of the retired `Price,SGD` column. Getting it
// wrong prices every ingredient wrongly and every deal on the page with it.
const best = cheapestVendorSlot(row(["NTUC", 10, 500], ["Sheng Siong", 9, 300], ["Watsons", 20, 2000]));
eq("the cheapest per kg wins, not the cheapest pack", best?.slot.vendorName, "Watsons");
eq("and it carries the SIZE, which no formula publishes", best?.slot.sizeValue, 2000);

eq(
	"a slot with a price but no size is not comparable",
	cheapestVendorSlot(row(["NTUC", 10, null]))?.slot.vendorName ?? null,
	null,
);
// ⚠️ The tag is ignored, exactly as Notion's formulas ignore it — a real row in the
// live DB holds 6.95/10 in an untagged Vendor 1, and that price still counts.
// Rounded on comparison, not in the function: the figure is only ever used to RANK
// slots, so carrying the full float is correct and 695.0000000000001 is not a bug.
eq(
	"an untagged slot's price still counts",
	Math.round((cheapestVendorSlot(row(["", 6.95, 10]))?.per1000 ?? 0) * 100) / 100,
	695,
);
eq("an empty row has no baseline", cheapestVendorSlot(row()), null);

describe("price book — a refusal must never read as a success");

/**
 * ⚠️ **Caught by a live write on 2026-08-09, not by any test.** Replacing from a
 * shop with no `Vendor n` option correctly skipped the price — and then reported
 * *"Replaced: … now records $1.00 from Cold Storage"*, because the caller asked
 * "were any properties written?" and a refused replace still writes `Unit type `.
 *
 * The report is the only thing the user ever sees; a button that claims a write it
 * did not make is worse than one that fails outright, because nothing prompts anyone
 * to check. So a refusal now carries a `none` DECISION rather than a null one, and
 * `null` means only "no shop was supplied, nothing was attempted".
 */
// Tested at the WRITE layer, not on `chooseVendorSlot`: an unrecognised shop never
// reaches the chooser — `matchVendorOption` refuses it first — so this is the only
// level at which the bug was reachable, and the only one where the fix is real.
const coldStorage = vendorSlotProps(
	{ vendor: "Cold Storage", priceSgd: 1, size: 500, unitType: "By Gram" },
	SCHEMA,
	{},
	{ allowEvict: true },
);
eq("an unrecognised shop refuses with a decision, not an absence", coldStorage.decision?.kind, "none");
eq("and writes nothing to the price book", Object.keys(coldStorage.properties), []);
check("and names the shop in what it skipped", coldStorage.skipped.join(" ").includes("Cold Storage"));

// ⚠️ `null` now means ONE thing: no shop was supplied, so nothing was attempted.
// Anything else that declines says so with a `none`, which is what lets the caller
// test a single field instead of counting written properties.
const noVendor = vendorSlotProps({ priceSgd: 1, size: 500 }, SCHEMA, {}, { allowEvict: true });
eq("no shop supplied is the only null decision", noVendor.decision, null);

// The success case at the same layer, so the two stay distinguishable.
const landed = vendorSlotProps({ vendor: "NTUC", priceSgd: 1, size: 500 }, SCHEMA, {}, { allowEvict: true });
eq("a real shop lands a decision", landed.decision?.kind, "fill");
check("and actually writes the slot", Object.keys(landed.properties).includes("Vendor 1"));

// Every refusal path returns `none`, so a caller can test one thing.
for (const [label, d] of [
	["a full row, dearer", chooseVendorSlot(row(...full), { vendor: "Iherb", price: 25, size: 500 })],
	["a full row, no size to compare", chooseVendorSlot(row(...full), { vendor: "Iherb", price: 25, size: null })],
	["Add against a full row", chooseVendorSlot(row(...full), { vendor: "Iherb", price: 1, size: 500 }, { allowEvict: false })],
	["no shop at all", chooseVendorSlot(row(), { vendor: "", price: 1, size: 500 })],
] as const) {
	check(`${label} → none, with a reason`, d.kind === "none" && d.reason.length > 0);
}

// And the successes stay distinguishable from them — the whole point of the check.
check("a fill is not a refusal", chooseVendorSlot(row(), { vendor: "NTUC", price: 1, size: 500 }).kind === "fill");
