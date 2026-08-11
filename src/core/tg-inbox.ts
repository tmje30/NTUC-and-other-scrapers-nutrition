import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "./config.js";
import {
	answerCallback,
	editHtml,
	escapeHtml as esc,
	getUpdates,
	sendHtml,
	type InlineKeyboard,
	type TgUpdate,
} from "./telegram.js";
import { parseList, sizeLabel, type ParsedItem } from "./list-parse.js";
import {
	decideList,
	nextCandidates,
	pricePerKgLabelFor,
	readIngredientRows,
	type IngredientRow,
	type RowMatch,
} from "./list-intake.js";
import { addTextedItem } from "./grocery-list.js";
import { categorize } from "./categorize.js";
import { createIngredient, type IngredientFields } from "./ingredient-write.js";
import { unparkIngredient } from "./park.js";
import { PARKED_TAG } from "./notion.js";
import { scanNewItems, type NewItemResult } from "./new-items.js";

/**
 * The Telegram inbox: text a grocery list, get it filed into Notion.
 *
 * ```
 *   "2kg chicken breast          parse → match → ┬─ known  → write the grocery-list row
 *    1L milk                                     ├─ unsure → ask, with buttons
 *    harissa paste"                              └─ new    → scan the shops, publish a page
 * ```
 *
 * ⚠️ **This is the first inbound path in the project.** Everything before it was
 * outbound (a daily digest) or a button on a static page that routed through a
 * GitHub issue. So it is also the first place where something the user typed
 * reaches a Notion write, and the guards below exist for that reason:
 *
 *  • **Chat allow-list.** The bot token is shared with the user's Notion Worker
 *    bot. Anything from a chat other than the configured one is dropped without
 *    a reply — an unknown sender must not be able to write to the grocery list,
 *    and must not learn that the bot is listening either.
 *  • **The offset is persisted AFTER handling, not before.** Telegram treats a
 *    fetch at an offset as an acknowledgement of everything before it, so
 *    advancing early loses a message on a crash and never advancing replays it
 *    forever. A crash mid-batch therefore re-runs the batch, which the grocery
 *    list's own title dedupe absorbs (`findOpenRow`).
 *  • **Nothing here starts a paid lookup.** No macro call, no model call. See
 *    "Nothing spends money unasked" in HANDOVER — a texted list is exactly the
 *    kind of ordinary action that must not quietly cost 40 cents.
 */

/** Machine-local, gitignored (`.sessions/` holds session-shaped state already). */
const STATE_PATH = ".sessions/tg-inbox.json";

/** One row on offer, as it sits on the keyboard. */
export interface AskCandidate {
	rowId: string;
	rowName: string;
	score: number;
	/** Tagged `Not in Use ATM` — shown with a 💤, and un-parked if picked. */
	parked?: boolean;
}

/** One question awaiting a tap. */
interface PendingAsk {
	item: ParsedItem;
	/** The rows currently on the keyboard, in button order. */
	candidates: AskCandidate[];
	/**
	 * Every row already offered and passed over. Re-search never offers these
	 * again — being shown the same wrong answer twice is how a user learns to stop
	 * reading the buttons.
	 */
	rejected: string[];
	/** The prompt message, so its buttons can be replaced with the outcome. */
	messageId: number;
	chatId: number;
	/**
	 * Whether the shop scan must wait for this answer.
	 *
	 * ⚠️ A **near-miss** blocks: until it is answered we do not know whether the
	 * item is new at all, and scanning the shops for something that turns out to be
	 * the milk you already buy is wasted work on a page nobody wants. An offer on
	 * an item already ruled **new** does not block — it is only asking whether to
	 * file it, and holding a whole batch's pricing behind an optional question is
	 * how the new-items page would stop appearing.
	 */
	blocking: boolean;
	/** Set once the user has asked to create a row and been shown what that means. */
	awaitingCreate?: boolean;
}

export interface InboxState {
	/** Next `getUpdates` offset — always `last update_id + 1`. */
	offset: number;
	pending: Record<string, PendingAsk>;
	/** New items accumulated across a batch, scanned once nothing is pending. */
	queue: ParsedItem[];
}

