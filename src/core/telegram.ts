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
/**
 * Which bot this process talks as. Null = the outbound bot from `TELEGRAM_BOT_TOKEN`.
 *
 * Set once at startup by the inbox poller (`tg-poll.ts`), because a poller is a
 * separate process that only ever acts as the inbox bot — its replies should come
 * from the same bot the user texted, not from the digest bot. Threading a token
 * argument through every send/edit/answer call would put the same decision in a
 * dozen places and get it wrong in one of them.
 */
let tokenOverride: string | null = null;

/** Point every subsequent Bot API call in this process at a different bot. */
export function useBotToken(token: string): void {
	tokenOverride = token;
}

export async function callTelegram<T = any>(method: string, body: unknown): Promise<T> {
	const token = tokenOverride ?? config.telegramBotToken();
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
 * One item that needs a weight typed into its Notion name before it can be
 * compared. The structured form of `findWeightGap`, as carried in summary.json.
 */
export interface WeightGapNote {
	/** The Notion row's name, exactly as the user will see it when they go to edit it. */
	name: string;
	store: string;
	/** The shop's own pack size, as an example of the format. May be null. */
	size: number | null;
	/** The shop's figure is millilitres, not grams. */
	volumetric: boolean;
}

/** How many to name before summarising the rest. Three fits a phone notification. */
const MAX_GAPS_SHOWN = 3;

/**
 * The "add a weight to the name" lines.
 *
 * Phrased as an instruction with a worked example, because that is the whole
 * value: the user asked for this so they would know *what to type*. `(600g)`
 * shown literally, with the brackets, since the brackets are the convention
 * `packWeightOf` actually reads.
 */
export function formatWeightGaps(gaps: WeightGapNote[]): string {
	if (!gaps.length) return "";
	const shown = gaps.slice(0, MAX_GAPS_SHOWN);
	const lines = shown.map((g) => {
		// ⚠️ "e.g." is load-bearing. This is the SHOP's pack, not necessarily the one
		// bought, and the row's name is shared by all four vendor slots — so it is an
		// illustration of the format and must not read as the number to enter.
		const eg = g.size ? ` — e.g. <code>${esc(g.name)} (${g.size}${g.volumetric ? "ml" : "g"})</code>` : "";
		return `• <b>${esc(g.name)}</b>: ${esc(g.store)} sells these by ${g.volumetric ? "volume" : "weight"}, but the row has no ${g.volumetric ? "volume" : "weight"} to compare against. Add one to the name${eg}`;
	});
	const rest = gaps.length - shown.length;
	const more = rest > 0 ? `\n• …and ${rest} more item${rest === 1 ? "" : "s"} need one too.` : "";
	return `\n\n📏 <b>Needs a size in the name to be compared:</b>\n${lines.join("\n")}${more}`;
}

/**
 * Single daily message: "N deals today → tap to view", linking to the page.
 *
 * A `warning` (a shop missing from the scan) is worth a message on its own, even
 * on a day with no deals: silence is what a broken runner looks like, and the
 * whole point is that it should stop looking like a quiet day.
 *
 * ⚠️ **`gaps` deliberately do NOT earn a message of their own.** Unlike a warning,
 * a missing weight is not a fault that appeared today — it is a standing property
 * of the row, true again tomorrow and every day until the user edits Notion. On
 * its own it would become a daily nag for a chore already noted, which is how a
 * useful signal turns into one that gets muted. It rides along with a message that
 * was being sent anyway, which is exactly what was asked for: mentioned *in* the
 * discounts text.
 */
export async function sendSummary(
	count: number,
	url: string,
	warning?: string,
	gaps: WeightGapNote[] = [],
): Promise<void> {
	if (count <= 0 && !warning) return; // nothing to say on an ordinary no-deal day
	const headline =
		count > 0
			? `🛒 <b>${count} grocery deal${count === 1 ? "" : "s"}</b> beat your prices today.`
			: `🛒 No deals beat your prices today.`;
	const warn = warning ? `\n⚠️ ${esc(warning)}` : "";
	await sendMessage(`${headline}${warn}\n<a href="${url}">Tap to view →</a>${formatWeightGaps(gaps)}`);
}
