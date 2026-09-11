import type { Client } from "@notionhq/client";
import { GROCERY_LIST_DS, resolveListProps, type ListProps } from "./grocery-list.js";

/**
 * **`list.html` — the shopping page.** Your Notion grocery List, as something you can
 * hold in one hand in a shop.
 *
 * ```
 *   ☐  2 ×  Carrots, Normal (1kg)        $0.95 / $1.60 - Sheng Siong   −41%
 *   ──────────────────────────────────────────────────────────────────────
 *   Total cost                                                     $18.40
 *   Total cost with %                                              $13.72
 * ```
 *
 * ⚠️ **Every column here already exists in Notion and NONE are created.** `Price D%/C`
 * is the user's own formula and is rendered verbatim; the numbers behind the totals are
 * parsed out of `Price , To Buy ` and the `Current Price ` formula. Nothing in this file
 * writes a schema — see `CLAUDE.md`.
 *
 * ⚠️ **The page is static and holds no credentials.** Ticking a box and editing an amount
 * fire `repository_dispatch: list-action` from the browser, using the same fine-grained
 * PAT the deals page already stores under `grocery-add-pat`. Same origin, same key:
 * enabling one-tap on the deals page enables it here too. With no token the controls are
 * disabled and say so, rather than silently doing nothing — unlike the deals page there
 * is no pre-filled-issue floor underneath, because a list you tick twenty times is not a
 * list you want to file twenty GitHub issues for.
 *
 * ⚠️ **Ticking does not wait for a rebuild.** The row leaves the page immediately and the
 * totals recompute in the browser. The page itself is only rewritten by the daily build,
 * so what you see after a tap is the browser's arithmetic, not Notion's, and the two
 * reconcile the next morning. Rebuilding the site on every tick would mean a Pages deploy
 * per checkbox.
 */

/** One row of the grocery List, reduced to what the page shows and totals. */
export interface ListRow {
	pageId: string;
	name: string;
	/** `Amount ` — how many to buy. Absent reads as 1, which is what a bare line means. */
	amount: number;
	/** `Price , To Buy ` — the discounted price of one, when there is a discount. */
	buyPrice: number | null;
	/** Parsed out of the `Current Price ` formula: the price you normally pay. */
	currentPrice: number | null;
	/** The shop named by that same formula — where the normal price is. */
	currentVendor: string | null;
	/** `Vendor %` — the shop the DISCOUNT is at. The "location" a deal is shown with. */
	dealVendor: string | null;
	/** `Price D%/C`, verbatim — kept as the source the per-unit figures are read out of. */
	priceDC: string;
	/** `Price per kg/L`, verbatim — the DISCOUNT's own per-unit figure, e.g. `"$25.00/kg"`. */
	perKg: string | null;
	/**
	 * The REGULAR price's per-unit figure, e.g. `"2.82 /10 pc"`.
	 *
	 * ⚠️ **Read out of the `Price D%/C` formula's second line, because there is nowhere
	 * else it exists.** `Price per kg/L` holds the discount's figure only; the regular
	 * one is computed inside the user's own formula and never lands in a column of its
	 * own. See `parsePerUnitLine` for how tolerant that read has to be.
	 */
	currentPerUnit: string | null;
	dealUrl: string | null;
	currentUrl: string | null;
	ticked: boolean;
}

/**
 * The four columns `resolveListProps` does not resolve, found the same way it finds the
 * rest: by TYPE and a keyword in the name, never by a hardcoded string.
 *
 * ⚠️ **Three of these are formulas, which is exactly why they are here and not there.**
 * `resolveListProps` picks `currentPrice` out of the *number* columns, and `Current
 * Price ` became a formula in 2026-08 — so it resolves to null there, and is documented
 * as doing so (`computedColumnFor`). A formula is unwritable but perfectly readable, and
 * this page only ever reads them.
 */
