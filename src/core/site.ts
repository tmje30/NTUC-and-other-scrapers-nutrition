import type { Deal } from "./compare.js";

/**
 * Renders the daily deals as a self-contained HTML page (deployed to GitHub
 * Pages). One Telegram message links here, keeping the chat to a single message.
 */

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function bigUnit(v: boolean) {
	return v ? "L" : "kg";
}
function smallUnit(v: boolean) {
	return v ? "100ml" : "100g";
}
function packLabel(n: number, v: boolean): string {
	const big = v ? "L" : "kg";
	const small = v ? "ml" : "g";
	return n >= 1000 ? `${+(n / 1000).toFixed(2)}${big}` : `${Math.round(n)}${small}`;
}
function amount(n: number, v: boolean): string {
	const big = v ? "L" : "kg";
	const small = v ? "ml" : "g";
	return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)} ${big}` : `${Math.round(n)} ${small}`;
}

function dealCard(d: Deal): string {
	const t = d.target;
	const p = d.product;
	const u = bigUnit(p.volumetric);
	const pack = p.packWeightG ? ` <span class="pack">[${packLabel(p.packWeightG, p.volumetric)}]</span>` : "";
	const usage = t.unitType === "By Gram" ? amount(t.monthlyAmount, p.volumetric) : `${t.monthlyAmount} units`;
	const sale = p.onSale
		? `<span class="sale">🔻 on sale${p.listPriceSgd ? ` (was $${p.listPriceSgd.toFixed(2)})` : ""}</span>`
		: "";
	return `
    <a class="card" href="${esc(p.url)}" target="_blank" rel="noopener">
      <div class="row1">
        <span class="name">${esc(t.name)}${pack}</span>
        <span class="pct">−${d.savingPct.toFixed(0)}%</span>
      </div>
      <div class="price"><b>$${(d.productPer100g * 10).toFixed(2)}/${u}</b>
        <span class="per100">· $${d.productPer100g.toFixed(2)}/${smallUnit(p.volumetric)}</span>
        <span class="was">vs $${(d.baselinePer100g * 10).toFixed(2)}/${u}</span></div>
      <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)} ${sale}</div>
      <div class="usage">uses ~${usage}/month</div>
    </a>`;
}

export function renderDealsPage(deals: Deal[], generatedAt = new Date()): string {
	const date = generatedAt.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
	const cards = deals.length
		? deals.map(dealCard).join("")
		: `<p class="empty">No deals beat your prices today. 🎉</p>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Grocery deals · ${date}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f6f8; color: #1a1d21; padding: 16px; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 8px 2px 2px; }
  .sub { color: #6b7280; font-size: .85rem; margin: 0 2px 16px; }
  .card { display: block; text-decoration: none; color: inherit; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04); transition: transform .05s ease; }
  .card:active { transform: scale(.995); }
  .row1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .name { font-weight: 650; font-size: 1.05rem; }
  .pack { color: #6b7280; font-weight: 500; font-size: .9rem; }
  .pct { color: #067647; font-weight: 700; background: #ecfdf3; border-radius: 8px; padding: 1px 8px; white-space: nowrap; }
  .price { margin-top: 3px; }
  .price b { font-size: 1.05rem; }
  .per100 { color: #6b7280; font-size: .9rem; }
  .was { color: #9ca3af; text-decoration: line-through; font-size: .9rem; margin-left: 4px; }
  .meta { color: #6b7280; font-size: .85rem; margin-top: 4px; }
  .usage { color: #6b7280; font-size: .85rem; margin-top: 2px; }
  .store { color: #1a1d21; font-weight: 600; }
  .sale { color: #b42318; font-weight: 600; }
  .empty { text-align: center; color: #6b7280; padding: 40px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    .sub, .pack, .meta, .per100, .usage { color: #9aa1ab; }
    .card { background: #171a1f; border-color: #262b32; box-shadow: none; }
    .pct { color: #6ee7b7; background: #06251a; }
    .store { color: #e5e7eb; }
    .was { color: #6b7280; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>🛒 Grocery deals</h1>
    <p class="sub">${date} · ${deals.length} deal${deals.length === 1 ? "" : "s"} beating your prices</p>
    ${cards}
  </div>
</body>
</html>`;
}