const EMPTY_STATE: InboxState = { offset: 0, pending: {}, queue: [] };

export async function readState(path = STATE_PATH): Promise<InboxState> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8"));
		return {
			offset: Number(raw?.offset) || 0,
			pending: raw?.pending && typeof raw.pending === "object" ? raw.pending : {},
			queue: Array.isArray(raw?.queue) ? raw.queue : [],
		};
	} catch {
		return { ...EMPTY_STATE };
	}
}

export async function writeState(state: InboxState, path = STATE_PATH): Promise<void> {
	await mkdir(".sessions", { recursive: true });
	await writeFile(path, JSON.stringify(state), "utf8");
}

/**
 * A short opaque token for a button.
 *
 * Telegram caps `callback_data` at 64 bytes, so the ask itself is held in the
 * state file and only this key travels. Collisions are avoided by checking the
 * live pending map rather than by making the token long — there are never more
 * than a handful outstanding.
 */
function token(pending: Record<string, PendingAsk>): string {
	let t = "";
	do {
		t = Math.random().toString(36).slice(2, 8);
	} while (pending[t]);
	return t;
}

const HELP =
	"🛒 <b>Text me your grocery list</b>\n" +
	"One item per line, or comma-separated. Quantities optional:\n" +
	"<code>2kg chicken breast\n1L milk\nbananas x6\nharissa paste</code>\n\n" +
	"I'll match each line to your Ingredients DB and add it to the grocery List " +
	"with its price. Anything I'm unsure about I'll ask. Anything new, I'll price " +
	"at the shops and send you a page.";

/** Format one written row for the reply. */
function wroteLine(name: string, count: number, price?: string): string {
	const qty = count > 1 ? ` ×${count}` : "";
	return `✅ ${esc(name)}${qty}${price ? ` · ${esc(price)}` : ""}`;
}

/**
 * What the poller needs from its host to publish a new-items page.
 *
 * Injected rather than imported so the core has no `child_process` or git
 * knowledge: the laptop script owns committing and dispatching, exactly as
 * `push-shengsiong.ts` does for the Sheng Siong file.
 */
export interface Publisher {
	/** Commit + push the results file and ask the cloud to rebuild the site. */
	publish(results: NewItemResult[]): Promise<void>;
}

export interface InboxDeps {
	notion: Client;
	publisher?: Publisher;
	/** Overridable for testing; defaults to the live shop scan. */
	scan?: (items: ParsedItem[]) => Promise<NewItemResult[]>;
}

/**
 * The Ingredients DB, cached for a minute.
 *
 * Re-read rather than held for the process lifetime because the user may add a
 * row in Notion and immediately text the thing they just added — a poller that
 * cached at startup would keep calling it new for as long as the laptop stayed
 * awake. A minute is short enough that that never happens and long enough that a
 * six-line list is one query rather than six.
 */
let rowCache: { at: number; rows: IngredientRow[] } | null = null;
const ROW_TTL_MS = 60_000;

async function rows(deps: InboxDeps): Promise<IngredientRow[]> {
	if (rowCache && Date.now() - rowCache.at < ROW_TTL_MS) return rowCache.rows;
	const fresh = await readIngredientRows(deps.notion);
	rowCache = { at: Date.now(), rows: fresh };
	return fresh;
}

/** Write one matched (or unmatched-but-confirmed) item to the grocery List. */
async function writeItem(
	deps: InboxDeps,
	item: ParsedItem,
	row: IngredientRow | null,
): Promise<string> {
	const res = await addTextedItem(deps.notion, {
		// The MATCHED row's name when there is one: the list should read in the
		// user's own naming standard, not in whatever they thumbed into the phone.
		ingredient: row?.name ?? item.name,
		ingredientId: row?.pageId,
		count: item.count,
		size: sizeLabel(item),
		priceSgd: row?.price?.sgd,
		vendor: row?.price?.vendor,
		pricePerKg: row ? pricePerKgLabelFor(row) : undefined,
	});
	const price = row?.price ? `$${row.price.sgd.toFixed(2)} ${row.price.vendor}` : undefined;
	const line = wroteLine(res.title, item.count, price);
	return res.alreadyListed ? `${line} <i>(now ${res.amount})</i>` : line;
}

