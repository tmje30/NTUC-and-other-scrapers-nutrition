import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
	MACRO_MODEL,
	MACRO_SYSTEM,
	isCommodityFood,
	macroToolsFor,
	macroUserContent,
	packShotsFor,
	parseMacroReply,
	replyText,
	type MacroQuery,
	type MacroResult,
} from "./macro-prompt.js";

/**
 * Macro-nutrient lookup for a product being filed into Ingredients — the NODE
 * transport. The prompt, the parsing and the sanity gate live in
 * `macro-prompt.ts`, shared verbatim with the Chrome extension so the two can
 * never drift on what a trustworthy answer is.
 *
 * The Ingredients DB already has the four columns (`Protein per 100g`,
 * `Fats per 100 g `, `Carbs per 100g `, `Fiber per 100g `) and a stack of
 * formulas built on top of them — cost per 100g protein, calories, the plan
 * sums. A row added without them is a row that silently breaks those formulas,
 * so both "Add to Ingredients" buttons fill them in.
 *
 * Everything here is non-fatal. No key, no answer, a malformed answer, a network
 * failure: all return null, and the row is written without nutrition rather than
 * not written at all.
 */

// Re-exported so `ingredient-write.ts` and the scripts keep importing the types
// from here — the transport split is not their business.
export type { Macros, MacroQuery, MacroResult, MacroSource } from "./macro-prompt.js";

/**
 * Ceiling on one lookup, and the retries allowed under it.
 *
 * Measured 2026-08-03: a clean lookup takes ~55s, but one fighting an unreadable
 * product page took **245s** before giving up. The SDK's own defaults are 10
 * minutes and 2 retries — half an hour of worst case for a button that fills in
 * four numbers. Timing out and writing the row without nutrition is strictly
 * better than making the user wait for it, which is the whole design of this
 * module's failure path.
 *
 * Transport-only, so it lives here rather than in `macro-prompt.ts`: the
 * extension has its own `fetch` and its own idea of how long a popup may hang.
 */
const TIMEOUT_MS = 180_000;
const MAX_RETRIES = 1;

export function macrosConfigured(): boolean {
	return Boolean(config.anthropicKey());
}

/**
 * Look up the four figures. Returns null when they can't be had — never throws,
 * because a failed lookup must degrade the row, not lose it.
 */
export async function lookupMacros(q: MacroQuery): Promise<MacroResult | null> {
	const key = config.anthropicKey();
	if (!key) {
		console.error("No ANTHROPIC_API_KEY — writing the row without nutrition figures.");
		return null;
	}

	// Fresh produce and raw meat get NO tools: measured, searching for them costs 40-50 cents to arrive at
	// the generic answer the model already had. See `isCommodityFood`.
	const tools = macroToolsFor(q);
	if (isCommodityFood(q)) {
		console.error(`Macro lookup: "${q.product}" is a fresh commodity — answering without search.`);
	}

	// Printed for the same reason the cost line is: the pack shots are the difference between a 3-cent
	// lookup and a 29-cent one, and a silent gate is one nobody notices has stopped firing.
	const shots = packShotsFor(q);
	if (shots.length) {
		console.error(`Macro lookup: reading ${shots.length} pack shot${shots.length === 1 ? "" : "s"} off the label.`);
	}

	try {
		const client = new Anthropic({
			apiKey: key,
			timeout: TIMEOUT_MS, // milliseconds in the TS SDK
			maxRetries: MAX_RETRIES,
		});
		const response = await client.messages.create({
			model: MACRO_MODEL,
			max_tokens: 8000,
			system: MACRO_SYSTEM,
			// No temperature/top_p — Sonnet 5 rejects non-default sampling parameters.
			output_config: { effort: "medium" },
			tools: tools as unknown as never,
			messages: [{ role: "user", content: macroUserContent(q) }],
		} as any);

		const u = (response as any).usage ?? {};
		const searches = u.server_tool_use?.web_search_requests ?? 0;

		// Log what the call cost. This exists because the figure in this file was wrong by 5x for a while
		// and nobody could see it: the bill is dominated by INPUT tokens (web_fetch drops whole pages in),
		// not by the model rate, and that is invisible without printing it. Sonnet 5 introductory rates.
		const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
		const outTok = u.output_tokens ?? 0;
		const usd = (inTok * 2) / 1e6 + (outTok * 10) / 1e6 + searches * 0.01;
		console.error(
			`Macro lookup: in=${inTok} out=${outTok} searches=${searches} ≈ US$${usd.toFixed(4)}` +
				(tools.length ? "" : " (no tools — fresh commodity)"),
		);

		return parseMacroReply(replyText(response.content), searches);
	} catch (e) {
		// Rate limit, bad key, network, a model change: none of these are worth
		// failing an add over.
		console.error(`Macro lookup failed — ${(e as Error).message}. Writing the row without it.`);
		return null;
	}
}
