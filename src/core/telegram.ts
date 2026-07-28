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
	// Price per kg, or per L for volumetric (liquid) items. per-100 × 10.
	const bigUnit = p.volumetric ? "L" : "kg";
	const prodBig = deal.productPer100g * 10;
	const baseBig = deal.baselinePer100g * 10;

	const usage =
		t.unitType === "By Gram" ? formatAmount(t.monthlyAmount, p.volumetric) : `${t.monthlyAmount} units`;
	const sale = p.onSale
		? p.listPriceSgd
			? ` · 🔻 was $${p.listPriceSgd.toFixed(2)}`
			: " · 🔻 on sale"
		: "";

	const pack = p.packWeightG ? ` [${packLabel(p.packWeightG, p.volumetric)}]` : "";

	// The ingredient name is the link to the store product.
	return (
		`🛒 <a href="${p.url}"><b>${esc(t.name)}</b></a>${pack}  −${deal.savingPct.toFixed(0)}% at <b>${esc(p.store)}</b>\n` +
		`<b>$${prodBig.toFixed(2)}/${bigUnit}</b> vs $${baseBig.toFixed(2)} · uses ~${usage}/month\n` +
		`<i>${esc(p.name)}</i>${sale}`
	);
}

async function sendMessage(text: string): Promise<void> {
	const token = config.telegramBotToken();
	const chatId = config.telegramChatId();
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: "HTML",
			disable_web_page_preview: true,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Telegram sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
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

/** Single daily message: "N deals today → tap to view", linking to the page. */
export async function sendSummary(count: number, url: string): Promise<void> {
	if (count <= 0) return; // nothing to say on a no-deal day
	const text =
		`🛒 <b>${count} grocery deal${count === 1 ? "" : "s"}</b> beat your prices today.\n` +
		`<a href="${url}">Tap to view →</a>`;
	await sendMessage(text);
}
