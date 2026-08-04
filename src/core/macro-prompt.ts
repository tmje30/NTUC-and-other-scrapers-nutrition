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
	/**
	 * The project's own category key from `categorize()` — "produce", "protein", etc.
	 * Distinct from `category`, which is the user's Notion option NAME. Only this one
	 * is stable enough to branch on; see `isCommodityFood`.
	 */
	categoryKey?: string;
	/**
	 * Pack-shot photo URLs from the shop's own product record, in the order it
	 * publishes them. Pass them ALL — `packShotsFor` decides which are worth
	 * sending and how many. Absent for callers with no page to read (the history
	 * page's Add button), which is exactly the text-only path this used to be.
	 */
	images?: string[];
}

/**
 * Foods where searching the web is money burnt: the answer is a commodity figure
 * the model already knows, and no product label exists to find.
 *
 * **Measured 2026-08-04.** Four lookups on Seara Frozen Chicken Thigh, across
 * every tool configuration, cost US$0.38–0.60 each, took 30–64 s, and landed on
 * the `generic` tier every single time — the model searched, found no label,
 * and answered from its own knowledge anyway. It also disagreed with itself:
 * 16.6, 16.7, 17 and 24.8 g protein per 100 g, where ~17–18 is right. So the
 * searching bought latency, cost and a wrong outlier, and no accuracy.
 *
 * The gate is deliberately NARROW, because "no label" is not the same as the
 * category. Fresh chicken and a tub of Greek yoghurt are both `protein`, but the
 * yoghurt is branded and its panel is findable, so it keeps its tools. Two cases
 * qualify and nothing else:
 *   - produce — loose fruit and veg, never labelled
 *   - a meat / fish / egg word AND an explicit fresh|frozen|chilled|raw state
 *
 * Requiring the state word is what keeps processed goods out: "FairPrice Tuna
 * Flakes - In Water" names a fish but no state, so it still gets the full lookup.
 */
const FRESH_STATE = /\b(fresh|frozen|chilled|raw|live)\b/i;
const MEAT_FISH_EGG =
	/\b(chicken|beef|pork|mutton|lamb|duck|turkey|fish|salmon|tuna|cod|seabass|snapper|threadfin|pomfret|prawns?|shrimps?|squid|crabs?|clams?|mussels?|scallops?|thighs?|breasts?|drumsticks?|wings?|fillets?|minced?|liver|eggs?)\b/i;

export function isCommodityFood(q: MacroQuery): boolean {
	if (q.categoryKey === "produce") return true;
	const text = `${q.product} ${q.ingredientName ?? ""}`;
	return MEAT_FISH_EGG.test(text) && FRESH_STATE.test(text);
}

/**
 * The tools this query should get: none for a commodity food, the full set otherwise.
 *
 * An empty array is the point — with no `web_search` or `web_fetch` the model answers
 * straight from its own knowledge, which is what the `generic` tier already was, for
 * roughly a cent instead of forty and in a second or two instead of a minute.
 */
export function macroToolsFor(q: MacroQuery): readonly unknown[] {
	return isCommodityFood(q) ? [] : MACRO_TOOLS;
}

