import { pricePerKgLabelFor, rankRows, type IngredientRow, type RowMatch } from "./list-intake.js";
import { splitLines } from "./list-parse.js";
import { ACCEPT_THRESHOLD } from "./match.js";
import { escapeHtml as esc } from "./telegram.js";

/**
 * **Look an item up without buying it.** `/search chicken breast` answers with
 * what that ingredient costs on the price book — name, price, size, price per
 * kg, and which vendor is cheapest — and never writes anything.
 *
 * ⚠️ **This exists because plain text already means something else.** Anything
 * typed into this bot without a slash is a shopping list: it gets matched,
 * written to the grocery List, and anything unrecognised gets priced at the
 * shops. So "what does chicken cost?" could not be asked at all — asking it
 * added it. The slash is what separates a question from an instruction, which is
 * why search is a command and the list is not.
 *
 * Three rules shape everything below:
 *
 *  • **One message, always.** The user asked for the whole answer as a single
 *    text. Several queries in one message therefore share one reply, and the
 *    length cap is enforced by dropping results with a note (`clip`) rather than
 *    by sending a second message.
 *  • **Exact or similar, said out loud.** A query that lands on real matches
 *    gets them; a query that lands on nothing good gets the closest rows
 *    *labelled as such*. Presenting a 0.35 match in the same voice as a 0.95 one
 *    is how a user ends up believing they stock something they don't.
 *  • **Nothing here spends money or writes.** It reads the Ingredients rows the
 *    inbox has already loaded. No shop scan, no model call, no Notion write —
 *    the same rule the texted list follows (see the header of `tg-inbox.ts`).
 */

/** The command words that open a search. `/s` is the one-thumb form. */
const SEARCH_RE = /^\/(?:search|find|price|s)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

/**
 * The query text of a `/search …`, `""` for a bare command, or null when the
 * message is not a search at all.
 *
 * ⚠️ Empty string and null are different answers and the caller must keep them
 * apart: `""` means "the user asked to search and said nothing" — which deserves
 * the usage hint — while `null` means "this is a shopping list", which must fall
 * through to the intake untouched.
 */
export function searchQuery(text: string): string | null {
	const m = text.trim().match(SEARCH_RE);
	if (!m) return null;
	return (m[1] ?? "").trim();
}

/**
 * At or above this, a row is reported as a match rather than as a guess.
 *
 * The intake's own ACCEPT bar, deliberately — a search that called a row "exact"
 * at a score the list flow would have asked a question about would be teaching
 * the user two different meanings of the same number.
 */
export const EXACT_SCORE = ACCEPT_THRESHOLD;

/**
 * The floor for "closest thing I have".
 *
 * ⚠️ **Lower than the intake's REVIEW bar (0.45), and that is the point.** That
 * threshold guards a *write* — a wrong link points the grocery list at the wrong
 * ingredient and quotes its price. This guards a line of text the user reads and
 * discards. The costs are not comparable, so the bars should not be either: a
 * vague query deserves the long shot, clearly labelled as one.
 */
export const SIMILAR_FLOOR = 0.3;

/** Rows shown per query. Enough to choose between, short enough to read on a phone. */
export const MAX_HITS = 6;

/** Queries answered in one message. Beyond this the reply stops being readable. */
export const MAX_QUERIES = 10;

/** Telegram's hard cap on one message, in characters. */
const TELEGRAM_MAX_CHARS = 4096;

export interface SearchResult {
	/** The line the user typed, echoed back as the block's heading. */
	query: string;
	/**
	 * `exact` — at least one row cleared `EXACT_SCORE`.
	 * `similar` — nothing did, but something cleared `SIMILAR_FLOOR`.
	 * `none` — nothing scored at all.
	 */
	kind: "exact" | "similar" | "none";
	hits: RowMatch[];
}

/** Split a search argument into queries, the same way a texted list is split. */
export function searchTerms(arg: string): string[] {
	return splitLines(arg).slice(0, MAX_QUERIES);
}

/**
 * Rank the Ingredients rows for one query.
 *
 * ⚠️ **The query goes in raw, quantities and all.** `parseList` is NOT used here
 * even though the intake uses it, because it is not needed: `tokens()` already
 * drops anything starting with a digit, so `2kg chicken breast` scores exactly as
 * `chicken breast` does. Running it through the quantity grammar would only add a
 * way to be wrong — a trailing bare integer is stripped as a count, which turns
 * `omega 3` into `omega` for no gain.
 */
export function searchRows(query: string, rows: IngredientRow[]): SearchResult {
	const ranked = rankRows(query, rows);
	const exact = ranked.filter((m) => m.score >= EXACT_SCORE);
	if (exact.length) return { query, kind: "exact", hits: exact.slice(0, MAX_HITS) };
	const similar = ranked.filter((m) => m.score >= SIMILAR_FLOOR);
	if (similar.length) return { query, kind: "similar", hits: similar.slice(0, MAX_HITS) };
	return { query, kind: "none", hits: [] };
}

