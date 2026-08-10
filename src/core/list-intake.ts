import { Client } from "@notionhq/client";
import { INGREDIENTS_DS, ING_PROPS } from "./ingredients-schema.js";
import {
	DONT_SEARCH_TAGS,
	PARKED_TAG,
	TAGS_PROPERTY,
	multiSelectNames,
	normTag,
	queryAll,
	selectName,
	titleText,
	type UnitType,
} from "./notion.js";
import { parseName } from "./parse.js";
import { ACCEPT_THRESHOLD, REVIEW_THRESHOLD, score } from "./match.js";
import { cheapestVendorSlot, readVendorSlots, resolveVendorSlotProps } from "./vendor-slots.js";
import type { ParsedItem } from "./list-parse.js";

/**
 * Deciding what a texted grocery item IS: an ingredient the user already owns a
 * price for, a near-miss worth asking about, or something genuinely new.
 *
 * This is the half of the Telegram flow that must not guess. Everything here is
 * pure except `readIngredientRows`, so the three-way decision can be pinned by
 * tests without a Notion token.
 *
 * ⚠️ **It reads the Ingredients DB directly rather than through
 * `readGroceryTargets()`, for the same reason `vendor-scan.ts` does.** That
 * reader serves the deals pipeline and drops any row with no priced vendor slot,
 * plus the `Suppliments`/`Filler` categories — it returned 26 of 53 rows when
 * last measured. Matching a typed name against a filtered list would report
 * "new item" for things the user has had in Notion for months, and then go and
 * scrape the shops for them. What IS honoured are the two suppression tags: a row
 * the user has told us never to look at is not a match candidate either.
 */

/** One Ingredients row, reduced to what a name match and a price quote need. */
export interface IngredientRow {
	pageId: string;
	/** The row title, in the user's bracket standard. */
	name: string;
	/** The bracket standard stripped down to the searchable noun. */
	searchTerm: string;
	unitType: UnitType;
	/** Cheapest price on the row's price book, or null when it has none yet. */
	price: {
		sgd: number;
		size: number | null;
		vendor: string;
		/** SGD per kg/L, for the `Price per kg/L` column. Null when size is unknown. */
		per1000: number | null;
	} | null;
}

/** Every row worth matching against. Suppressed rows are dropped, priced or not. */
export async function readIngredientRows(client: Client): Promise<IngredientRow[]> {
	const ds = (await client.dataSources.retrieve({ data_source_id: INGREDIENTS_DS } as any)) as any;
	const slotDefs = resolveVendorSlotProps(ds.properties ?? {});
	const pages = await queryAll(client, INGREDIENTS_DS);

	const rows: IngredientRow[] = [];
	for (const page of pages) {
		const p = page.properties;
		const name = titleText(p[ING_PROPS.NAME]);
		if (!name) continue;

		// Compared through `normTag`, never with `===`: the option was once spelled
		// `Don'r Search` and a suppression tag that silently stops matching is the
		// worst kind of bug — see `notion.ts`.
		const tags = multiSelectNames(p[TAGS_PROPERTY]);
		const hasTag = (t: string) => tags.some((x) => normTag(x) === normTag(t));
		if (hasTag(PARKED_TAG) || DONT_SEARCH_TAGS.some(hasTag)) continue;

		const cheapest = cheapestVendorSlot(readVendorSlots(p, slotDefs));
		const priceSgd = cheapest?.slot.priceValue ?? null;
		const size = cheapest?.slot.sizeValue ?? null;

		rows.push({
			pageId: page.id,
			name,
			searchTerm: parseName(name).searchTerm,
			unitType: (selectName(p[ING_PROPS.UNIT_TYPE]) as UnitType) || "By Gram",
			price:
				priceSgd && priceSgd > 0
					? {
							sgd: priceSgd,
							size,
							vendor: cheapest?.slot.vendorName ?? "",
							per1000: size && size > 0 ? (priceSgd / size) * 1000 : null,
						}
					: null,
		});
	}
	return rows;
}

/** A scored candidate for a typed name. */
export interface RowMatch {
	row: IngredientRow;
	score: number;
}

/**
 * The best-scoring Ingredients row for a typed name, or null if nothing scored.
 *
 * Scored against BOTH the row's full title and its stripped search term, taking
 * whichever is higher. The two disagree usefully: someone texting "peanut butter"
 * should match `Peanut Butter Spread [Skippy] {Creamy}` on the stripped form,
 * while someone texting the brand — "skippy" — only matches on the full title.
 * Taking the max means neither spelling is punished for the other's sake.
 */
export function bestRow(query: string, rows: IngredientRow[]): RowMatch | null {
	let best: RowMatch | null = null;
	for (const row of rows) {
		const s = Math.max(score(query, row.name), score(query, row.searchTerm));
		if (!best || s > best.score) best = { row, score: s };
	}
	return best && best.score > 0 ? best : null;
}

/**
 * What to do with one typed item.
 *
 * The three bands are the matcher's own (`match.ts`), not new numbers invented
 * here — a texted name and a shop's product title are the same kind of fuzzy
 * string, and having two different confidence scales in one project is how they
 * drift apart.
 *
 *  • ≥ ACCEPT (0.70) → link it to that row, silently
 *  • ≥ REVIEW (0.45) → ask, because a wrong link points the grocery list's
 *                      `List [Ingredients]` relation at the wrong ingredient and
 *                      quotes that ingredient's price
 *  • below          → treat as new, and go looking for it in the shops
 */
export type IntakeVerdict = "linked" | "ask" | "new";

export interface IntakeDecision {
	item: ParsedItem;
	verdict: IntakeVerdict;
	/** The candidate row, for `linked` and `ask`. Null for `new`. */
	match: RowMatch | null;
}

export function decideItem(item: ParsedItem, rows: IngredientRow[]): IntakeDecision {
	const match = bestRow(item.name, rows);
	if (!match || match.score < REVIEW_THRESHOLD) return { item, verdict: "new", match: null };
	if (match.score >= ACCEPT_THRESHOLD) return { item, verdict: "linked", match };
	return { item, verdict: "ask", match };
}

export function decideList(items: ParsedItem[], rows: IngredientRow[]): IntakeDecision[] {
	return items.map((item) => decideItem(item, rows));
}

/**
 * The `Price per kg/L` string for a matched row, in the deals page's own wording.
 *
 * ⚠️ This is the price the USER already records for the ingredient, not a shop's
 * live price — the grocery list's own column means "what this works out at per
 * kilo", and for a texted item the only figure we have is the price book's. A
 * `By Unit` row has no per-kg figure to give and correctly returns undefined
 * rather than a fabricated one.
 */
export function pricePerKgLabelFor(row: IngredientRow): string | undefined {
	if (!row.price?.per1000) return undefined;
	const unit = row.unitType === "By ml" ? "L" : "kg";
	return `$${row.price.per1000.toFixed(2)}/${unit}`;
}
