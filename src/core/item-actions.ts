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

/** `reset` un-snoozes now; `park` retires the ingredient in Notion as well. */
export type ItemAction = "reset" | "park";

export interface ActionPayload {
	v: 1;
	action: ItemAction;
	/** Base-noun cooldown key to clear (see `cooldownKey`). */
	key: string;
	/** Notion page id of the ingredient — required by `park`, traceability for `reset`. */
	ingredientId: string;
	/** The ingredient's display name, for the log and the issue comment. */
	name: string;
}

const ACTIONS = new Set<ItemAction>(["reset", "park"]);

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
	return {
		v: 1,
		action,
		key: str("key"),
		// A reset only needs the key, so an id-less payload is still usable; `park`
		// checks for it itself, where a missing id is a hard error.
		ingredientId: str("ingredientId", false),
		name: str("name", false),
	};
}