export interface ExtraListProps {
	/** `Price D%/C` — formula. */
	priceDC: string | null;
	/** `Current Price ` — formula, e.g. `"$3.38 - NTUC"`. */
	currentPriceFormula: string | null;
	/** `URL - discount/Cheap ` */
	dealUrl: string | null;
	/** `URL - Current ` */
	currentUrl: string | null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function resolveExtraProps(schema: Record<string, { type: string }>): ExtraListProps {
	const of = (t: string) =>
		Object.entries(schema)
			.filter(([, d]) => d.type === t)
			.map(([n]) => n);
	const pick = (names: string[], has: (n: string) => boolean) => names.find((n) => has(norm(n))) ?? null;
	const formulas = of("formula");
	const urls = of("url");
	return {
		// "d%" is the distinctive half. `Item Name ` and `Home/Office` are formulas too,
		// so matching on "price" alone would be a coin toss between this and Current Price.
		priceDC: pick(formulas, (n) => n.includes("d%") || (n.includes("price") && n.includes("/c"))),
		currentPriceFormula: pick(formulas, (n) => n.includes("current") && n.includes("price")),
		dealUrl: pick(urls, (n) => n.includes("discount") || n.includes("cheap")),
		currentUrl: pick(urls, (n) => n.includes("current")),
	};
}

const plain = (rich: any[] | undefined): string => (rich ?? []).map((r: any) => r.plain_text).join("");

/** A formula cell's text, whatever flavour of formula it is. Numbers included. */
function formulaText(prop: any): string {
	const f = prop?.formula;
	if (!f) return "";
	if (f.type === "string") return f.string ?? "";
	if (f.type === "number") return f.number == null ? "" : String(f.number);
	return "";
}

/**
 * Pull the price and the shop out of a `Current Price ` cell — `"$3.38 - NTUC"`.
 *
 * ⚠️ **Tolerant on purpose: this is a user-authored formula and its wording is theirs to
 * change.** A cell that does not parse yields nulls, and the row simply carries no
 * baseline price — which costs one line of a total. Throwing here would cost the page.
 */
export function parseCurrentPrice(text: string): { price: number | null; vendor: string | null } {
	const t = (text ?? "").trim();
	if (!t || t === "-") return { price: null, vendor: null };
	const money = t.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	// Everything after the first " - " is the shop. Not split on "-" alone: a shop could
	// be hyphenated, and the separator in this formula is a spaced dash.
	const dash = t.match(/\s-\s+(.+)$/);
	const vendor = dash?.[1]?.trim() || null;
	return { price: money ? Number(money[1]) : null, vendor: vendor && vendor !== "-" ? vendor : null };
}

/**
 * Pull the two per-unit figures out of the second line of `Price D%/C`:
 *
 *     "$25.00/kg / 2.82 /10 pc - NTUC"
 *      └ discount ┘ └ regular ┘ └shop┘
 *
 * ⚠️ **Split on `" / "` — space, slash, space — and nothing looser.** A per-unit figure
 * contains a slash of its own (`$25.00/kg`, `2.82 /10 pc`), so splitting on `/` alone
 * shreds both halves. The spaced slash is the separator the user's formula actually uses.
 *
 * ⚠️ **Every failure yields nulls rather than a guess.** This is a user-authored formula
 * and its wording is theirs to change; a line that does not parse costs one grey figure on
 * one row, while throwing would cost the page.
 */
export function parsePerUnitLine(priceDC: string): { discount: string | null; current: string | null } {
	const line = (priceDC ?? "").split("\n")[1];
	if (!line) return { discount: null, current: null };
	const parts = line.split(" / ");
	if (parts.length < 2) return { discount: null, current: null };
	// The shop is appended to the last segment only; strip it back off.
	const clean = (s: string): string | null => {
		const v = s.replace(/\s-\s+[^/]*$/, "").trim();
		return v && v !== "-" ? v : null;
	};
	return { discount: clean(parts[0]), current: clean(parts.slice(1).join(" / ")) };
}

/** Read the whole grocery List. Paginated: the list is small, but "small" is not a guarantee. */
export async function readGroceryList(client: Client): Promise<ListRow[]> {
	const ds = (await client.dataSources.retrieve({ data_source_id: GROCERY_LIST_DS })) as any;
	const schema = (ds.properties ?? {}) as Record<string, { type: string }>;
	const props: ListProps = resolveListProps(schema);
	const extra = resolveExtraProps(schema);

	const rows: ListRow[] = [];
	let cursor: string | undefined;
	do {
		const res = (await client.dataSources.query({
			data_source_id: GROCERY_LIST_DS,
			page_size: 100,
			start_cursor: cursor,
		} as any)) as any;
		for (const page of res.results as any[]) {
			const p = page.properties ?? {};
			const get = (name: string | null) => (name ? p[name] : undefined);
			const current = parseCurrentPrice(formulaText(get(extra.currentPriceFormula)));
			const buy = get(props.price)?.number;
			const amount = get(props.amount)?.number;
			const priceDC = formulaText(get(extra.priceDC)).trim();
			const perUnit = parsePerUnitLine(priceDC);
			rows.push({
				pageId: page.id,
				name: plain(get(props.title)?.title).trim(),
				// A row with no Amount is one of the thing — that is what writing a bare
				// line on a shopping list means, and 0 would silently zero its share of
				// the total.
				amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
				buyPrice: Number.isFinite(buy) && buy > 0 ? buy : null,
				currentPrice: current.price,
				currentVendor: current.vendor,
				dealVendor: plain(get(props.vendor)?.rich_text).trim() || null,
				priceDC,
				// `Price per kg/L` is the discount's figure and is preferred when present;
				// the formula's own first segment is the fallback for a row written before
				// that column was filled in.
				perKg: plain(get(props.pricePerKg)?.rich_text).trim() || perUnit.discount,
				currentPerUnit: perUnit.current,
				dealUrl: get(extra.dealUrl)?.url || null,
				currentUrl: get(extra.currentUrl)?.url || null,
				ticked: Boolean(get(props.done)?.checkbox),
			});
		}
		cursor = res.has_more ? res.next_cursor : undefined;
	} while (cursor);
	return rows;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface ListTotals {
	/** What the list costs at the price you normally pay. */
	full: number;
	/** The same list, taking every discount that exists. */
	discounted: number;
	/** Rows with no price at all — counted here so a total can admit what it left out. */
	unpriced: number;
}

/**
 * ⚠️ **A row with no discount still counts towards BOTH totals, at its full price.**
 * "Total cost with %" is what this shop actually costs you today, not the sum of the
 * discounted rows — leaving the undiscounted ones out would make the second figure
 * smaller than the shopping, which is the one thing a shopping total must not be.
 *
 * ⚠️ **A row with no price at all counts towards NEITHER, and is reported.** Texting
 * "bananas" files a row with no price (see `tg-sweep`), so an unpriced row is normal
 * rather than broken — but a total that quietly treated it as $0 would be a number you
 * could not shop against.
 */
export function totals(rows: ListRow[]): ListTotals {
	let full = 0;
	let discounted = 0;
	let unpriced = 0;
	for (const r of rows) {
		const base = r.currentPrice ?? r.buyPrice;
		if (base == null) {
			unpriced++;
			continue;
		}
		full += base * r.amount;
		discounted += (r.buyPrice ?? base) * r.amount;
	}
	return { full, discounted, unpriced };
}

/** How much off, as a whole percentage. Null unless there is a genuine reduction. */
export function discountPct(r: ListRow): number | null {
	if (r.buyPrice == null || r.currentPrice == null || r.currentPrice <= 0) return null;
	const pct = Math.round((1 - r.buyPrice / r.currentPrice) * 100);
	return pct > 0 ? pct : null;
}