/**
 * Scan the queued new items, publish, and report. Called once the batch has no
 * unanswered questions left — so an item the user just told us was NOT a match
 * gets scanned along with the rest rather than in a second, separate page.
 */
async function drainQueue(deps: InboxDeps, state: InboxState): Promise<void> {
	const queue = state.queue;
	state.queue = [];
	if (!queue.length) return;

	const names = queue.map((i) => i.name);
	await sendHtml(`🔎 Pricing ${queue.length} new item${queue.length === 1 ? "" : "s"}: ${esc(names.join(", "))}…`);

	const scan = deps.scan ?? scanNewItems;
	let results: NewItemResult[];
	try {
		results = await scan(queue);
	} catch (e: any) {
		await sendHtml(`⚠️ Couldn't price the new items: ${esc(e.message)}`);
		return;
	}

	// A short summary in the chat AND the page: the summary answers "did it find
	// anything" without leaving Telegram, which for one or two items is the whole
	// question. The page is where the comparison is readable.
	const lines = results.map((r) => {
		if (!r.offers.length) return `• ${esc(r.query)} — not found`;
		const best = r.offers[0];
		const per = best.pricePer100g
			? ` ($${(best.pricePer100g * 10).toFixed(2)}/${best.volumetric ? "L" : "kg"})`
			: "";
		return `• ${esc(r.query)} — <b>$${best.priceSgd.toFixed(2)}</b>${per} at ${esc(best.store)}`;
	});
	await sendHtml(lines.join("\n"));

	if (!deps.publisher) return;
	try {
		await deps.publisher.publish(results);
		await sendHtml(`📄 <a href="${config.siteUrl()}new-items.html">New items page →</a>`);
	} catch (e: any) {
		await sendHtml(`⚠️ Priced them, but couldn't publish the page: ${esc(e.message)}`);
	}
}

/** Handle one text message. */
async function handleMessage(
	deps: InboxDeps,
	state: InboxState,
	text: string,
	chatId: number,
): Promise<void> {
	const trimmed = text.trim();
	if (/^\/(start|help)\b/i.test(trimmed)) {
		await sendHtml(HELP);
		return;
	}

	const items = parseList(trimmed);
	if (!items.length) {
		await sendHtml("I couldn't read any items in that. Send /help for the format.");
		return;
	}

	let known: IngredientRow[];
	try {
		known = await rows(deps);
	} catch (e: any) {
		await sendHtml(`⚠️ Couldn't read your Ingredients DB: ${esc(e.message)}`);
		return;
	}

	const decisions = decideList(items, known);
	const written: string[] = [];
	const failed: string[] = [];

	for (const d of decisions) {
		if (d.verdict === "linked" && d.match) {
			try {
				written.push(await writeItem(deps, d.item, d.match.row));
			} catch (e: any) {
				failed.push(`❌ ${esc(d.item.name)} — ${esc(e.message)}`);
			}
		} else if (d.verdict === "new") {
			state.queue.push(d.item);
		}
	}

	const reply = [...written, ...failed];
	if (reply.length) await sendHtml(reply.join("\n"));

	// Ask one message at a time, so each answer is unambiguous — a single message
	// with six sets of buttons is a mis-tap waiting to happen, and a mis-tap here
	// points a relation at the wrong row and quotes that row's price.
	for (const d of decisions) {
		if (d.verdict === "ask" && d.candidates.length) {
			await ask(state, d.item, chatId, toCandidates(d.candidates), { blocking: true });
		} else if (d.verdict === "new") {
			// An item nothing matched is queued for pricing AND offered a home. Until
			// 2026-08-11 it was only queued, so texting something you don't stock got
			// you a comparison on a web page and nothing on the list you shop from —
			// see fault 30.
			await ask(state, d.item, chatId, [], { blocking: false });
		}
	}

	await maybeDrain(deps, state);
}

/** `RowMatch`es as the keyboard stores them. */
function toCandidates(matches: RowMatch[]): AskCandidate[] {
	return matches.map((m) => ({
		rowId: m.row.pageId,
		rowName: m.row.name,
		score: m.score,
		parked: m.row.parked || undefined,
	}));
}

