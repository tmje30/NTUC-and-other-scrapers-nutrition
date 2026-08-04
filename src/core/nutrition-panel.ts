import type { Macros } from "./macro-prompt.js";

/**
 * Read a shop's own nutrition panel and convert it to per-100g.
 *
 * **Why this exists: sometimes the panel is right there, free.** Measured on
 * 2026-08-03 across 16 FairPrice products (slug-anchored — see the warning
 * below), **4 carried a usable `Nutritional Data` table**: a small HTML table
 * straight off the packaging. That is a better source than anything a model can
 * infer *and* it costs nothing, so it is tried first and the paid lookup
 * (`macro-prompt.ts`) is the fallback for the other three quarters.
 *
 * The split is not random, and it is the useful part: the hits were packaged
 * goods (oats, yoghurt, instant noodles, canned tuna). Every fresh item missed —
 * chicken breast, salmon, broccoli, bananas, eggs, tofu. So the free path covers
 * the packet foods and the paid lookup covers exactly the produce and raw meat
 * where the raw-vs-cooked rule matters most. They cover for each other.
 *
 * ⚠️ **Do not "improve" this by searching the page for a nutrition table.** An
 * earlier measurement did, reported 4 of 5, and was wrong: on the Skippy Peanut
 * Butter page the product's own object has NO panel while the recommendations
 * carousel carries four — for FairPrice Peanut Butter, Golden Light and others.
 * A first-match search returns a *rival product's* label as this one's, which
 * looks perfectly plausible and is silently wrong. The caller must hand this
 * function the panel off the slug-anchored product object and nothing else.
 *
 * Deterministic on purpose. This is the same house rule as `generic-name.ts` and
 * `parse.ts`: if the answer can be read off the page by code, no model is
 * involved. It also keeps this file free of Node imports so the extension can
 * bundle it.
 *
 * ⚠️ **Every panel measured was PER SERVING, not per 100g** — servings of 32 g,
 * 35 g, 236 ml and 100 g. So the scaling below is not a nicety; without it the
 * figures are wrong by a factor of three on a 32 g peanut-butter serving, and
 * wrong in the direction that looks plausible. This is the same per-serving trap
 * the model prompt guards against, arriving down a different road.
 */

export interface PanelMacros extends Macros {
	/** Grams (or ml) the source column was measured over. 100 means no scaling. */
	servingG: number;
	/** Human note for the panel — "per serving (35 g), scaled to 100 g". */
	basis: string;
}

/** `<table>` → rows of trimmed cell text. Tolerates the `<th>`/`<td>` mix these panels use. */
function tableRows(html: string): string[][] {
	const rows: string[][] = [];
	for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
		const cells = (tr.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) ?? []).map((c) =>
			c
				.replace(/<[^>]+>/g, "")
				.replace(/&nbsp;/gi, " ")
				.replace(/&amp;/gi, "&")
				.replace(/\s+/g, " ")
				.trim(),
		);
		if (cells.length) rows.push(cells);
	}
	return rows;
}

/**
 * Strip a label down to something matchable.
 *
 * The leading dash matters: Skippy writes "- Saturated Fat" and "- Trans Fat" as
 * indented sub-rows of Total Fat. Removing the dash lets the EXACT match below
 * reject them cleanly, where a substring test for "fat" would have taken
 * whichever came first.
 */
const label = (s: string) =>
	s
		.toLowerCase()
		.replace(/^[\s\-–—•*]+/, "")
		.replace(/[.:*]+$/, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * A cell like "7.1g", "4 g", "0.0g", "96mg", "200kcal*" → grams.
 *
 * Returns null for anything that isn't a mass, which is how energy rows (kcal,
 * kJ) are ignored without having to name them. `mg` is divided down because some
 * panels report a macro in milligrams even though most use grams.
 */
function grams(cell: string): number | null {
	const m = cell.replace(/,/g, "").match(/(-?\d*\.?\d+)\s*(m?g|mcg|µg)?\b/i);
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	if (!Number.isFinite(n) || n < 0) return null;
	const unit = (m[2] ?? "g").toLowerCase();
	if (unit === "mg") return n / 1000;
	if (unit === "mcg" || unit === "µg") return n / 1_000_000;
	if (unit !== "g") return null; // kcal / kJ / % and friends
	return n;
}