/**
 * The pack shots worth attaching: the views that could plausibly show a nutrition
 * label, and no more than `max` of them.
 *
 * **Why this is the single biggest lever in this module.** Measured twice, a day
 * apart, on Skippy Peanut Butter — the numbers reproduce exactly:
 *
 * | variant        | input tok | searches | secs | tier         | cost    |
 * | text only      |   123,389 |        2 |   54 | search       | $0.2877 |
 * | + 2 pack shots |    13,885 |        0 |    8 | product-page | $0.0296 |
 *
 * Ten times cheaper, seven times faster, a better tier and the right answer
 * (22.8 g protein). It reads the jar and stops, so it never pays for a search —
 * and searching is not where the money went either: `web_fetch` dropping a
 * 340-390 KB page into context was ~90% of the text-only bill. A photo of the
 * label is a fraction of that and answers the question directly.
 *
 * ⚠️ **The FRONT shot is deliberately excluded, and that is the whole gate.**
 * Attaching photos back-fired once, on frozen chicken: $0.60 against $0.41
 * text-only, and it produced a 24.8 g protein outlier where ~17-18 is right. The
 * cause was a pack with no panel — given only the marketing face, the model
 * read the marketing. So only the back and side views are sent, and a listing
 * that publishes nothing but a front shot gets no images at all and takes the
 * ordinary path. `isCommodityFood` already diverts fresh produce and raw meat
 * away from tools entirely, so between the two the "no label exists" case is
 * covered from both ends.
 *
 * ⚠️ **Feed this the images off the SLUG-ANCHORED product object** (FairPrice's
 * `own.images`), never a scrape of the page — a FairPrice product page embeds its
 * whole recommendations carousel, and a rival product's label is the one wrong
 * answer that looks entirely plausible. Same rule as `nutrition-panel.ts`.
 *
 * ⚠️ **Do NOT filter these by the product's SKU.** The obvious-looking rule, and
 * wrong: FairPrice reuses one photo across a range, so "[BCRS] Farmhouse Milk -
 * Fresh" (`clientItemId` 13281014) publishes `10966597_LXL1_20230327.jpg` as its
 * own side view. Reading the product's own `images` array is both simpler and
 * more accurate than reconstructing which files belong to it.
 *
 * FairPrice's filenames encode the view: `<sku>_XL1_<date>.jpg` is the front,
 * `_BXL1_` the back, `_LXL1_` / `_RXL1_` the sides. The date is optional
 * (`13051601_BXL1.jpg`), which is why the pattern must not require it. A URL that
 * matches no known convention is skipped rather than guessed at — for a shop
 * whose naming we don't recognise, "no images" is the honest and cheaper answer.
 */
const PACK_SHOT_VIEW = /_([A-Z]{0,2})XL\d+(?:[_.]|$)/i;

/** Back first — it is where the panel is — then the sides, which sometimes carry it. */
const VIEW_RANK: Record<string, number> = { B: 0, L: 1, R: 2 };

/**
 * Two, not four. The measured win came from two images, and each one costs input
 * tokens whether or not it says anything; a soy sauce bottle publishing four views
 * does not have four labels.
 */
export const MAX_PACK_SHOTS = 2;