/**
 * The keyboard for one question: a button per candidate row, then the two ways
 * out.
 *
 * ⚠️ **One candidate per ROW of the keyboard, never two side by side.** These
 * labels are ingredient names — `Chicken thigh, Boneless [Seara]` beside
 * `chicken soup cube` — and Telegram shrinks the text to fit, so a two-column
 * layout is two truncated names on a phone and a coin flip between two different
 * foods.
 */
export function askKeyboard(t: string, candidates: AskCandidate[]): InlineKeyboard {
	const keyboard: InlineKeyboard = candidates.map((c, i) => [
		// 💤 marks a row you parked. It is on the button rather than in the message
		// because that is where the decision is made — picking it un-parks the row.
		{ text: `${c.parked ? "💤 " : ""}${c.rowName} · ${Math.round(c.score * 100)}%`, data: `p:${t}:${i}` },
	]);
	keyboard.push([{ text: "🔎 No — re-search", data: `r:${t}` }]);
	keyboard.push([{ text: "🆕 New item — create in Ingredients", data: `c:${t}` }]);
	// ⚠️ **Always last, and always present.** This is the typo escape (asked for by
	// the user, 2026-08-11): a mistyped line should cost one tap to forget, not a
	// trip to Notion to delete a row and a page to un-publish. Its position matters
	// as much as its existence — the destructive-looking button sits furthest from
	// the candidates, so a fat thumb aiming at the last ingredient cannot reach it.
	keyboard.push([{ text: "✖️ Cancel — typo", data: `d:${t}` }]);
	return keyboard;
}

/** The question above the keyboard. */
function askText(item: ParsedItem, candidates: AskCandidate[]): string {
	return candidates.length
		? `❓ <b>${esc(item.name)}</b> — which of these did you mean?`
		: `🆕 <b>${esc(item.name)}</b> — nothing in your Ingredients looks like this.` +
				` I'll price it at the shops either way.`;
}

/** Send one question and record it as pending. */
async function ask(
	state: InboxState,
	item: ParsedItem,
	chatId: number,
	candidates: AskCandidate[],
	opts: { blocking: boolean },
): Promise<void> {
	const t = token(state.pending);
	const messageId = await sendHtml(askText(item, candidates), { keyboard: askKeyboard(t, candidates) });
	state.pending[t] = {
		item,
		candidates,
		rejected: candidates.map((c) => c.rowId),
		messageId,
		chatId,
		blocking: opts.blocking,
	};
}

/**
 * Price the queue once nothing is left that could change what is in it.
 *
 * ⚠️ Gated on **blocking** questions, not on `pending` being empty. A new item's
 * "shall I file this?" offer stays live for as long as the user leaves it, and
 * waiting for that would mean a batch containing one unfamiliar item never gets
 * priced at all.
 */
async function maybeDrain(deps: InboxDeps, state: InboxState): Promise<void> {
	if (Object.values(state.pending).some((a) => a.blocking)) return;
	await drainQueue(deps, state);
}

/**
 * Stop Telegram's button spinner. **Cosmetic, and it may never gate the work.**
 *
 * ⚠️ **This is fault 29, seen live on 2026-08-10:**
 *
 * ```
 * update 523965592 failed: answerCallbackQuery HTTP 400:
 *   "Bad Request: query is too old and response timeout expired…"
 * ```
 *
 * The user tapped a button while no poller was running. By the time one started,
 * Telegram had expired the query id; the `await` threw, `handleCallback` aborted
 * **before** the Notion write, and `pumpOnce` advanced the offset anyway — so the
 * answer was consumed and lost, and the chat showed a question that had been
 * answered and a row that never appeared. A spinner nobody is watching any more is
 * worth nothing; the write is worth everything. Failing here is now a logged
 * shrug.
 */
async function ack(id: string, text?: string): Promise<void> {
	try {
		await answerCallback(id, text);
	} catch (e: any) {
		// Expected whenever the tap is older than Telegram's callback window.
		console.error(`answerCallback failed (cosmetic, carrying on): ${e?.message ?? e}`);
	}
}

