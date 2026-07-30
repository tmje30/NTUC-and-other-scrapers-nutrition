import { config } from "../core/config.js";
import { formatDeal } from "../core/telegram.js";
import type { Deal } from "../core/compare.js";

/** Send a couple of sample alerts in the real format (validates token + look). */

// Real deals from the last scan, used only to preview the message format.
const samples: Deal[] = [
	{
		target: { name: "Banana", unitType: "By Gram", monthlyAmount: 1500, monthlyPacks: 1.8 } as any,
		product: {
			store: "FairPrice",
			name: "Sumifru Philippines Banana",
			url: "https://www.fairprice.com.sg",
			onSale: false,
			listPriceSgd: null,
			volumetric: false,
			packWeightG: 700,
		} as any,
		dimension: "weight" as const,
		baseline: 0.535,
		productPrice: 0.364,
		saving: 0.171,
		savingPct: 32,
		monthlySavingSgd: 2.57,
	} as Deal,
	{
		target: { name: "Soy Sauce (light)", unitType: "By Gram", monthlyAmount: 300, monthlyPacks: 0.5 } as any,
		product: {
			store: "Sheng Siong",
			name: "Tiger Brand Light Soya Sauce",
			url: "https://shengsiong.com.sg",
			onSale: true,
			listPriceSgd: 2.9,
			volumetric: true,
			packWeightG: 640,
		} as any,
		dimension: "weight" as const,
		baseline: 0.617,
		productPrice: 0.25,
		saving: 0.367,
		savingPct: 59,
		monthlySavingSgd: 1.1,
	} as Deal,
	// A counted item, priced per piece — the other display path.
	{
		target: {
			name: "egg  (Omega 3 Enriched) (550g)",
			unitType: "By Unit",
			monthlyAmount: 140,
			monthlyPacks: 14,
		} as any,
		product: {
			store: "FairPrice",
			name: "Pasar Fresh Eggs",
			url: "https://www.fairprice.com.sg",
			onSale: false,
			listPriceSgd: null,
			volumetric: false,
			packWeightG: null,
			unitCount: 30,
		} as any,
		dimension: "unit" as const,
		baseline: 0.399,
		productPrice: 0.222,
		saving: 0.177,
		savingPct: 44,
		monthlySavingSgd: 24.78,
	} as Deal,
];

for (const d of samples) {
	const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken()}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: config.telegramChatId(),
			text: formatDeal(d),
			parse_mode: "HTML",
			disable_web_page_preview: true,
		}),
	});
	const body = await res.json();
	console.log(res.ok && body.ok ? "✅ Sent" : "❌ Failed", JSON.stringify(body).slice(0, 200));
}
