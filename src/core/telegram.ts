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

export function formatDeal(deal: Deal): string {
	const t = deal.target;
	const p = deal.product;
	// Show price per kg, or per L for volumetric (liquid) items. per-100 × 10.
	const bigUnit = p.volumetric ? "L" : "kg";
	const prodBig = deal.productPer100g * 10;
	const baseBig = deal.baselinePer100g * 10;

	const usage =
		t.unitType === "By Gram" ? formatAmount(t.monthlyAmount, p.volumetric) : `${t.monthlyAmount} units`;
	const saleLine = p.onSale
		? `\n🔻 On sale now${p.listPriceSgd ? ` (usually $${p.listPriceSgd.toFixed(2)})` : ""}`
		: "";

	return (
		`🛒 <b>${esc(t.name)}</b> is cheaper at <b>${esc(p.store)}</b>\n` +
		`${esc(p.name)}\n` +
		`<b>$${prodBig.toFixed(2)}/${bigUnit}</b> vs your $${baseBig.toFixed(2)}/${bigUnit} ` +
		`(<b>−${deal.savingPct.toFixed(0)}%</b>)\n` +
		`<i>$${deal.productPer100g.toFixed(3)}/100${p.volumetric ? "ml" : "g"} vs $${deal.baselinePer100g.toFixed(3)}</i>${saleLine}\n` +
		`You use ~${usage}/mo (${t.monthlyPacks.toFixed(1)} packs) → save ~<b>$${deal.monthlySavingSgd.toFixed(2)}/mo</b>\n` +
		`<a href="${p.url}">View product →</a>`
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
			disable_web_page_preview: false,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Telegram sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one message per deal. Returns count sent. */
export async function sendDeals(deals: Deal[]): Promise<number> {
	let sent = 0;
	for (const deal of deals) {
		await sendMessage(formatDeal(deal));
		sent++;
		await sleep(400); // stay under Telegram rate limits
	}
	return sent;
}