/** Handle one button tap. */
async function handleCallback(
	deps: InboxDeps,
	state: InboxState,
	cb: NonNullable<TgUpdate["callback_query"]>,
): Promise<void> {
	const [verb, t, arg] = (cb.data ?? "").split(":");
	const pending = t ? state.pending[t] : undefined;

	// Acknowledge first, always. Telegram spins the button until this lands, so a
	// stale token must still clear the spinner rather than leaving it turning.
	if (!pending) {
		await ack(cb.id, "That question has already been answered.");
		return;
	}
	await ack(cb.id);

	const edit = (text: string, keyboard?: InlineKeyboard) =>
		editHtml(pending.messageId, text, { chatId: String(pending.chatId), keyboard });
	/** Settle the question: its buttons become its outcome and cannot be tapped again. */
	const settle = async (text: string) => {
		delete state.pending[t];
		await edit(text);
	};

	switch (verb) {
		case "p": {
			// One of the offered rows. This is also the answer to "which one" — the
			// tie that fault 28 used to resolve by whichever row Notion listed first.
			const chosen = pending.candidates[Number(arg)];
			if (!chosen) {
				await settle(`⚠️ ${esc(pending.item.name)} — that option is no longer available.`);
				break;
			}
			// An item ruled `new` was queued for pricing when it arrived; linking it to
			// a row it turns out we already have means it must come back out, or it is
			// priced as a new item on a page while sitting on the list as a known one.
			state.queue = state.queue.filter((q) => q.raw !== pending.item.raw);
			let outcome: string;
			try {
				// Re-looked-up rather than taken from the pending record: a question can
				// sit unanswered for hours, and the price quoted on the list should be
				// the one on the row now. A row deleted in the meantime falls back to the
				// name we asked about, so the item still lands on the list.
				const row = (await rows(deps)).find((r) => r.pageId === chosen.rowId) ?? {
					pageId: chosen.rowId,
					name: chosen.rowName,
					searchTerm: chosen.rowName,
					unitType: "By Gram" as const,
					parked: false,
					price: null,
				};
				outcome = await writeItem(deps, pending.item, row);
				outcome += await unparkIfNeeded(deps, row);
			} catch (e: any) {
				outcome = `❌ ${esc(pending.item.name)} — ${esc(e.message)}`;
			}
			await settle(outcome);
			break;
		}

		case "r": {
			// "No — re-search": a different ingredient that is similar (the user's own
			// words, 2026-08-11). It looks again at the INGREDIENTS DB, not at the
			// shops — the shops are what the new-items page is for.
			let next: AskCandidate[] = [];
			try {
				next = toCandidates(nextCandidates(pending.item.name, await rows(deps), pending.rejected));
			} catch (e: any) {
				await edit(`⚠️ Couldn't re-read your Ingredients DB: ${esc(e.message)}`, askKeyboard(t, pending.candidates));
				break;
			}
			if (!next.length) {
				// The buttons stay: "nothing else close" is an answer about the DB, not
				// the end of the question — creating the row is still on the table.
				pending.candidates = [];
				await edit(
					`🔎 <b>${esc(pending.item.name)}</b> — nothing else in your Ingredients comes close.`,
					askKeyboard(t, []),
				);
				break;
			}
			pending.candidates = next;
			pending.rejected = [...pending.rejected, ...next.map((c) => c.rowId)];
			await edit(
				`🔎 <b>${esc(pending.item.name)}</b> — how about one of these?`,
				askKeyboard(t, next),
			);
			break;
		}

		case "c": {
			// Creating a row is the one action here with no undo, in a live personal
			// workspace, so it shows exactly what it is about to write and asks again —
			// the same courtesy *Not in use* and *Replace* extend on the deals page.
			const fields = newIngredientFields(pending.item);
			pending.awaitingCreate = true;
			await edit(
				`➕ Create <b>${esc(fields.name)}</b> in Ingredients?\n` +
					// The category shown is this project's own key. The Notion OPTION is
					// resolved from the live list at write time and dropped if it isn't
					// there — this tool never invents schema — so the row can legitimately
					// land uncategorised even though a guess is quoted here.
					`<i>${esc(fields.categoryKey ?? "uncategorised")} · ${esc(fields.unitType ?? "—")}</i>\n` +
					`It'll go on your grocery list too. No price yet — the shop scan fills that in.`,
				[
					[{ text: "✅ Yes, create it", data: `k:${t}` }],
					[{ text: "✖ Cancel", data: `x:${t}` }],
				],
			);
			break;
		}

		case "k": {
			if (!pending.awaitingCreate) break; // a stale confirm button; ignore quietly
			let outcome: string;
			try {
				outcome = await createAndList(deps, pending.item);
			} catch (e: any) {
				outcome = `❌ ${esc(pending.item.name)} — ${esc(e.message)}`;
			}
			await settle(outcome);
			break;
		}

		case "x":
			// Backing out of the create CONFIRM, not out of the item. It returns to
			// the question rather than settling it: "no, I didn't mean create" is not
			// the same statement as "forget this line", and there is now a Cancel
			// button that means the second one.
			pending.awaitingCreate = false;
			await edit(askText(pending.item, pending.candidates), askKeyboard(t, pending.candidates));
			break;

		case "d":
			// The typo escape. Nothing has been written for this item — a near-miss is
			// only ever written once answered — so dropping it really is a no-op, and
			// the only thing to undo is its place in the pricing queue.
			state.queue = state.queue.filter((q) => q.raw !== pending.item.raw);
			await settle(`✖️ ${esc(pending.item.raw)} — dropped. Nothing written.`);
			break;

		default:
			await settle(`⚠️ ${esc(pending.item.name)} — I didn't understand that button.`);
	}

	await maybeDrain(deps, state);
}

