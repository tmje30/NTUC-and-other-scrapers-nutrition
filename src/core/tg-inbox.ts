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
	pricePerKgLabelFor,
	readIngredientRows,
	type IngredientRow,
} from "./list-intake.js";
import { addTextedItem } from "./grocery-list.js";
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

/** One near-miss awaiting a Yes/No tap. */
interface PendingAsk {
	item: ParsedItem;
	rowId: string;
	rowName: string;
	score: number;
	/** The prompt message, so its buttons can be replaced with the outcome. */
	messageId: number;
	chatId: number;
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

	// Ask about the near-misses one message at a time, so each answer is
	// unambiguous — a single message with six pairs of buttons is a mis-tap
	// waiting to happen, and a mis-tap here points a relation at the wrong row.
	for (const d of decisions) {
		if (d.verdict !== "ask" || !d.match) continue;
		const t = token(state.pending);
		const keyboard: InlineKeyboard = [
			[
				{ text: "✅ Yes, that's it", data: `y:${t}` },
				{ text: "🆕 No, it's new", data: `n:${t}` },
			],
		];
		const messageId = await sendHtml(
			`❓ <b>${esc(d.item.name)}</b> — did you mean <b>${esc(d.match.row.name)}</b>?` +
				` <i>(${Math.round(d.match.score * 100)}% match)</i>`,
			{ keyboard },
		);
		state.pending[t] = {
			item: d.item,
			rowId: d.match.row.pageId,
			rowName: d.match.row.name,
			score: d.match.score,
			messageId,
			chatId,
		};
	}

	if (!Object.keys(state.pending).length) await drainQueue(deps, state);
}

/** Handle one button tap. */
async function handleCallback(
	deps: InboxDeps,
	state: InboxState,
	cb: NonNullable<TgUpdate["callback_query"]>,
): Promise<void> {
	const [verb, t] = (cb.data ?? "").split(":");
	const ask = t ? state.pending[t] : undefined;

	// Acknowledge first, always. Telegram spins the button until this lands, so a
	// stale token must still clear the spinner rather than leaving it turning.
	if (!ask) {
		await answerCallback(cb.id, "That question has already been answered.");
		return;
	}
	await answerCallback(cb.id);
	delete state.pending[t];

	if (verb === "y") {
		let outcome: string;
		try {
			// Re-looked-up rather than taken from the pending record: a confirmation
			// can sit unanswered for hours, and the price quoted on the list should be
			// the one on the row now. A row deleted in the meantime falls back to the
			// name we asked about, so the item still lands on the list.
			const row = (await rows(deps)).find((r) => r.pageId === ask.rowId) ?? {
				pageId: ask.rowId,
				name: ask.rowName,
				searchTerm: ask.rowName,
				unitType: "By Gram" as const,
				price: null,
			};
			outcome = await writeItem(deps, ask.item, row);
		} catch (e: any) {
			outcome = `❌ ${esc(ask.item.name)} — ${esc(e.message)}`;
		}
		await editHtml(ask.messageId, outcome, { chatId: String(ask.chatId) });
	} else {
		state.queue.push(ask.item);
		await editHtml(ask.messageId, `🆕 ${esc(ask.item.name)} — treating as new`, {
			chatId: String(ask.chatId),
		});
	}

	if (!Object.keys(state.pending).length) await drainQueue(deps, state);
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
		}
		// After handling, never before: an offset advanced early loses the message.
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
