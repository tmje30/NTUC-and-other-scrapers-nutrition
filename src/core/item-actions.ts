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
 * The five things a button can ask for:
 *
 *   reset        un-snooze now
 *   park         retire the ingredient in Notion as well
 *   ignore-week  don't search this until the start of next week
 *   mismatch     never match these words for this item again
 *   almost       block this one product for this item
 *
 * The last three come from the menu under a card's percentage, so they carry the
 * product that was on screen as well as the item.
 */
export type ItemAction = "reset" | "park" | "ignore-week" | "mismatch" | "almost";

export interface ActionPayload {
	v: 1;
	action: ItemAction;
	/** Base-noun cooldown key to clear (see `cooldownKey`). */
	key: string;
	/** Notion page id of the ingredient — required by `park`, traceability for `reset`. */
	ingredientId: string;
	/** The ingredient's display name, for the log and the issue comment. */
	name: string;
	/** The store the card was showing. Evidence on `mismatch`, identity on `almost`. */
	store?: string;
	/** The product name the card was showing. */
	product?: string;
	/** The product's page URL — how `almost` recognises it again. */
	url?: string;
	/** Words to stop matching, for `mismatch`. Suggested by the page, edited by the user. */
	terms?: string[];
	/** Free-text reason, for `almost` ("not pasteurized"). */
	note?: string;
}

const ACTIONS = new Set<ItemAction>(["reset", "park", "ignore-week", "mismatch", "almost"]);

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

	const payload: ActionPayload = {
		v: 1,
		action,
		key: str("key"),
		// A reset only needs the key, so an id-less payload is still usable; `park`
		// checks for it itself, where a missing id is a hard error.
		ingredientId: str("ingredientId", false),
		name: str("name", false),
		store: str("store", false),
		product: str("product", false),
		url: str("url", false),
		terms,
		note: str("note", false),
	};

	// A block that can't recognise the product again would silently do nothing, so
	// it fails loudly instead. Either identity will do — see `isBlocked`.
	if (action === "almost" && !payload.url && !(payload.store && payload.product)) {
		throw new Error("payload must name the product (url, or store + product)");
	}
	return payload;
}
