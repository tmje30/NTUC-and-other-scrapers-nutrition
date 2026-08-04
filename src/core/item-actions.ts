/**
 * What the buttons in the page's "Recently bought · not searched" section ship
 * back to the repo.
 *
 * These are the counterpart to `AddPayload`: Add puts an item ON the list, these
 * undo or retire the snooze that adding it created. Same journey — a GitHub issue
 * body or a `repository_dispatch` — so the payload must stay small, JSON-safe and
 * readable, because the user sees it before submitting.
 *
 * Kept in its own module (no I/O, no Notion client) so the static page builder
 * and the privileged workflow script can share one definition of the contract.
 */

/**
 * What a button can ask for. Two families, from two pages.
 *
 * **From the deals page** — about an item and today's match for it:
 *   reset           un-snooze now
 *   park            retire the ingredient in Notion as well
 *   ignore-week     don't search this until the start of next week
 *   mismatch        never match these words for this item again
 *   almost          block this one product for this item
 *   ignore-product  never offer this PRODUCT again, for any item
 *   add-ingredient  file today's match as a NEW Ingredients row (shared with the history page)
 *   rebase-ingredient  repoint the ingredient that SEEDED the search at today's match
 *
 * **From the history page** — about something already bought or parked:
 *   unpark             clear `Not in Use ATM` so the ingredient is searched again
 *   add-ingredient     file a bought product as a NEW Ingredients row, macros and all
 *   replace-ingredient point the existing ingredient row at what was actually bought
 *   never-buy          never buy this product again (the same block as `ignore-product`)
 *
 * `ignore-product` and `never-buy` do the identical thing and are kept apart only
 * so the log says which page it came from — one is "stop offering me this deal",
 * the other is "I bought this and regret it". Both write one `ALL_ITEMS` block.
 *
 * ⚠️ `rebase-ingredient` and `replace-ingredient` are NOT the same and must not be
 * merged. Both point an existing row at a different product, but they disagree on
 * the two things that matter:
 *
 * | | renames the row | writes the URL |
 * | `replace-ingredient` (history page) | no | yes |
 * | `rebase-ingredient` (deals page)    | **yes**, to a generic name | **no** |
 *
 * The history page means "same thing, new price", so renaming would be a change
 * nobody asked for. The deals page means "this cheaper product is what I actually
 * want this ingredient to be from now on" — it re-bases the search itself, so the
 * name has to follow or the next scan keeps hunting for the old thing.
 */
export type ItemAction =
	| "reset"
	| "park"
	| "ignore-week"
	| "mismatch"
	| "almost"
	| "ignore-product"
	| "unpark"
	| "add-ingredient"
	| "replace-ingredient"
	| "rebase-ingredient"
	| "never-buy";

export interface ActionPayload {
	v: 1;
	action: ItemAction;
	/** Base-noun cooldown key to clear (see `cooldownKey`). */
	key: string;
	/** Notion page id of the ingredient — required by `park`, traceability for `reset`. */
	ingredientId: string;
	/** The ingredient's display name, for the log and the issue comment. */
	name: string;
	/** The store the card was showing. Evidence on `mismatch`, identity on `almost`/`ignore-product`. */
	store?: string;
	/** The product name the card was showing. */
	product?: string;
	/** The product's page URL — how `almost` and `ignore-product` recognise it again. */
	url?: string;
	/** Words to stop matching, for `mismatch`. Suggested by the page, edited by the user. */
	terms?: string[];
	/** Free-text reason, for `almost` ("not pasteurized"). */
	note?: string;

	// ---- History-page fields. Only the three purchase actions set these. ----

	/** Which row of `data/purchases.json` this is about (see `purchaseId`). */
	purchaseId?: string;
	/** What the pack cost, SGD — written onto the Ingredients row. */
	priceSgd?: number | null;
	/** Pack size in grams/ml, or null when the shop published neither. */
	packSizeG?: number | null;
	/** True when the pack was measured by volume — decides By ml vs By Gram. */
	volumetric?: boolean;

	// ---- Nutrition. Two fields, and the difference between them is money. ----

	/**
	 * The four per-100g figures the SHOP already published, parsed off its own
	 * nutrition panel at build time. **Free** — deterministic, no model, no API call
	 * — so when this is set the handler writes it and never looks anything up.
	 *
	 * Present only when the store gave a panel that survived `parseNutritionPanel`'s
	 * serving-size scaling and sanity gate. Null and absent both mean "no free
	 * figures", which is the `no macro` tag on the card.
	 */
	macros?: {
		proteinPer100g: number | null;
		fatsPer100g: number | null;
		carbsPer100g: number | null;
		fiberPer100g: number | null;
	} | null;
	/**
	 * The user pressed **+ Macros** before acting: go and find the figures even
	 * though it costs money (US$0.003–0.29 — see `macro-prompt.ts`).
	 *
	 * ⚠️ **Defaults to false, and that default is the point.** Nothing on the deals
	 * page may spend money unasked; the toggle is the asking. `macros` above is
	 * checked first, so a product whose shop published a panel costs nothing even
	 * with the toggle on.
	 */
	findMacros?: boolean;
	/**
	 * Pack-shot URLs for the paid lookup, already narrowed by `packShotsFor` on the
	 * page — so at most two, and never the front shot.
	 *
	 * Narrowed at build time rather than sent whole because this rides in a GitHub
	 * issue body a human reads before submitting, and four URLs of ~95 characters is
	 * noise in something meant to be checkable. The worker re-applies the same gate
	 * anyway, so a hand-edited payload cannot smuggle a front shot back in.
	 *
	 * Only useful when `findMacros` is set: with free panel figures present nothing is
	 * looked up, and with the toggle off nothing is looked up either.
	 */
	images?: string[];
}

