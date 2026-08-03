import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
	MACRO_MODEL,
	MACRO_SYSTEM,
	MACRO_TOOLS,
	macroUserPrompt,
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
			tools: MACRO_TOOLS as unknown as never,
			messages: [{ role: "user", content: macroUserPrompt(q) }],
		} as any);

		const searches = (response as any).usage?.server_tool_use?.web_search_requests ?? 0;
		return parseMacroReply(replyText(response.content), searches);
	} catch (e) {
		// Rate limit, bad key, network, a model change: none of these are worth
		// failing an add over.
		console.error(`Macro lookup failed — ${(e as Error).message}. Writing the row without it.`);
		return null;
	}
}