export function searchAll(queries: string[], rows: IngredientRow[]): SearchResult[] {
	return queries.map((q) => searchRows(q, rows));
}

/**
 * The pack size, in the unit the row is actually counted in.
 *
 * ⚠️ **`Size[Vendor n]` holds grams, millilitres OR a piece count**, decided by
 * `Unit type ` — the same trap that once printed `$399.00/kg` for a box of eggs
 * (see `pricePerKgLabelFor`). Labelling a count of 10 as "10g" is the same
 * mistake wearing smaller consequences, so the unit is read off the row, never
 * assumed.
 */
export function sizeText(row: IngredientRow): string | null {
	const size = row.price?.size;
	if (typeof size !== "number" || !(size > 0)) return null;
	if (row.unitType === "By Unit") return `${+size.toFixed(2)} pc`;
	const volumetric = row.unitType === "By ml";
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return size >= 1000 ? `${+(size / 1000).toFixed(2)}${big}` : `${+size.toFixed(2)}${small}`;
}

/**
 * One row as a line: name, price, size, price/kg, vendor — the four figures the
 * user asked for, in that order, on the cheapest slot the price book holds.
 *
 * A row with nothing on its price book still gets a line. It is a real answer —
 * "you have this ingredient, you have never recorded what it costs" — and
 * dropping it would make the same query look like it found less than it did.
 */
export function hitLine(m: RowMatch): string {
	const row = m.row;
	// 💤 is the project's mark for `Not in Use ATM`, the same as on the intake's
	// keyboard. Worth carrying here: a price you snoozed is still a price, but the
	// user should not be surprised when it doesn't turn up in a deal.
	const snooze = row.parked ? "💤 " : "";
	const name = `${snooze}<b>${esc(row.name)}</b>`;
	if (!row.price) return `• ${name} — <i>no price recorded yet</i>`;

	const parts = [`$${row.price.sgd.toFixed(2)}`];
	const size = sizeText(row);
	if (size) parts.push(size);
	const perKg = pricePerKgLabelFor(row);
	if (perKg) parts.push(`<b>${perKg}</b>`);
	// The vendor last, because it is the answer to "and where" — the figures are
	// what the eye is scanning for.
	if (row.price.vendor) parts.push(esc(row.price.vendor));
	return `• ${name} — ${parts.join(" · ")}`;
}

/** One query's heading plus its lines. */
export function resultBlock(r: SearchResult): string {
	const head = `🔎 <b>${esc(r.query)}</b>`;
	if (r.kind === "none") return `${head} — <i>nothing in your Ingredients matches.</i>`;
	// ⚠️ The "closest" wording is not decoration. These rows are below the bar the
	// intake would link on, and a list of near-misses printed in the same voice as
	// a hit is how someone concludes they already stock harissa paste.
	const note = r.kind === "similar" ? " — <i>no exact match; closest:</i>" : "";
	return `${head}${note}\n${r.hits.map(hitLine).join("\n")}`;
}

/**
 * Trim to Telegram's limit by dropping whole blocks from the end.
 *
 * ⚠️ **Dropping, not splitting.** The user asked for the answer as one text, so
 * the cap has to be paid in results rather than in messages — and paid *visibly*,
 * because a reply that silently stops after four of nine queries is
 * indistinguishable from one that only found four.
 */
function clip(blocks: string[]): string {
	const kept: string[] = [];
	let used = 0;
	for (const b of blocks) {
		const cost = used ? b.length + 2 : b.length;
		// Leave room for the note about what was dropped.
		if (used + cost > TELEGRAM_MAX_CHARS - 80) break;
		kept.push(b);
		used += cost;
	}
	const dropped = blocks.length - kept.length;
	if (!dropped) return kept.join("\n\n");
	return `${kept.join("\n\n")}\n\n<i>…${dropped} more ${dropped === 1 ? "query" : "queries"} didn't fit in one message.</i>`;
}

/** The whole reply: every query's block, in the order they were typed. */
export function formatSearch(results: SearchResult[], totalTerms = results.length): string {
	if (!results.length) return SEARCH_HELP;
	const blocks = results.map(resultBlock);
	if (totalTerms > results.length) {
		const over = totalTerms - results.length;
		blocks.push(`<i>…and ${over} more item${over === 1 ? "" : "s"} — I answer ${MAX_QUERIES} at a time.</i>`);
	}
	return clip(blocks);
}

export const SEARCH_HELP =
	"🔎 <b>What do you want the price of?</b>\n" +
	"<code>/search chicken breast</code>\n" +
	"Several at once — one per line, or comma-separated:\n" +
	"<code>/search milk, eggs, peanut butter</code>\n\n" +
	"I'll show the name, price, size and price/kg of the cheapest vendor on each " +
	"row's price book. Searching never adds anything to your list.";
