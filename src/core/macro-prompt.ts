/**
 * The macro lookup, minus the transport.
 *
 * Split out of `macros.ts` for one reason: the Chrome extension needs the SAME
 * lookup, and it cannot have `macros.ts`. That module imports `@anthropic-ai/sdk`
 * and `config.ts`, and neither survives a browser service worker — the SDK is a
 * Node HTTP client and `config.ts` reads `process.env` at module load.
 *
 * So everything that DECIDES the answer lives here — the system prompt, the
 * request shape, the parsing, the sanity gate — and the two callers supply only
 * the HTTP:
 *   - `macros.ts`            Node, via the official SDK, key from `.env`
 *   - `extension/macros-client.js`  browser, via `fetch`, key from extension storage
 *
 * This file must stay free of Node imports. Same rule as `ingredients-schema.ts`
 * and `match.ts`, and for the same reason: the extension bundles it verbatim.
 *
 * **Why a model and not a nutrition API.** The alternative was USDA
 * FoodData Central: free, precise, and almost entirely ignorant of Singapore
 * supermarket brands, so nearly every lookup would have fallen through to a
 * generic match anyway. Claude with web search reads the shop's own product page
 * first — which is where the real panel is when there is one — and only searches
 * when the page is silent.
 *
 * **Three tiers, in order**, mirroring what the user asked for:
 *   product-page — the panel on the page we were already looking at
 *   search       — the same product's panel found elsewhere
 *   generic      — a representative value for the food, when the exact product
 *                  can't be pinned down
 *
 * The tier is recorded and reported, because "4.2g of protein" means something
 * different when it came off the label than when it came off a category average,
 * and the user is the one who decides whether that is good enough to keep.
 */

/** Grams per 100 g (or per 100 ml) of product. */
export interface Macros {
	proteinPer100g: number | null;
	fatsPer100g: number | null;
	carbsPer100g: number | null;
	fiberPer100g: number | null;
}

export type MacroSource = "product-page" | "search" | "generic";

export interface MacroResult extends Macros {
	source: MacroSource;
	/** One line on what was actually measured — "raw skin-on chicken thigh". */
	basis: string;
	/** What the model looked at, for the workflow's reply. */
	note: string;
}

export interface MacroQuery {
	/** The store's product name, as printed. */
	product: string;
	brand?: string;
	store?: string;
	/** The product page. Put in the prompt so `web_fetch` is allowed to read it. */
	url?: string;
	/** The user's own name for the ingredient — the food, stripped of branding. */
	ingredientName?: string;
	/** Notion category, as a hint ("[1] Meats/Dairy/Proteins"). */
	category?: string;
}

/**
 * The one instruction that matters most, and the reason this is a prompt rather
 * than a database join: **the state of the food changes the numbers**, and the
 * state is written on the label, not in the food name. Roast chicken is not raw
 * chicken; dried pasta is not cooked pasta; the difference is a factor of two or
 * three on every column. A lookup that gets the food right and the state wrong is
 * more dangerous than one that returns nothing, because nothing is visibly
 * missing and a wrong number just quietly poisons the plan sums.
 */
export const MACRO_SYSTEM = `You look up macro-nutrient values for a grocery product and report them per 100 g (or per 100 ml for liquids).

Work in this order and stop as soon as you have a trustworthy answer:
1. Read the product page URL if one is given. Supermarket pages often carry the nutrition panel.
2. If the page has no panel, search for that exact product and brand.
3. If the exact product cannot be pinned down, use representative generic values for that food.

The STATE of the food decides the numbers, and getting it wrong is worse than returning nothing:
- Raw, fresh, chilled and frozen meat and fish are RAW. Use raw values, never roasted, grilled or cooked.
- Dried pasta, rice, lentils and oats are DRY. Use dry values, never boiled.
- If the product is cooked, ready-to-eat, canned in liquid, or a prepared meal, use values for that form.
- Skin-on, skinless, breast, thigh, lean, full-fat, semi-skimmed, light: match what the label says.

Report grams per 100 g. Fibre is reported separately from carbohydrate, matching the label convention where "Carbohydrate" is total carbohydrate. Use null for any value you genuinely cannot establish — do not pad an answer with a guess dressed up as a fact.

End your reply with a single fenced json block, and nothing after it:

\`\`\`json
{
  "proteinPer100g": 20.5,
  "fatsPer100g": 3.1,
  "carbsPer100g": 0,
  "fiberPer100g": 0,
  "source": "product-page" | "search" | "generic",
  "basis": "short description of exactly what these figures are for, including the state"
}
\`\`\``;

/**
 * Sonnet rather than Opus: this is a read-a-label-and-report task, the answer is
 * four numbers, and the tier is checkable by the user. ~6-7 US cents per lookup,
 * and only when the user actually taps Add.
 */
export const MACRO_MODEL = "claude-sonnet-5";

/** How many searches one lookup may run. A hard cap on the per-tap cost. */
export const MACRO_MAX_SEARCHES = 4;

