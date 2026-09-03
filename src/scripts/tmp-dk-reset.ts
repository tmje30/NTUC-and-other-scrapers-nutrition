/**
 * One-off: reset the Singapore data out of `Ingredients (Denmark)` and retag the
 * vendor slots for the Danish shops.
 *
 * Two passes, run separately, because the second one depends on a schema change
 * only the user may make:
 *   --clear  wipes Vendor n / Price / Size / URL / item Name on every row
 *   --tag    writes the Danish shop into Vendor 1..n by the row's Category
 *
 * Neither pass invents a select option: `--tag` refuses outright if the Danish
 * names are not already offered by the live schema (vendor-slots.ts rule 2).
 * Nothing is written without `--write`; the default is a dry run.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { resolveVendorSlotProps, readVendorSlots, isSlotFree, matchVendorOption, vendorOptions } from "../core/vendor-slots.js";

const client = new Client({ auth: config.notionToken() });
const ING_DK = "3d469a18-4fe7-8236-bf80-07fdbda8d31f";
const plain = (r: any[] | undefined) => (r ?? []).map((x) => x.plain_text).join("");

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const DO_CLEAR = args.has("--clear");
const DO_TAG = args.has("--tag");
const BACKUP = process.argv.find((a) => a.startsWith("--backup="))?.slice(9);

/**
 * Which shops serve which Category, in slot order.
 *
 * Names are the LIVE select options verbatim — `COOP365` not "Coop 365",
 * `My Protein` not "MyProtein", `KFT (Asian Food)` as spelled in Notion. Every one
 * is checked against the schema before any write, so a rename in Notion surfaces as
 * a refusal rather than a silently skipped slot.
 *
 * ⚠️ `DBA` is deliberately in no list. It is a second-hand marketplace, so what it
 * can supply is a property of the ITEM, not of its category — the same reason
 * Carousell was only ever hand-tagged on three Singapore rows.
 */
const SUPERMARKETS = ["REMA 1000", "Super Brugsen", "LIDL", "COOP365"];
const ASIAN = ["Ume (Asian Food)", "KFT (Asian Food)"];
const SUPPLEMENTS = ["My Protein", "Bulk Powders", "Iherb", "Google Search"];
const COSMETICS = ["MATAS", "LuxPlus", "REMA 1000", "Super Brugsen", "LIDL", "COOP365"];
const HOUSEHOLD = ["REMA 1000", "Super Brugsen", "LIDL", "COOP365", "Google Search"];
const ALL_LISTS = [SUPERMARKETS, ASIAN, SUPPLEMENTS, COSMETICS, HOUSEHOLD];

/**
 * The grocery rows a Danish supermarket will not stock, which therefore earn
 * `Ume` and `KFT` in slots 5–6 on top of the four supermarkets.
 *
 * ⚠️ An explicit list, not a keyword rule, and that is the point: "asian" is a
 * judgement about what REMA carries, not a property of the word. A rule keyed on
 * "rice" or "tea" would rope in Oatmeal and Green Tea's Danish equivalents while
 * still missing `blachan[Taho]` and `Tau Kwa`. Names are matched trimmed and
 * case-insensitively, so Notion's stray trailing spaces do not break it.
 */
const ASIAN_ROWS = new Set(
	[
		"Lotus Root", "Kimchi", "Ginger (Bentong)", "Szechuan pepper", "Edamame (peeled/Frozen)",
		"Soy Sauce (light)", "Rice Cooking Wine - 16% Alcohol", "Thai Red rice", "Fish Sauce",
		"Dahl (Masoory split dahl)", "Dahl  (Chana Dahl)", "blachan[Taho]", "Pu Erh (Tea bags) (100 x 2g)",
		"Green Tea (50 x 2g)", "3 mix cargo Rice", "Sesame Oil", "Tau Kwa (Tofu)", "Squid Ring(unbreaded)",
	].map((n) => n.trim().toLowerCase()),
);

const EDIBLE = new Set([
	"[1] Meats/Dairy/Proteins", "[2] Wheat/Rice/Carbs", "[3] Fruits/Vegetables", "[4] Fats/Oil",
	"[5[ Sugar/Sweetners", "[6]Sauces / Wines /Vinegars", "[7] Teas/Coffees", "Spice",
]);

function shopsFor(category: string, name: string): string[] {
	if (category === "Suppliments" || category === "Protein Powder") return SUPPLEMENTS;
	if (category === "Cosmetics/ Tooth paste etc") return COSMETICS;
	if (category === "Household Supplies") return HOUSEHOLD;
	if (EDIBLE.has(category)) {
		return ASIAN_ROWS.has(name.trim().toLowerCase()) ? [...SUPERMARKETS, ...ASIAN] : SUPERMARKETS;
	}
	// `Filler`, and a row with no category at all — left untagged rather than guessed
	// at, and reported by name.
	return [];
}

