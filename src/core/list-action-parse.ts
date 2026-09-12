/**
 * Narrowing one tap from `list.html` into something safe to write with.
 *
 * ⚠️ **Its own module, apart from `list-action.ts`, because that script runs on import** —
 * it reads a payload and opens a Notion client at the top level. A test importing it to
 * check a parser would make a live API call, which is the one thing `src/tests/` does not
 * do (see `run.ts`).
 */

export type ListOp = "tick" | "untick" | "amount" | "add";

export interface ListActionPayload {
	v: 1;
	op: ListOp;
	/**
	 * The grocery-list row to act on — for `tick`, `untick` and `amount`.
	 *
	 * ⚠️ **Empty for `add`, which is creating a row that does not exist yet.** The two
	 * are kept in one payload shape because they travel the same path and the relay
	 * validates them together; the alternative is two near-identical endpoints.
	 */
	pageId: string;
	/** Required for `amount`; how many to add for `add`, defaulting to 1. */
	amount?: number;
	/**
	 * `add` only: the INGREDIENTS row this came from, so the new grocery row can point
	 * its relation at it and quote its price. Empty means a free-typed item with no
	 * match, which is written name-only — exactly what texting an unknown item does.
	 */
	ingredientId?: string;
	/** `add` only: what to call the row. The ingredient's own name, or what was typed. */
	name?: string;
}

/**
 * ⚠️ **This arrives from a browser over `repository_dispatch`, so it is checked rather
 * than trusted.** A bad `op` must fail loudly here rather than fall through to a no-op
 * that reports success, and `pageId` is shape-checked because it goes straight into
 * `pages.update` — a typo should not reach a write path.
 */
/** Notion ids are 32 hex digits, dashed or not. */
const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** What Add will accept as a name. Long enough to be an item, short enough to be a row title. */
export const MAX_ADD_NAME = 200;

export function parseListAction(raw: unknown): ListActionPayload {
	const o = raw as Record<string, any>;
	if (!o || typeof o !== "object") throw new Error("payload is not an object");
	const op = String(o.op ?? "");
	if (op !== "tick" && op !== "untick" && op !== "amount" && op !== "add") {
		throw new Error(`payload.op must be tick, untick, amount or add — got ${JSON.stringify(o.op)}`);
	}
	const amount = Number(o.amount);

	if (op === "add") {
		// ⚠️ **The name is required even with an ingredient id.** Resolving the id to a
		// title server-side would be a second Notion read on every tap, and the page
		// already knows the name it showed — using anything else would mean the row that
		// appears is not the row you picked.
		const name = String(o.name ?? "").trim();
		if (!name) throw new Error("payload.name is required for add");
		if (name.length > MAX_ADD_NAME) throw new Error(`payload.name is over ${MAX_ADD_NAME} characters`);
		const ingredientId = String(o.ingredientId ?? "").trim();
		// Empty is legitimate — a free-typed item with no match. A non-empty value that
		// is not an id is not, and must not reach a relation write.
		if (ingredientId && !NOTION_ID.test(ingredientId)) {
			throw new Error(`payload.ingredientId is not a Notion page id: ${JSON.stringify(o.ingredientId)}`);
		}
		if (o.amount != null && (!Number.isFinite(amount) || amount < 1)) {
			throw new Error(`payload.amount must be a number >= 1 — got ${JSON.stringify(o.amount)}`);
		}
		return {
			v: 1,
			op,
			pageId: "",
			name,
			ingredientId: ingredientId || undefined,
			amount: Number.isFinite(amount) && amount >= 1 ? Math.round(amount) : 1,
		};
	}

	const pageId = String(o.pageId ?? "").trim();
	if (!NOTION_ID.test(pageId)) {
		throw new Error(`payload.pageId is not a Notion page id: ${JSON.stringify(o.pageId)}`);
	}
	if (op === "amount" && (!Number.isFinite(amount) || amount < 1)) {
		throw new Error(`payload.amount must be a number >= 1 — got ${JSON.stringify(o.amount)}`);
	}
	return { v: 1, op, pageId, amount: Number.isFinite(amount) ? Math.round(amount) : undefined };
}