const ACTIONS = new Set<ItemAction>([
	"reset",
	"park",
	"ignore-week",
	"mismatch",
	"almost",
	"ignore-product",
	"unpark",
	"add-ingredient",
	"replace-ingredient",
	"rebase-ingredient",
	"never-buy",
]);

/**
 * Actions that suppress or un-suppress an item by its base noun, and so cannot
 * work without `key`. The history-page actions are about a specific Notion row or
 * a specific product, not a base noun, so they carry no key and none is demanded
 * — requiring one there would mean the page inventing a value nothing reads.
 */
const NEEDS_KEY = new Set<ItemAction>(["reset", "park", "ignore-week", "mismatch", "almost"]);

/** How many words one tap may exclude — a guard on a hand-edited free-text field. */
const MAX_TERMS = 12;

/** Narrow an untrusted object (issue body / dispatch JSON) into an ActionPayload. */
export function parseActionPayload(raw: unknown): ActionPayload {
	const o = raw as Record<string, any>;
	if (!o || typeof o !== "object") throw new Error("payload is not an object");
	// `required` fields must be present and non-blank; optional ones simply default
	// to "" — a missing key is not an error there, which is the whole point of it
	// being optional.
	const str = (k: string, required = true): string => {
		const v = o[k];
		if (typeof v !== "string" || !v.trim()) {
			if (required) throw new Error(`payload.${k} must be a non-empty string`);
			return "";
		}
		return v;
	};
	const action = str("action") as ItemAction;
	if (!ACTIONS.has(action)) {
		throw new Error(`payload.action must be one of: ${[...ACTIONS].join(", ")}`);
	}

	// Terms arrive from a `prompt()` the user typed into, or from an issue body they
	// hand-edited, so they are cleaned here rather than trusted: blanks dropped,
	// duplicates collapsed, and a cap so a pasted paragraph can't blacklist an
	// entire aisle in one tap.
	const terms = Array.isArray(o.terms)
		? [
				...new Set(
					o.terms
						.filter((t: unknown) => typeof t === "string")
						.map((t: string) => t.replace(/\s+/g, " ").trim())
						.filter(Boolean),
				),
			].slice(0, MAX_TERMS)
		: [];
	if (action === "mismatch" && !terms.length) {
		throw new Error("payload.terms must list at least one word to exclude");
	}

	/**
	 * The free panel figures, re-validated rather than trusted.
	 *
	 * This arrives through a GitHub issue body a human can edit, so every figure is
	 * re-gated exactly as `parseNutritionPanel` gated it: a number in 0–100 g or
	 * nothing. An all-null set collapses to null so the handler sees "no free
	 * figures" rather than a row of nulls it would dutifully not write.
	 */
	const freeMacros = (v: unknown): ActionPayload["macros"] => {
		if (!v || typeof v !== "object") return null;
		const m = v as Record<string, unknown>;
		const g = (k: string): number | null => {
			const n = Number(m[k]);
			return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
		};
		const out = {
			proteinPer100g: g("proteinPer100g"),
			fatsPer100g: g("fatsPer100g"),
			carbsPer100g: g("carbsPer100g"),
			fiberPer100g: g("fiberPer100g"),
		};
		return Object.values(out).some((x) => x != null) ? out : null;
	};

	/** A number, or null. Blank and unparseable both mean "not supplied". */
	const num = (k: string): number | null => {
		const v = o[k];
		if (v == null || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};

	const payload: ActionPayload = {
		v: 1,
		action,
		key: str("key", NEEDS_KEY.has(action)),
		// A reset only needs the key, so an id-less payload is still usable; `park`
		// checks for it itself, where a missing id is a hard error.
		ingredientId: str("ingredientId", false),
		name: str("name", false),
		store: str("store", false),
		product: str("product", false),
		url: str("url", false),
		terms,
		note: str("note", false),
		purchaseId: str("purchaseId", false),
		priceSgd: num("priceSgd"),
		packSizeG: num("packSizeG"),
		volumetric: Boolean(o.volumetric),
		macros: freeMacros(o.macros),
		findMacros: Boolean(o.findMacros),
		// https only, deduped and capped. This arrives through an editable issue body,
		// and an image URL is fetched by the Anthropic API on our behalf — so it is
		// narrowed here as well as on the page. `packShotsFor` in the handler applies
		// the view gate on top.
		images: Array.isArray(o.images)
			? [...new Set(o.images.filter((u: unknown) => typeof u === "string" && /^https:\/\//i.test(u)))].slice(0, 4)
			: [],
	};

	// A block that can't recognise the product again would silently do nothing, so
	// it fails loudly instead. Either identity will do — see `isBlocked`.
	const blocksAProduct =
		action === "almost" || action === "ignore-product" || action === "never-buy";
	if (blocksAProduct && !payload.url && !(payload.store && payload.product)) {
		throw new Error("payload must name the product (url, or store + product)");
	}

	// The two Notion writes both act on one specific row. Without its id there is
	// nothing to write to, and guessing from the name is exactly the kind of
	// almost-right that edits the wrong ingredient.
	if (
		(action === "unpark" || action === "replace-ingredient" || action === "rebase-ingredient") &&
		!payload.ingredientId
	) {
		throw new Error(`payload.ingredientId is required for "${action}"`);
	}
	// Re-basing renames the row after the product, so without a product name it would
	// blank the title of an ingredient the user maintains by hand.
	if (action === "rebase-ingredient" && !payload.product) {
		throw new Error('payload.product is required for "rebase-ingredient"');
	}
	// A new Ingredients row needs at minimum something to call it. Price is checked
	// in the handler, where a missing one is a warning rather than a refusal.
	if (action === "add-ingredient" && !payload.product) {
		throw new Error('payload.product is required for "add-ingredient"');
	}

	return payload;
}
