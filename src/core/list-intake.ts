import { Client } from "@notionhq/client";
import { INGREDIENTS_DS, ING_PROPS } from "./ingredients-schema.js";
import {
	DONT_SEARCH_TAGS,
	PARKED_TAG,
	TAGS_PROPERTY,
	multiSelectNames,
	isByWeight,
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
	/**
	 * Tagged `Not in Use ATM` — offered, but never linked without asking.
	 *
	 * ⚠️ **`Don't Search` rows are a different thing and are still dropped
	 * entirely.** The two tags look alike and are not: one is this tool's own
	 * reversible snooze, the other is the user's permanent instruction, and
	 * nothing in this repo may write, clear, or offer a button that undoes it.
	 */
	parked: boolean;
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
		// ⚠️ `Don't Search` still drops the row outright. `Not in Use ATM` no longer
		// does: texting an item is an explicit "I am buying this" and outranks a
		// snooze set weeks ago (the user's call, 2026-08-11, after texting
		// "milk, skimmed" and being offered two milks that were not it). The row is
		// flagged instead, offered with a 💤, and un-parked only on a deliberate tap.
		if (DONT_SEARCH_TAGS.some(hasTag)) continue;

		const cheapest = cheapestVendorSlot(readVendorSlots(p, slotDefs));
		const priceSgd = cheapest?.slot.priceValue ?? null;
		const size = cheapest?.slot.sizeValue ?? null;
		const unitType = (selectName(p[ING_PROPS.UNIT_TYPE]) as UnitType) || "By Gram";

		rows.push({
			pageId: page.id,
			name,
			searchTerm: parseName(name).searchTerm,
			unitType,
			parked: hasTag(PARKED_TAG),
			price:
				priceSgd && priceSgd > 0
					? {
							sgd: priceSgd,
							size,
							vendor: cheapest?.slot.vendorName ?? "",
							// ⚠️ **A piece count is not a weight.** `Size[Vendor n]` holds
							// whatever `Unit type ` says it holds, so on a By-Unit row it is
							// a number of eggs, not grams — and dividing by it produced
							// "$399.00/kg" on a $3.99 box of ten, written to the live
							// grocery list on 2026-08-10 and only caught by reading the rows
							// back. It looks like a price and is off by a factor of a
							// hundred-odd, which is the worst kind of wrong: nothing is
							// missing, so nothing prompts you to check.
							per1000: isByWeight(unitType) && size && size > 0 ? (priceSgd / size) * 1000 : null,
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
	return rankRows(query, rows)[0] ?? null;
}

/**
 * Every row that scored at all, best first.
 *
 * ⚠️ **`bestRow` returning one row is what fault 28 was.** It kept the FIRST row
 * on a tie, so texting `1 x milk` linked silently to `Milk (Low Fat)` purely
 * because Notion returned it before `Milk ( Normal)` — both scored **1.000**.
 * Reorder the query and the same text files against the other one. The rule asked
 * "is the best match good enough?" when the question that decides whether to ask
 * is "**is there only one?**", and those two come apart precisely on the short
 * generic words people actually text: milk, eggs, chicken, bread.
 *
 * Lowering `ACCEPT` would not have helped — 1.000 beats every threshold — and
 * would have made each confident single match nag.
 *
 * Ties are broken by name so the order is stable between runs: the ask below is
 * built from this list, and a set of buttons that reshuffles between two
 * identical questions is its own small betrayal.
 */
export function rankRows(query: string, rows: IngredientRow[]): RowMatch[] {
	return rows
		.map((row) => ({ row, score: Math.max(score(query, row.name), score(query, row.searchTerm)) }))
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
}

/**
 * How close a runner-up has to be to the leader to be offered alongside it.
 *
 * A tie is the case this was written for and 0 would cover it. The margin is
 * wider than that because the near-ties are just as wrong and just as invisible:
 * `chicken` scores 0.850 on `Chicken thigh, Boneless [Seara]` and 0.800 on
 * `chicken soup cube` — two different foods, one confident-looking answer.
 *
 * ⚠️ Widen this and every confident match starts asking, which trains the user to
 * tap the first button without reading. That is worse than the bug.
 */
export const CANDIDATE_MARGIN = 0.05;

/** At most this many rows are offered at once — a keyboard, not a catalogue. */
export const MAX_CANDIDATES = 4;

/**
 * The rows worth putting in front of the user for one query: the leader, plus
 * anyone within `CANDIDATE_MARGIN` of it that also clears the review bar.
 */
export function candidatesFor(query: string, rows: IngredientRow[], exclude: string[] = []): RowMatch[] {
	const skip = new Set(exclude);
	const ranked = rankRows(query, rows).filter((m) => !skip.has(m.row.pageId));
	const top = ranked[0];
	if (!top || top.score < REVIEW_THRESHOLD) return [];
	return ranked
		.filter((m) => m.score >= REVIEW_THRESHOLD && top.score - m.score <= CANDIDATE_MARGIN)
		.slice(0, MAX_CANDIDATES);
}

/**
 * The next rows to offer after the user has rejected some — the **re-search**
 * button (fault 30). "A different ingredient that is similar", in the user's own
 * words: it looks again at the Ingredients DB, not at the shops.
 *
 * ⚠️ **The review bar is deliberately NOT applied here.** Being asked at all
 * means the confident answers have already been rejected, so the honest next
 * offer is whatever is left in order, however faint — the alternative is
 * answering "nothing else looks close" while a perfectly good row sits at 0.44.
 */
export function nextCandidates(query: string, rows: IngredientRow[], exclude: string[]): RowMatch[] {
	const skip = new Set(exclude);
	return rankRows(query, rows)
		.filter((m) => !skip.has(m.row.pageId))
		.slice(0, MAX_CANDIDATES);
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
	/** The leading row, for `linked` and `ask`. Null for `new`. */
	match: RowMatch | null;
	/**
	 * Every row worth offering, best first — one button each. Holds a single entry
	 * for a `linked` item, two or more for the tie that made `ask` necessary, and
	 * nothing for `new`.
	 */
	candidates: RowMatch[];
}

/**
 * ⚠️ **A confident match is only linked silently when it is ALONE.** Two rows
 * within `CANDIDATE_MARGIN` of each other are asked about even at 1.000, because
 * "good enough" and "the only one" are different questions — see `rankRows`.
 *
 * ⚠️ **A PARKED row is never linked silently either, however well it scores.**
 * Picking one un-parks it — a write to a tag the user set by hand — and that has
 * to be a deliberate tap, not a side effect of a confident match.
 */
export function decideItem(item: ParsedItem, rows: IngredientRow[]): IntakeDecision {
	const candidates = candidatesFor(item.name, rows);
	const match = candidates[0] ?? null;
	if (!match) return { item, verdict: "new", match: null, candidates: [] };
	if (match.score >= ACCEPT_THRESHOLD && candidates.length === 1 && !match.row.parked) {
		return { item, verdict: "linked", match, candidates };
	}
	return { item, verdict: "ask", match, candidates };
}

export function decideList(items: ParsedItem[], rows: IngredientRow[]): IntakeDecision[] {
	return items.map((item) => decideItem(item, rows));
}

/**
 * The `Price per kg/L` string for a matched row, in the deals page's own wording.
 *
 * ⚠️ This is the price the USER already records for the ingredient, not a shop's
 * live price — the grocery list's own column means "what this works out at per
 * kilo", and for a texted item the only figure we have is the price book's.
 *
 * ⚠️ **A `By Unit` row has no per-kg figure to give, and this used to fabricate
 * one.** The guard was the falsy check below, and the header of this function
 * claimed the behaviour that `per1000` did not implement: a piece count went in
 * as if it were grams, so a $3.99 box of ten eggs was filed as **$399.00/kg**.
 * The refusal now lives at the source (`readIngredientRows` leaves `per1000`
 * null for counted rows) so the two cannot disagree again.
 */
export function pricePerKgLabelFor(row: IngredientRow): string | undefined {
	if (!isByWeight(row.unitType) || !row.price?.per1000) return undefined;
	const unit = row.unitType === "By ml" ? "L" : "kg";
	return `$${row.price.per1000.toFixed(2)}/${unit}`;
}