/**
 * Exact label sets, not substrings — the whole reason sub-rows don't poison this.
 *
 * `fat` deliberately excludes saturated, trans, unsaturated and polyunsaturated:
 * those are components OF total fat, and adding them in would double-count.
 * `carbs` excludes sugars for the same reason.
 */
const MATCHERS: Record<keyof Macros, (l: string) => boolean> = {
	proteinPer100g: (l) => l === "protein" || l === "proteins",
	fatsPer100g: (l) => l === "total fat" || l === "fat" || l === "total fats" || l === "fat, total",
	carbsPer100g: (l) =>
		l === "carbohydrate" ||
		l === "carbohydrates" ||
		l === "total carbohydrate" ||
		l === "total carbohydrates" ||
		l === "carbohydrate, total" ||
		l === "available carbohydrate",
	fiberPer100g: (l) =>
		l === "dietary fibre" || l === "dietary fiber" || l === "fibre" || l === "fiber" || l === "total dietary fibre",
};

/** "Per Serving (35g)" / "Per 100 g" / "Per 100ml" → the grams that column covers. */
function servingOf(headerCell: string): number | null {
	const h = headerCell.toLowerCase();
	// A "per 100 g" column needs no scaling at all.
	if (/per\s*100\s*(g|gm|gram|ml)?\b/.test(h)) return 100;
	// "(35g)" / "(236ml)" / "(1.5 kg)"
	const m = h.match(/\(?\s*(\d*\.?\d+)\s*(kg|g|gm|gram|grams|ml|l|litre|liter)\s*\)?/);
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = m[2];
	// ml is treated as g throughout this project (see ingredient-write.ts) — close
	// enough for milk and juice, and the alternative is refusing to read a panel.
	if (unit === "kg" || unit === "l" || unit === "litre" || unit === "liter") return n * 1000;
	return n;
}

/**
 * Panel HTML → the four figures per 100g, or null when it can't be trusted.
 *
 * Null rather than a guess whenever: there is no table, no column whose serving
 * size is stated, or nothing matched. A blank set of boxes sends the user to the
 * paid lookup, which is a good outcome; wrong numbers in the boxes are not.
 */
export function parseNutritionPanel(html: string): PanelMacros | null {
	if (!html || !/<tr/i.test(html)) return null;
	const rows = tableRows(html);
	if (rows.length < 2) return null;

	const header = rows[0];
	// Prefer a per-100g column when the panel offers both — no scaling, no rounding
	// drift. Otherwise fall back to the first value column and scale it.
	let col = -1;
	let serving: number | null = null;
	for (let i = 1; i < header.length; i++) {
		const s = servingOf(header[i]);
		if (s === 100) { col = i; serving = 100; break; }
		if (s != null && col === -1) { col = i; serving = s; }
	}
	// Some panels put the serving in the FIRST header cell ("Per Serving (35g)" as
	// the row-label heading) — accept that too rather than giving up.
	if (col === -1 && header.length >= 2) {
		const s = servingOf(header[0]);
		if (s != null) { col = 1; serving = s; }
	}
	if (col === -1 || serving == null || serving <= 0) return null;

	const out: Macros = {
		proteinPer100g: null,
		fatsPer100g: null,
		carbsPer100g: null,
		fiberPer100g: null,
	};

	for (const row of rows.slice(1)) {
		const l = label(row[0] ?? "");
		const cell = row[col];
		if (!l || cell == null) continue;
		for (const key of Object.keys(MATCHERS) as (keyof Macros)[]) {
			// First match wins: panels sometimes repeat a row (the Meiji table lists
			// Potassium twice), and the first is the one alongside its own heading.
			if (out[key] != null || !MATCHERS[key](l)) continue;
			const g = grams(cell);
			if (g == null) continue;
			const per100 = (g * 100) / serving;
			// Same gate as the model path: nothing in 100 g of food exceeds 100 g.
			out[key] = per100 > 100 ? null : Math.round(per100 * 100) / 100;
		}
	}

	if (Object.values(out).every((v) => v == null)) return null;
	// Protein + fat + carbs cannot exceed 100 g per 100 g. Catches a misread
	// serving size, which is the failure that would otherwise look plausible.
	const total = (out.proteinPer100g ?? 0) + (out.fatsPer100g ?? 0) + (out.carbsPer100g ?? 0);
	if (total > 105) return null;

	return {
		...out,
		servingG: serving,
		basis:
			serving === 100
				? "from the shop's own per-100g panel"
				: `from the shop's own panel (per ${serving} g serving, scaled to 100 g)`,
	};
}
