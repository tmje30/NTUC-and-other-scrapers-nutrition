/**
 * Turning a texted grocery list into structured items.
 *
 * The user types a list into Telegram the way anyone types a list — one item per
 * line, or all on one line separated by commas, with quantities written in
 * whatever shape came to mind:
 *
 *     2kg chicken breast          → 1 pack of 2000 g
 *     1L milk                     → 1 pack of 1000 ml
 *     bananas x6                  → 6
 *     3 x eggs                    → 3
 *     2 x 500g peanut butter      → 2 packs of 500 g
 *     Carrots x 1kg               → 1 pack of 1000 g
 *     - rice                      → 1
 *
 * `x` is read as `*` wherever it appears, which is how people write it — including
 * the `Carrots x 1kg` form, where the number belongs to the unit and the `x` is
 * left with nothing to multiply. See `STRAY_MULT`.
 *
 * Nothing here talks to Notion, a shop or a model: it is a pure string function
 * so the whole quantity grammar can be pinned by tests that cost nothing to run.
 *
 * ⚠️ **A size and a count are different numbers and must not be conflated.**
 * `2kg chicken` is ONE thing weighing two kilos; `chicken x2` is TWO things of
 * unstated weight. They end up in different columns (`Amount ` on the grocery
 * list vs. the pack size in the row title), and reading one as the other is the
 * same class of bug as the 30-egg tray filed as 1650 g — see `AddPayload`.
 */

/** One line of the texted list, with its quantities separated out. */
export interface ParsedItem {
	/** The line exactly as typed, kept so a reply can quote it back. */
	raw: string;
	/** What's left once quantities are stripped — the thing to match on. */
	name: string;
	/** How many to buy. 1 unless the line said otherwise. */
	count: number;
	/**
	 * Stated pack size in grams (or ml — see `volumetric`), or null when the line
	 * didn't say. Null is the common case and is not a failure: no shopping list
	 * says what size the milk is.
	 */
	amountG: number | null;
	/** True when the size was written as a volume (ml/L) rather than a weight. */
	volumetric: boolean;
}

/**
 * Unit spellings → multiplier into grams/ml, and whether it's a volume.
 *
 * `l` and `ml` are the only volumetric ones. Note `g` must be tried AFTER `gm`
 * and `gms` or the longer spellings never match — the alternation below is
 * ordered longest-first for exactly that reason.
 */
const UNITS: { pattern: string; factor: number; volumetric: boolean }[] = [
	{ pattern: "kgs?", factor: 1000, volumetric: false },
	{ pattern: "kilos?", factor: 1000, volumetric: false },
	{ pattern: "grams?", factor: 1, volumetric: false },
	{ pattern: "gms?", factor: 1, volumetric: false },
	{ pattern: "g", factor: 1, volumetric: false },
	{ pattern: "mls?", factor: 1, volumetric: true },
	{ pattern: "litres?", factor: 1000, volumetric: true },
	{ pattern: "liters?", factor: 1000, volumetric: true },
	{ pattern: "ltrs?", factor: 1000, volumetric: true },
	{ pattern: "l", factor: 1000, volumetric: true },
];

const SIZE_RE = new RegExp(
	String.raw`(?<![\w.])(\d+(?:[.,]\d+)?)\s*(${UNITS.map((u) => u.pattern).join("|")})(?![\w])`,
	"i",
);

/** Resolve a matched unit spelling back to its multiplier. Longest-first, as above. */
function unitFor(spelling: string) {
	const s = spelling.toLowerCase();
	return UNITS.find((u) => new RegExp(`^(?:${u.pattern})$`, "i").test(s));
}

/**
 * A trailing bare integer is capped at 99 before it's read as a count.
 *
 * "eggs 30" is plainly thirty eggs, but "bread 600" is far more likely a gram
 * figure someone forgot the unit on, and filing that as 600 loaves is the kind of
 * mistake that is funny once and then costs a re-typed list. Anything larger is
 * left in the name, where a human reading the confirmation will spot it.
 */
const MAX_BARE_COUNT = 99;

/**
 * Leading list decoration: bullets, and "1." / "2)" numbering (NOT a bare "1").
 *
 * ⚠️ **Numbering must be followed by whitespace, and that is load-bearing.**
 * Without the `\s+`, `1.5kg flour` has its "1." stripped as a list number and the
 * line becomes "5kg flour" — a five-fold size error that parses cleanly and
 * writes a plausible row. Caught by `list-parse.test.ts`; do not relax it back to
 * `\s*`.
 */
const BULLET_RE = /^\s*(?:[-*•·–—]+\s*|\d+[.)]\s+)/;

/** Punctuation and separators the quantity strip can leave at either end. */
const EDGE_PUNCT = /^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g;

