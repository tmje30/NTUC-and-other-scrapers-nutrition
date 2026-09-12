import type { IngredientRow } from "./list-intake.js";

/**
 * **`ingredients.json` — what the shopping page's Add box searches.**
 *
 * The page is static, so typing into Add cannot query Notion. Instead the daily build
 * publishes the ingredient list beside the page and the box filters it in the browser:
 * no network per keystroke, instant results, and the whole thing works on a phone with
 * one bar of signal in a supermarket basement.
 *
 * ⚠️ **This file is PUBLIC, like every other file the site publishes.** It carries
 * ingredient names, their cheapest recorded price, pack size and which shop — the same
 * class of thing `targets.json` has published since the beginning, and rather less than
 * the deals page shows on its cards. It carries no Notion token and no chat content.
 * Page ids are included because Add needs one to point the row's relation at; a page id
 * is not a credential (it is useless without the integration token), which is the same
 * judgement `tg-inbox-state.json` records for committing them to a public repo.
 *
 * ⚠️ **Parked rows are included, and marked.** A `Not in Use ATM` row is one the user
 * has snoozed, not one they have retired — and deliberately typing its name into Add is
 * the clearest possible statement that they want it now. The same reasoning the Telegram
 * intake uses when it offers a parked row with a 💤 rather than hiding it.
 */

/** One searchable ingredient, trimmed to what the box shows and Add needs. */
export interface IndexedIngredient {
	/** Notion page id — what the new grocery row's relation points at. */
	id: string;
	/** The row title, in the user's bracket standard. */
	name: string;
	/** The bracket standard stripped to its searchable noun — what typing matches on. */
	term: string;
	/** Cheapest recorded price, SGD. Null on a row with no price book yet. */
	price: number | null;
	/** The shop that price came from. */
	vendor: string | null;
	/** `$4.45/kg`-style label, when the row has one. */
	perKg: string | null;
	/** Tagged `Not in Use ATM` — offered with a 💤, never hidden. */
	parked: boolean;
}

export interface IngredientIndex {
	generatedAt: string;
	items: IndexedIngredient[];
}

/**
 * ⚠️ **Sorted by name, not by relevance.** Relevance depends on what is being typed,
 * which this end cannot know; a stable alphabetical order means the file's diff is
 * readable and two builds of an unchanged list produce an identical file.
 */
export function buildIngredientIndex(
	rows: IngredientRow[],
	perKgLabel: (r: IngredientRow) => string | undefined,
	now: Date = new Date(),
): IngredientIndex {
	const items = rows
		.map((r) => ({
			id: r.pageId,
			name: r.name,
			term: r.searchTerm,
			price: r.price?.sgd ?? null,
			vendor: r.price?.vendor ?? null,
			perKg: perKgLabel(r) ?? null,
			parked: r.parked,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { generatedAt: now.toISOString(), items };
}
