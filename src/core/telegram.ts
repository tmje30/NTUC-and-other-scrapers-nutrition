import { config } from "./config.js";
import type { Deal } from "./compare.js";

/**
 * Telegram alerts. One message per qualifying deal (per PRD), containing:
 * item + store, per-100g saving (amount + %), deal note if on sale, monthly
 * usage, and a link. Uses the free Telegram Bot API over HTTPS.
 */

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format an amount (grams, or ml for volumetric): 1500 → "1.5 kg" / "1.5 L". */
function formatAmount(n: number, volumetric: boolean): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} ${big}` : `${Math.round(n)} ${small}`;
}

/** Compact pack-size label for the "[700g]" tag: no space, e.g. "700g", "1.5kg", "640ml", "2L". */
function packLabel(n: number, volumetric: boolean): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return n >= 1000 ? `${+(n / 1000).toFixed(2)}${big}` : `${Math.round(n)}${small}`;
}

export function formatDeal(deal: Deal): string {
	const t = deal.target;
	const p = deal.product;
	// Price per kg, or per L for volumetric (liquid) items. per-100 × 10. A deal
	// compared by the piece prices "each" instead — see the note in compare.ts.
	const byPiece = deal.dimension === "unit";
	const prodPrice = byPiece
		? `$${deal.productPrice.toFixed(3)} each`
		: `$${(deal.productPrice * 10).toFixed(2)}/${p.volumetric ? "L" : "kg"}`;
	const basePrice = byPiece
		? `$${deal.baseline.toFixed(3)}`
		: `$${(deal.baseline * 10).toFixed(2)}`;

	const usage =
		t.unitType === "By Unit" ? `${t.monthlyAmount} units` : formatAmount(t.monthlyAmount, p.volumetric);
	const sale = p.onSale
		? p.listPriceSgd
			? ` · 🔻 was $${p.listPriceSgd.toFixed(2)}`
			: " · 🔻 on sale"
		: "";

	const pack = byPiece
		? p.unitCount
			? ` [${p.unitCount} pcs]`
			: ""
		: p.packWeightG
			? ` [${packLabel(p.packWeightG, p.volumetric)}]`
			: "";

	// The ingredient name is the link to the store product.
	return (
		`🛒 <a href="${p.url}"><b>${esc(t.name)}</b></a>${pack}  −${deal.savingPct.toFixed(0)}% at <b>${esc(p.store)}</b>\n` +
		`<b>${prodPrice}</b> vs ${basePrice} · uses ~${usage}/month\n` +
		`<i>${esc(p.name)}</i>${sale}`
	);
}

/** HTML-escape a value before it goes into a Telegram `parse_mode: HTML` message. */
export const escapeHtml = esc;

/**
 * One low-level Bot API call. Every method goes through here so the token, the
 * error shape and the "Telegram answered 200 with ok:false" case are handled in
 * exactly one place — the API does not use HTTP status alone to report failure.
 */
export async function callTelegram<T = any>(method: string, body: unknown): Promise<T> {
	const token = config.telegramBotToken();
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text().catch(() => "");
	if (!res.ok) throw new Error(`Telegram ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`Telegram ${method}: unparseable reply ${text.slice(0, 120)}`);
	}
	if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? "not ok"}`);
	return json.result as T;
}

/** One row of inline-keyboard buttons; `data` comes back as a `callback_query`. */
export type InlineKeyboard = { text: string; data: string }[][];

function markup(keyboard?: InlineKeyboard) {
	if (!keyboard?.length) return undefined;
	return {
		inline_keyboard: keyboard.map((row) =>
			row.map((b) => ({ text: b.text, callback_data: b.data })),
		),
	};
}

async function sendMessage(text: string): Promise<void> {
	await sendHtml(text);
}

/**
 * Send an HTML message, optionally with buttons. Returns the message id so a
 * later edit can replace the buttons with the outcome — a confirmation prompt
 * that stays tappable after it's been answered invites a second, contradictory tap.
 */
export async function sendHtml(
	text: string,
	opts: { keyboard?: InlineKeyboard; chatId?: string } = {},
): Promise<number> {
	const msg = await callTelegram<{ message_id: number }>("sendMessage", {
		chat_id: opts.chatId ?? config.telegramChatId(),
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		reply_markup: markup(opts.keyboard),
	});
	return msg.message_id;
}

/** Replace a message's text (and drop its buttons unless new ones are given). */
export async function editHtml(
	messageId: number,
	text: string,
	opts: { keyboard?: InlineKeyboard; chatId?: string } = {},
): Promise<void> {
	await callTelegram("editMessageText", {
		chat_id: opts.chatId ?? config.telegramChatId(),
		message_id: messageId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		reply_markup: markup(opts.keyboard),
	});
}

/**
 * Acknowledge a button tap. Telegram shows a spinner on the button until this is
 * called, so it must happen even on a path that then fails — an unacknowledged
 * tap looks to the user like the bot hung.
 */
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
	await callTelegram("answerCallbackQuery", { callback_query_id: callbackId, text });
}

/** A Telegram update, narrowed to the two kinds this bot acts on. */
export interface TgUpdate {
	update_id: number;
	message?: {
		message_id: number;
		chat: { id: number };
		from?: { id: number };
		text?: string;
	};
	callback_query?: {
		id: string;
		from: { id: number };
		data?: string;
		message?: { message_id: number; chat: { id: number } };
	};
}

/**
 * Long-poll for updates. `timeoutSec` is Telegram's own hold-open time: the call
 * blocks server-side until something arrives or the timeout elapses, which is why
 * this costs nothing to run continuously and still responds in about a second.
 *
 * ⚠️ `offset` must be `last update_id + 1`. Telegram treats a fetch at a given
 * offset as an acknowledgement of everything before it, so an offset that is
 * never advanced replays the same message forever, and one advanced before the
 * work is done loses it on a crash. `tg-inbox.ts` persists it after handling.
 */
export async function getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
	return await callTelegram<TgUpdate[]>("getUpdates", {
		offset,
		timeout: timeoutSec,
		allowed_updates: ["message", "callback_query"],
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one message per deal. Returns count sent. (Legacy; the page flow uses sendSummary.) */
export async function sendDeals(deals: Deal[]): Promise<number> {
	let sent = 0;
	for (const deal of deals) {
		await sendMessage(formatDeal(deal));
		sent++;
		await sleep(400); // stay under Telegram rate limits
	}
	return sent;
}

/**
 * Single daily message: "N deals today → tap to view", linking to the page.
 *
 * A `warning` (a shop missing from the scan) is worth a message on its own, even
 * on a day with no deals: silence is what a broken runner looks like, and the
 * whole point is that it should stop looking like a quiet day.
 */
export async function sendSummary(count: number, url: string, warning?: string): Promise<void> {
	if (count <= 0 && !warning) return; // nothing to say on an ordinary no-deal day
	const headline =
		count > 0
			? `🛒 <b>${count} grocery deal${count === 1 ? "" : "s"}</b> beat your prices today.`
			: `🛒 No deals beat your prices today.`;
	const warn = warning ? `\n⚠️ ${esc(warning)}` : "";
	await sendMessage(`${headline}${warn}\n<a href="${url}">Tap to view →</a>`);
}
