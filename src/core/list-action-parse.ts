/**
 * Narrowing one tap from `list.html` into something safe to write with.
 *
 * ⚠️ **Its own module, apart from `list-action.ts`, because that script runs on import** —
 * it reads a payload and opens a Notion client at the top level. A test importing it to
 * check a parser would make a live API call, which is the one thing `src/tests/` does not
 * do (see `run.ts`).
 */

export type ListOp = "tick" | "untick" | "amount";

export interface ListActionPayload {
	v: 1;
	op: ListOp;
	pageId: string;
	/** Required for `amount`, ignored otherwise. */
	amount?: number;
}

/**
 * ⚠️ **This arrives from a browser over `repository_dispatch`, so it is checked rather
 * than trusted.** A bad `op` must fail loudly here rather than fall through to a no-op
 * that reports success, and `pageId` is shape-checked because it goes straight into
 * `pages.update` — a typo should not reach a write path.
 */
export function parseListAction(raw: unknown): ListActionPayload {
	const o = raw as Record<string, any>;
	if (!o || typeof o !== "object") throw new Error("payload is not an object");
	const op = String(o.op ?? "");
	if (op !== "tick" && op !== "untick" && op !== "amount") {
		throw new Error(`payload.op must be tick, untick or amount — got ${JSON.stringify(o.op)}`);
	}
	const pageId = String(o.pageId ?? "").trim();
	// Notion ids are 32 hex digits, dashed or not.
	if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(pageId)) {
		throw new Error(`payload.pageId is not a Notion page id: ${JSON.stringify(o.pageId)}`);
	}
	const amount = Number(o.amount);
	if (op === "amount" && (!Number.isFinite(amount) || amount < 1)) {
		throw new Error(`payload.amount must be a number >= 1 — got ${JSON.stringify(o.amount)}`);
	}
	return { v: 1, op, pageId, amount: Number.isFinite(amount) ? Math.round(amount) : undefined };
}