/**
 * Wake a parked row that the user has just picked, and say so.
 *
 * ⚠️ **Buying something is the un-park.** `Not in Use ATM` means "don't show me
 * this for now", and putting the item on your list is the plainest possible
 * statement that "for now" is over — leaving the tag on would keep the ingredient
 * out of the daily deal scan for a thing sitting on the shopping list.
 *
 * ⚠️ It is only ever reached from an explicit tap, never from a silent link —
 * `decideItem` refuses to link a parked row however well it scores, precisely so
 * this write cannot happen by accident.
 *
 * ⚠️ `unparkIngredient` removes **only** that one tag and refuses outright on a
 * row that also carries `Don't Search`. Failing to wake a row must not lose the
 * list line that was already written, so a failure here is reported, not thrown.
 */
async function unparkIfNeeded(deps: InboxDeps, row: IngredientRow): Promise<string> {
	if (!row.parked) return "";
	try {
		const res = await unparkIngredient(deps.notion, row.pageId);
		rowCache = null; // the row's tags changed; don't answer from a stale copy
		if (res.blockedBy) return `\n<i>Left parked — it also carries ${esc(res.blockedBy)}.</i>`;
		return `\n<i>💤 → awake: removed ${esc(PARKED_TAG)}.</i>`;
	} catch (e: any) {
		return `\n<i>⚠️ Couldn't un-park it: ${esc(e.message)}</i>`;
	}
}

/**
 * What a texted item becomes as an Ingredients row.
 *
 * ⚠️ **The marker is `{New}`, in BRACES, and the brackets are not
 * interchangeable** (the user chose this on 2026-08-11 from three options).
 * `parseName` reads `( )` as a **defining property** — a hard requirement on the
 * product title — so a row called `(New) Harissa Paste` would demand the word
 * "new" from every candidate at every shop, match nothing, and appear in no
 * section of the deals page, all while looking perfectly ordinary in Notion.
 * `{ }` is the ignored bracket: excluded from the search term and from every
 * matching decision, which is exactly this job. It marks the row as unreviewed to
 * a human and is invisible to the scan.
 *
 * No price and no size are written. Both belong to a vendor slot, and a slot
 * holding a size with no price and no shop is not a price book entry — it is a
 * half-fact that `readBaseline` would have to step over. The shop scan fills
 * them in properly.
 */
export function newIngredientFields(item: ParsedItem): IngredientFields {
	const key = categorize(item.name);
	return {
		name: `{New} ${item.name.trim()}`,
		categoryKey: key,
		unitType: unitTypeFor(item),
	};
}