/**
 * Notion times a request out now and then. Retagging is idempotent — the same
 * select value is written whatever the slot currently holds — so a retry is always
 * safe here, and losing the run halfway through 92 rows is not.
 */
async function updateWithRetry(page_id: string, properties: any, tries = 4): Promise<void> {
	for (let i = 1; ; i++) {
		try {
			await client.pages.update({ page_id, properties });
			return;
		} catch (e: any) {
			if (i >= tries) throw e;
			const wait = 1000 * 2 ** (i - 1);
			console.log();
			await new Promise((r) => setTimeout(r, wait));
		}
	}
}

async function allRows(): Promise<any[]> {
	const out: any[] = [];
	let cursor: string | undefined;
	do {
		const q = (await client.dataSources.query({ data_source_id: ING_DK, page_size: 100, start_cursor: cursor } as any)) as any;
		out.push(...q.results);
		cursor = q.has_more ? q.next_cursor : undefined;
	} while (cursor);
	return out;
}

async function main() {
	if (!DO_CLEAR && !DO_TAG) throw new Error("pass --clear and/or --tag");
	const schema = (await client.dataSources.retrieve({ data_source_id: ING_DK })) as any;
	const slotProps = resolveVendorSlotProps(schema.properties);
	console.log(`slots resolved: ${slotProps.map((s) => s.vendor).join(", ")}`);

	const options = vendorOptions(schema.properties, slotProps);
	if (DO_TAG) {
		const wanted = [...new Set(ALL_LISTS.flat())];
		const missing = wanted.filter((w) => !matchVendorOption(options, w));
		if (missing.length) {
			console.error(
				`\nREFUSING TO TAG. These shops are not options on the Vendor selects yet:\n  ${missing.join(", ")}\n` +
					`Live options: ${options.join(" | ")}\n` +
					`Add them in Notion first — this tool never invents a select option.`,
			);
			if (!DO_CLEAR) process.exit(2);
		}
	}

	const rows = await allRows();
	const backup: any[] = [];
	let cleared = 0, tagged = 0, skipped = 0;

	for (const row of rows) {
		const name = plain(row.properties["Name"]?.title);
		const category = row.properties["Category"]?.select?.name ?? "";
		const slots = readVendorSlots(row.properties, slotProps);
		const props: Record<string, unknown> = {};
		const notes: string[] = [];

		if (DO_CLEAR) {
			const held = slots.filter((s) => !isSlotFree(s));
			if (held.length) {
				backup.push({
					page: row.id,
					name,
					slots: held.map((s) => ({
						n: s.n,
						vendor: s.vendorName,
						price: s.priceValue,
						size: s.sizeValue,
						url: s.urlValue,
						itemName: s.itemNameValue,
					})),
				});
				for (const s of slots) {
					props[s.vendor] = { select: null };
					if (s.price) props[s.price] = { number: null };
					if (s.size) props[s.size] = { number: null };
					if (s.url) props[s.url] = { url: null };
					if (s.itemName) props[s.itemName] = { rich_text: [] };
				}
				notes.push(`cleared ${held.length} slot(s)`);
				cleared++;
			}
		}

		if (DO_TAG) {
			const shops = shopsFor(category, name);
			if (!shops.length) {
				skipped++;
				notes.push(`no shop for category ${JSON.stringify(category || "(none)")} — left untagged`);
			} else {
				shops.slice(0, slotProps.length).forEach((shop, i) => {
					const opt = matchVendorOption(options, shop);
					if (!opt) return;
					props[slotProps[i].vendor] = { select: { name: opt } };
				});
				notes.push(`tagged ${shops.slice(0, slotProps.length).join(" / ")}`);
				tagged++;
			}
		}

		if (!Object.keys(props).length) continue;
		console.log(`${WRITE ? "WRITE" : "dry  "}  ${name.slice(0, 46).padEnd(46)} ${notes.join("; ")}`);
		if (WRITE) await updateWithRetry(row.id, props as any);
	}

	if (BACKUP && backup.length) {
		writeFileSync(BACKUP, JSON.stringify(backup, null, 1), "utf8");
		console.log(`\nbacked up ${backup.length} rows → ${BACKUP}`);
	}
	console.log(`\nrows: ${rows.length}; cleared: ${cleared}; tagged: ${tagged}; left untagged: ${skipped}; write=${WRITE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