/**
 * Shops whose product pages `web_fetch` cannot read, so it must not try.
 *
 * Sheng Siong sits behind Incapsula — the same wall that forced the daily
 * scraper onto the site's DDP socket instead of its HTML (see
 * `stores/shengsiong.ts`). The failure is not a quick 403: measured 2026-08-03,
 * a Sheng Siong lookup spent **245 seconds** mostly waiting on a page that was
 * never going to answer, then fell back to search — which is where blocking it
 * sends the lookup immediately.
 *
 * FairPrice is deliberately NOT listed. Its pages are server-rendered and often
 * carry a real nutrition panel, which is the best answer this module can get.
 */
export const UNFETCHABLE_DOMAINS = ["shengsiong.com.sg"];

/**
 * The tools, in the wire shape both callers send.
 *
 * ⚠️ `_20260209` — the dynamic-filtering versions. They need Sonnet 5 (or Opus
 * 4.6+), which `MACRO_MODEL` is. Do not "simplify" these to the older
 * `web_search_20250305` / `web_fetch_20250910` names; and do not add a separate
 * `code_execution` tool alongside them, because these versions run code
 * internally to filter results and a second sandbox confuses the model.
 */
export const MACRO_TOOLS = [
	{ type: "web_search_20260209", name: "web_search", max_uses: MACRO_MAX_SEARCHES },
	{
		type: "web_fetch_20260209",
		name: "web_fetch",
		max_uses: 3,
		blocked_domains: UNFETCHABLE_DOMAINS,
	},
] as const;

/** The user turn. Everything the caller knows about the product, one fact per line. */
export function macroUserPrompt(q: MacroQuery): string {
	const lines = [
		`Product: ${q.product}`,
		q.brand ? `Brand: ${q.brand}` : "",
		q.store ? `Shop: ${q.store}` : "",
		q.url ? `Product page: ${q.url}` : "",
		q.ingredientName ? `The user calls this ingredient: ${q.ingredientName}` : "",
		q.category ? `Filed under: ${q.category}` : "",
	].filter(Boolean);

	return (
		`Find the macro-nutrients for this product.\n\n${lines.join("\n")}\n\n` +
		`Remember: match the state on the label (raw / dry / cooked), and report per 100 g.`
	);
}

/** A finite, non-negative, plausible grams-per-100g figure, or null. */
function gramsPer100(v: unknown): number | null {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
	if (!Number.isFinite(n) || n < 0 || n > 100) return null;
	return Math.round(n * 100) / 100;
}

/** The LAST fenced json block — the model may quote a label earlier in its reply. */
function lastJsonBlock(text: string): unknown | null {
	const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
	const raw = blocks.at(-1)?.[1];
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Sanity gate on the parsed answer.
 *
 * Protein + fat + carbohydrate cannot exceed 100 g in 100 g of food — the rest is
 * water, ash and fibre. A little slack is allowed for rounding and for labels
 * that count fibre inside carbohydrate, but a total in the 130s means the model
 * has mixed up per-serving and per-100g figures, which is the single most likely
 * way for this to go wrong and the easiest to catch.
 */
function plausible(m: Macros): boolean {
	const total = (m.proteinPer100g ?? 0) + (m.fatsPer100g ?? 0) + (m.carbsPer100g ?? 0);
	return total <= 105;
}

/**
 * Reply text → the four figures, or null with the reason on the console.
 *
 * Null covers every way the answer can be unusable: no JSON block, nothing
 * established, or figures that can only be per-serving. The caller writes the row
 * without nutrition rather than writing numbers nobody checked.
 */
export function parseMacroReply(text: string, searches = 0): MacroResult | null {
	const parsed = lastJsonBlock(text) as Record<string, unknown> | null;
	if (!parsed) {
		console.error("Macro lookup: no JSON block in the reply — skipping nutrition.");
		return null;
	}

	const macros: Macros = {
		proteinPer100g: gramsPer100(parsed.proteinPer100g),
		fatsPer100g: gramsPer100(parsed.fatsPer100g),
		carbsPer100g: gramsPer100(parsed.carbsPer100g),
		fiberPer100g: gramsPer100(parsed.fiberPer100g),
	};

	// All four missing is not an answer — write nothing rather than a row of nulls
	// that looks like it was checked.
	if (Object.values(macros).every((v) => v == null)) {
		console.error("Macro lookup: nothing established — skipping nutrition.");
		return null;
	}
	if (!plausible(macros)) {
		console.error("Macro lookup: figures exceed 100 g per 100 g — rejected as per-serving.");
		return null;
	}

	const source: MacroSource =
		parsed.source === "product-page" || parsed.source === "search" ? parsed.source : "generic";
	// 400, not 200: the basis is the one line that says whether to trust the
	// figures ("raw, bone-in, skin-on; no brand panel published, so USDA generic")
	// and the first cap cut that sentence off exactly where it started to matter.
	const basis = String(parsed.basis ?? "").trim().slice(0, 400) || "unspecified";

	return {
		...macros,
		source,
		basis,
		note:
			`${source === "generic" ? "generic values" : source === "search" ? "found by search" : "from the product page"}` +
			` — ${basis}${searches ? ` (${searches} search${searches === 1 ? "" : "es"})` : ""}`,
	};
}

/** Text blocks of a Messages API response, joined. Same shape on both transports. */
export function replyText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
		.map((b) => String((b as { text?: string }).text ?? ""))
		.join("\n");
}