export function selectPackShots(images: readonly string[] | undefined, max = MAX_PACK_SHOTS): string[] {
	const ranked: { url: string; rank: number }[] = [];
	for (const url of images ?? []) {
		if (typeof url !== "string" || !/^https:\/\//i.test(url)) continue;
		const view = PACK_SHOT_VIEW.exec(url)?.[1]?.toUpperCase();
		// "" is the front shot — a known view, and one we are choosing not to send.
		if (!view) continue;
		const rank = VIEW_RANK[view];
		if (rank == null) continue;
		if (!ranked.some((r) => r.url === url)) ranked.push({ url, rank });
	}
	return ranked
		.sort((a, b) => a.rank - b.rank)
		.slice(0, max)
		.map((r) => r.url);
}

/**
 * The pack shots for a QUERY — `selectPackShots` plus the commodity gate. **This is
 * the one every caller should use**; the raw selector exists to be tested on its own.
 *
 * A fresh commodity gets no photographs even when the shop publishes a back view,
 * and that is the frozen-chicken lesson written down: images plus tools cost $0.60
 * against $0.41 text-only and returned 24.8 g of protein where ~17-18 is right,
 * because a pack with no panel leaves only marketing copy to read. `isCommodityFood`
 * already routes these to the free, tool-less path at ~$0.003 with better figures —
 * attaching a photo would make it dearer, slower and worse in one move.
 *
 * So the two gates compose rather than compete: no label exists → answer from
 * knowledge; a label exists and the shop photographed its back → read it; a label
 * exists but only the front was photographed → go and find it the old way.
 */
export function packShotsFor(q: MacroQuery, max = MAX_PACK_SHOTS): string[] {
	return isCommodityFood(q) ? [] : selectPackShots(q.images, max);
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
1. If photographs of the packaging are attached, read the nutrition panel off them. They are the shop's own pack shots of this exact product, so a panel you can read there is the product's own label — report it and stop, with "source": "product-page". Do not fetch or search once you have read it.
2. Read the product page URL if one is given. Supermarket pages often carry the nutrition panel.
3. If neither has a panel, search for that exact product and brand.
4. If the exact product cannot be pinned down, use representative generic values for that food.

An attached photo that does NOT show a legible nutrition panel establishes nothing. Marketing text on a pack ("high in protein", "no added sugar") is a claim, not a measurement — never turn one into a number. Move on to the next step instead.

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
 * four numbers, and the tier is checkable by the user.
 *
 * ⚠️ **Cost, measured 2026-08-04 — not the ~6-7 cents this comment used to claim.**
 * Four real lookups came in at **US$0.29–0.41 each**, and the model rate is not
 * where it goes: input was 123k–280k tokens per call, ~90% of the bill, because
 * `web_fetch` drops the WHOLE product page into context (a FairPrice page is
 * 340–390 KB of HTML). Two web searches were 2 cents of a 41-cent call.
 *
 * ⚠️ **`max_content_tokens` on web_fetch does NOT fix it — measured, don't retry.**
 * Capping the fetch at 8k moved Skippy -25% but Seara **+27%**: starved of page
 * text the model just searches more, and search results are large too. Same-config
 * reruns also varied ±30% (Skippy text 123k then 93k input; Seara 189k then 236k),
 * so single measurements here are noise-prone and a 25% "win" is not a result.
 *
 * What IS repeatable: passing the back-of-pack image made a labelled product
 * **$0.03 in 8s** (twice: $0.0296, $0.0314), read straight off the label with zero
 * searches. Since input tokens dominate, a cheaper model would also scale nearly
 * linearly — unlike what an earlier version of this comment claimed.
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

/** The user turn's TEXT. Everything the caller knows about the product, one fact per line. */
export function macroUserPrompt(q: MacroQuery): string {
	const shots = packShotsFor(q);
	const lines = [
		`Product: ${q.product}`,
		q.brand ? `Brand: ${q.brand}` : "",
		q.store ? `Shop: ${q.store}` : "",
		q.url ? `Product page: ${q.url}` : "",
		q.ingredientName ? `The user calls this ingredient: ${q.ingredientName}` : "",
		q.category ? `Filed under: ${q.category}` : "",
	].filter(Boolean);

	// With no tools attached, steps 1 and 2 of the system prompt are impossible, and a model told to read a
	// page it cannot reach either stalls or invents having read one. So say plainly that step 3 is the job.
	const noTools = isCommodityFood(q)
		? `\n\nYou have NO search or fetch tools for this lookup, and that is deliberate: this is a fresh, ` +
			`unbranded food with no published nutrition label. Do not claim to have read a page or searched. ` +
			`Answer directly from your own knowledge with representative values for this food in the state ` +
			`named, set "source" to "generic", and say in "basis" which reference food you used.`
		: "";

	// Say the photos are the shop's own and which views they are. Without that the model treats them as
	// incidental illustrations and fetches the page anyway, which is the entire cost this was meant to avoid.
	const withShots = shots.length
		? `\n\nAttached: ${shots.length === 1 ? "1 photograph" : `${shots.length} photographs`} of this product's ` +
			`packaging, published by the shop itself — the back and side views, which is where the nutrition ` +
			`panel is printed. Read the panel off them and report it. Only fall back to fetching or searching ` +
			`if no legible panel is visible.`
		: "";

	return (
		`Find the macro-nutrients for this product.\n\n${lines.join("\n")}\n\n` +
		`Remember: match the state on the label (raw / dry / cooked), and report per 100 g.${withShots}${noTools}`
	);
}

/**
 * The user turn as the Messages API wants it: the pack shots, then the text.
 *
 * Images FIRST — the documented ordering for image-plus-text prompts, and the one
 * the measured runs used. Both transports call this rather than building the
 * content themselves, for the same reason they share the prompt: the extension
 * and the Node side must never disagree about what was asked.
 *
 * A `url` image source, not base64: the API fetches the file itself, so nothing
 * here downloads a JPEG, and a browser service worker is spared the CORS fight it
 * would otherwise lose. The trade is that an image the API cannot reach is simply
 * absent from the model's view — which degrades to the text-only path this
 * function returns when there are no shots at all, and that is the correct
 * failure.
 */
export function macroUserContent(q: MacroQuery): unknown[] {
	const shots = packShotsFor(q);
	return [
		...shots.map((url) => ({ type: "image", source: { type: "url", url } })),
		{ type: "text", text: macroUserPrompt(q) },
	];
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