/**
 * A multiplier sign left stranded at either end, as a WHOLE WORD.
 *
 * ⚠️ **`x` means `*` — it is a multiplier, not a letter to be trimmed.** The size
 * is taken out first (rule 1 below), so `Carrots x 1kg` reaches here as
 * `Carrots x` with its number already gone and rule 2 unable to see it. Left in,
 * the name is `Carrots x`, which scored **0.65** against `carrots, Normal` instead
 * of 1.000 and made the bot ask a question it knew the answer to (2026-08-11).
 *
 * ⚠️ **Whole word, never a character.** The old rule stripped `x` as part of a
 * leading character class, which quietly turns `Xylitol` into `ylitol` — and `x` is
 * a letter groceries genuinely start with. Hence the `\s`/`$` anchors on both ends.
 */
const STRAY_MULT = /^[x×](?=\s|$)|(?:^|\s)[x×]$/gi;

/** Trim punctuation and stray separators the quantity strip can leave behind. */
function tidy(s: string): string {
	return s
		.replace(/\s+/g, " ")
		.replace(EDGE_PUNCT, "")
		// After the punctuation, so "Carrots - x" loses both, and again afterwards so
		// "Carrots, x" is not left with its comma.
		.replace(STRAY_MULT, "")
		.replace(EDGE_PUNCT, "")
		.trim();
}

/**
 * Split a message into candidate lines.
 *
 * Newlines first, and a line is only split further on commas when the WHOLE
 * message was one line. That rule exists because the user's own naming standard
 * is full of commas — `Onion (White), Fresh` is one ingredient, not two — so
 * comma-splitting a multi-line message would shred names that are already fine.
 * A single-line message, on the other hand, is almost always "milk, eggs, rice".
 */
export function splitLines(message: string): string[] {
	const lines = message
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length > 1) return lines;
	return (lines[0] ?? "")
		.split(/\s*,\s*/)
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Parse one line. Null when nothing but decoration and numbers was left. */
export function parseItem(line: string): ParsedItem | null {
	const raw = line.trim();
	let rest = raw.replace(BULLET_RE, "");

	// 1. Pack size, anywhere in the line. Taken out first so its digits can't be
	//    picked up by any of the count rules below.
	let amountG: number | null = null;
	let volumetric = false;
	const size = rest.match(SIZE_RE);
	if (size) {
		const unit = unitFor(size[2]);
		if (unit) {
			const value = Number(size[1].replace(",", "."));
			if (Number.isFinite(value) && value > 0) {
				amountG = Math.round(value * unit.factor);
				volumetric = unit.volumetric;
			}
		}
		rest = rest.slice(0, size.index) + " " + rest.slice(size.index! + size[0].length);
	}

	// 2. An explicit multiplier, either side: "x6", "6 x", "×2".
	let count: number | null = null;
	const mult = rest.match(/(?:^|\s)(?:[x×]\s*(\d+)|(\d+)\s*[x×])(?=\s|$)/i);
	if (mult) {
		count = Number(mult[1] ?? mult[2]);
		rest = rest.slice(0, mult.index) + " " + rest.slice(mult.index! + mult[0].length);
	}

	// 3. A bare integer at either end. Leading is unambiguous ("2 milk"); trailing
	//    is guessier, so it's capped — see MAX_BARE_COUNT.
	if (count == null) {
		const lead = rest.match(/^\s*(\d+)\s+(?=\S)/);
		if (lead) {
			count = Number(lead[1]);
			rest = rest.slice(lead[0].length);
		} else {
			const trail = rest.match(/\s(\d+)\s*$/);
			if (trail && Number(trail[1]) <= MAX_BARE_COUNT) {
				count = Number(trail[1]);
				rest = rest.slice(0, trail.index);
			}
		}
	}

	// A line with no words left is not an item. "42" on its own reaches here with
	// its digits intact — neither count rule fires without a name beside them — and
	// filing a grocery row called "42" is worse than dropping the line.
	const name = tidy(rest);
	if (!name || !/[a-zÀ-￿]/i.test(name)) return null;
	return {
		raw,
		name,
		count: count && count > 0 ? count : 1,
		amountG,
		volumetric,
	};
}

/** Parse a whole Telegram message into items, dropping anything unreadable. */
export function parseList(message: string): ParsedItem[] {
	return splitLines(message)
		.map(parseItem)
		.filter((i): i is ParsedItem => i !== null);
}

/**
 * How a parsed size should READ on the shopping list — "750ml", "1.5kg", "500g".
 *
 * Deliberately the same shape as the deals page's own pack label, so a row added
 * from a text and a row added from a Buy button don't look like they came from
 * two different systems.
 */
export function sizeLabel(item: ParsedItem): string | undefined {
	if (!item.amountG) return undefined;
	const big = item.volumetric ? "L" : "kg";
	const small = item.volumetric ? "ml" : "g";
	return item.amountG >= 1000
		? `${+(item.amountG / 1000).toFixed(2)}${big}`
		: `${Math.round(item.amountG)}${small}`;
}
