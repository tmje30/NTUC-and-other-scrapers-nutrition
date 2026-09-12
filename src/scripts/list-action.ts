import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { commitAndPushData } from "../core/git-data-push.js";
import { GROCERY_LIST_DS, resolveListProps } from "../core/grocery-list.js";
import { parseListAction, type ListActionPayload } from "../core/list-action-parse.js";
import { PENDING_PATH, queue, readPending, unqueue, writePending } from "../core/list-pending.js";

/**
 * One tap on `list.html`, applied. **The privileged half of the shopping page.**
 *
 * ```
 *   tick   → Tickbox = true   + queued in data/list-pending.json (cleared at midnight SGT)
 *   untick → Tickbox = false  + taken back off the queue
 *   amount → Amount  = n
 * ```
 *
 * ⚠️ **Nothing here deletes anything.** A tick queues; `list-sweep` deletes at midnight,
 * after re-checking. Keeping the two apart is what makes the grace period real — a tick
 * that deleted immediately and "restored on undo" would be a delete with extra steps, and
 * Notion's trash is not somewhere an undo button should have to reach into.
 *
 * ⚠️ **`Amount ` is written but never validated against anything.** It is a shopping
 * quantity the user typed; the page floors it at 1 and so does this, and there is no
 * sensible upper bound to impose on "how many do you want".
 *
 * Usage:
 *   ACTION_PAYLOAD='{"payload":{...}}' npm run list-action   # what the workflow does
 *   npm run list-action -- --payload '{"v":1,"op":"tick","pageId":"…"}'
 *   npm run list-action -- --payload '…' --no-push
 */

const NO_PUSH = process.argv.includes("--no-push");

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function nonEmptyObject(json: string | undefined): unknown | null {
	if (!json || !json.trim()) return null;
	const parsed = JSON.parse(json);
	if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) return null;
	return parsed;
}

function readPayload(): ListActionPayload {
	const inline = argValue("--payload");
	if (inline) return parseListAction(JSON.parse(inline));
	const dispatched = nonEmptyObject(process.env.ACTION_PAYLOAD);
	// The page nests under `payload`, same as the deals page's buttons. Accept both.
	if (dispatched) return parseListAction((dispatched as any).payload ?? dispatched);
	throw new Error("no payload: pass --payload or set ACTION_PAYLOAD");
}

const payload = readPayload();
const client = new Client({ auth: config.notionToken() });

/**
 * **Add — a row typed into the page's search box.**
 *
 * ⚠️ **`addTextedItem`, the same call the Telegram intake makes**, so a row added from
 * the page and a row texted to the bot are indistinguishable in Notion: same title
 * shape, same relation, same dedupe-by-title that turns a second add into `Amount + 1`
 * rather than a duplicate line.
 *
 * ⚠️ **The price is read from the INGREDIENT, not sent by the page.** The page knows a
 * price — it is in `ingredients.json` — but that file is public and its figures are
 * whatever the last build published. Reading the row here means the new grocery line
 * quotes today's price book rather than a number a caller could simply assert.
 *
 * Handled before the `pages.retrieve` below because there is no row to retrieve yet.
 */
if (payload.op === "add") {
	const { addTextedItem } = await import("../core/grocery-list.js");
	const { readIngredientRows, pricePerKgLabelFor } = await import("../core/list-intake.js");

	let row = null;
	if (payload.ingredientId) {
		const all = await readIngredientRows(client);
		row = all.find((r) => r.pageId.replace(/-/g, "") === payload.ingredientId!.replace(/-/g, "")) ?? null;
		// ⚠️ A missing row is NOT a failure. The index is published daily and the user may
		// have renamed or retired the ingredient since; filing the line name-only is what
		// the Telegram intake does with an unmatched item, and beats refusing the add.
		if (!row) console.error(`Note: ingredient ${payload.ingredientId} is no longer in the DB — filing name-only.`);
	}

	const res = await addTextedItem(client, {
		ingredient: row?.name ?? payload.name!,
		ingredientId: row?.pageId,
		count: payload.amount ?? 1,
		priceSgd: row?.price?.sgd,
		vendor: row?.price?.vendor,
		pricePerKg: row ? pricePerKgLabelFor(row) : undefined,
	});
	console.error(
		res.alreadyListed
			? `Added: ${res.title} — already on the list, now ${res.amount}`
			: `Added: ${res.title}`,
	);
	process.exit(0);
}

const ds = (await client.dataSources.retrieve({ data_source_id: GROCERY_LIST_DS })) as any;
const props = resolveListProps(ds.properties ?? {});

const page = (await client.pages.retrieve({ page_id: payload.pageId })) as any;
const title =
	(page.properties?.[props.title]?.title ?? []).map((t: any) => t.plain_text).join("").trim() ||
	payload.pageId.slice(0, 8);

if (payload.op === "amount") {
	if (!props.amount) {
		// The documented "column is a formula, or gone" case. Say which, and stop —
		// silently succeeding would leave the page showing a number Notion never took.
		throw new Error("the grocery list has no writable Amount column — nothing changed");
	}
	await client.pages.update({
		page_id: payload.pageId,
		properties: { [props.amount]: { number: payload.amount! } },
	} as any);
	console.error(`Amount: ${title} → ${payload.amount}`);
	process.exit(0);
}

if (!props.done) throw new Error("the grocery list has no checkbox column — nothing to tick");

const ticking = payload.op === "tick";
await client.pages.update({
	page_id: payload.pageId,
	properties: { [props.done]: { checkbox: ticking } },
} as any);

const before = await readPending();
const after = ticking
	? queue(before, { pageId: payload.pageId, tickedAt: new Date().toISOString(), name: title })
	: unqueue(before, payload.pageId);

if (after.pending.length !== before.pending.length) {
	await writePending(after);
	console.error(
		ticking
			? `Ticked: ${title} — clears at midnight SGT (${after.pending.length} waiting)`
			: `Un-ticked: ${title} — taken off the deletion queue (${after.pending.length} waiting)`,
	);
	if (!NO_PUSH) {
		await commitAndPushData({
			file: PENDING_PATH,
			message: `list: ${ticking ? "ticked" : "un-ticked"} ${title}`,
			/**
			 * ⚠️ **Keep THEIRS and apply only this one row's change.** Two taps seconds
			 * apart each read the queue in their own checkout, and a run that wrote its
			 * whole copy over the remote would drop the other tap's entry — the row would
			 * stay on the list for ever, or worse, a queued deletion would silently
			 * vanish. Exactly the `tg-inbox-state.json` case; see `DataPushOptions`.
			 */
			reapply: (theirs) => {
				let base: typeof after;
				try {
					const parsed = theirs ? (JSON.parse(theirs) as typeof after) : null;
					base = { v: 1, pending: Array.isArray(parsed?.pending) ? parsed.pending : [] };
				} catch {
					// Upstream unparseable: our copy is the best version of the truth there is.
					return `${JSON.stringify(after, null, 2)}\n`;
				}
				const merged = ticking
					? queue(base, { pageId: payload.pageId, tickedAt: new Date().toISOString(), name: title })
					: unqueue(base, payload.pageId);
				return `${JSON.stringify(merged, null, 2)}\n`;
			},
		});
	}
} else {
	// Ticking an already-queued row keeps its original time (see `queue`), and
	// unticking something never queued is simply nothing to do.
	console.error(`${ticking ? "Ticked" : "Un-ticked"}: ${title} — queue unchanged.`);
}