/**
 * `Unit type ` from what the user actually typed — the same inference
 * `fieldsFromPurchase` makes from a pack: a stated volume is `By ml`, a stated
 * weight is `By Gram`, and a bare count is `By Unit`.
 *
 * An item with no quantity at all ("harissa paste") gets `By Gram`, the type most
 * groceries have. ⚠️ Getting this wrong is not silent — it is visible on the row
 * and one dropdown to correct — which is why it guesses rather than asking.
 */
export function unitTypeFor(item: ParsedItem): string {
	if (item.amountG != null) return item.volumetric ? "By ml" : "By Gram";
	return item.count > 1 ? "By Unit" : "By Gram";
}

/**
 * Create the Ingredients row, then put the item on the grocery list against it.
 *
 * The second half is the point of the whole button: fault 30 was that a new item
 * got a price comparison on a web page and never reached the list you shop from.
 */
async function createAndList(deps: InboxDeps, item: ParsedItem): Promise<string> {
	const fields = newIngredientFields(item);
	const res = await createIngredient(deps.notion, fields);
	// The cache would otherwise keep calling this row new for up to a minute — and
	// the same list, re-sent, would offer to create it a second time.
	rowCache = null;
	const row: IngredientRow = {
		pageId: res.id,
		name: fields.name,
		searchTerm: item.name,
		unitType: fields.unitType as IngredientRow["unitType"],
		parked: false,
		price: null,
	};
	const listed = await writeItem(deps, item, row);
	const skipped = res.skipped.length ? `\n<i>Not written: ${esc(res.skipped.join("; "))}</i>` : "";
	return `➕ Created <b>${esc(row.name)}</b> in Ingredients\n${listed}${skipped}`;
}

/**
 * Drain whatever Telegram has, handling each update and persisting after each.
 * Returns how many updates were processed.
 */
export async function pumpOnce(
	deps: InboxDeps,
	state: InboxState,
	timeoutSec = 25,
): Promise<number> {
	const allowed = String(config.telegramChatId());
	const updates = await getUpdates(state.offset, timeoutSec);
	for (const u of updates) {
		try {
			if (u.message?.text && String(u.message.chat.id) === allowed) {
				await handleMessage(deps, state, u.message.text, u.message.chat.id);
			} else if (u.callback_query && String(u.callback_query.message?.chat.id) === allowed) {
				await handleCallback(deps, state, u.callback_query);
			}
			// Anything else — another chat, a photo, a sticker — is dropped in silence.
		} catch (e: any) {
			console.error(`update ${u.update_id} failed: ${e?.stack ?? e}`);
			// ⚠️ **Say so in the chat.** The offset still advances (see below), so
			// this update is gone — and the whole point of fault 29 was that a
			// swallowed update looks exactly like a handled one from the sofa. One
			// line to a console nobody is watching is not a report. Wrapped because
			// the thing that just failed may well be Telegram itself.
			try {
				await sendHtml(`⚠️ I dropped that one — ${esc(e?.message ?? String(e))}. Please send it again.`);
			} catch {
				/* the chat is unreachable too; the console line is all there is */
			}
		}
		// After handling, never before: an offset advanced early loses the message.
		//
		// ⚠️ **It advances even when the handler threw, and that is deliberate.**
		// The alternative — retry until it succeeds — turns one poison update into
		// an infinite loop that blocks every message behind it, which is a worse
		// failure than losing one line of a shopping list. The user is told instead,
		// above, and can send it again.
		state.offset = u.update_id + 1;
		await writeState(state);
	}
	return updates.length;
}

/** Long-poll forever (or once, for a scheduled short-lived run). */
export async function runInbox(deps: InboxDeps, opts: { once?: boolean } = {}): Promise<void> {
	const state = await readState();
	do {
		try {
			await pumpOnce(deps, state);
		} catch (e: any) {
			// A network blip must not kill a long-running poller. Back off and retry.
			console.error(`poll failed: ${e.message}`);
			if (opts.once) throw e;
			await new Promise((r) => setTimeout(r, 5000));
		}
	} while (!opts.once);
}
