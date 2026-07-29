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
	const t = d.target; // your ingredient (the "main item")
	const p = d.product; // the cheaper store product we found
	const u = bigUnit(p.volumetric); // "kg" (or "L" for liquids)
	const small = smallUnit(p.volumetric); // "100g" (or "100ml")

	// Pack-size brackets — same style, one per line.
	const itemPack = t.packSize > 0 ? ` <span class="pack">[${packLabel(t.packSize, p.volumetric)}]</span>` : "";
	const prodPack = p.packWeightG ? ` <span class="pack">[${packLabel(p.packWeightG, p.volumetric)}]</span>` : "";

	// Prices — build each piece once, then arrange them in the rows below.
	const myPrice = `$${t.packPriceSgd.toFixed(2)}`; // what you pay for your own pack
	const prodPrice = `$${p.priceSgd.toFixed(2)}`; // the found product's current price
	const baseKg = `$${(d.baselinePer100g * 10).toFixed(2)}/${u}`;
	const dealKg = `$${(d.productPer100g * 10).toFixed(2)}/${u}`;

	// Store sale as a % off its own list price (distinct from the green badge,
	// which is the saving vs YOUR price).
	const salePct =
		p.onSale && p.listPriceSgd && p.listPriceSgd > 0
			? Math.round(((p.listPriceSgd - p.priceSgd) / p.listPriceSgd) * 100)
			: null;
	const sale = salePct != null ? ` <span class="sale">🔻 on sale (−${salePct}%)</span>` : "";

	const usage =
		t.unitType === "By Unit" ? `${t.monthlyAmount} units` : amount(t.monthlyAmount, p.volumetric);

	return `
    <a class="card" href="${esc(p.url)}" target="_blank" rel="noopener">
      <!-- Row 1: your item [pack] + the price you pay (yellow), with the % saving -->
      <div class="row1">
        <span class="name">${esc(t.name)}${itemPack}
          <span class="mine">Price ${myPrice}</span></span>
        <span class="pct">−${d.savingPct.toFixed(0)}%</span>
      </div>
      <!-- Row 2: the cheaper product we found + its price + sale % (red) -->
      <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)}${prodPack} <span class="prodprice">${prodPrice}</span>${sale}</div>
      <!-- Row 3: product $/kg vs your $/kg (struck through) -->
      <div class="price"><b>${dealKg}</b> <span class="was">vs ${baseKg}</span></div>
      <!-- Row 4: how much of it you use -->
      ${t.inActivePlan ? `<div class="usage">uses ~${usage}/month</div>` : ""}
    </a>`;
}

export function renderDealsPage(
	planDeals: Deal[],
	otherDeals: Deal[],
	generatedAt = new Date(),
): string {
	const date = generatedAt.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
	const total = planDeals.length + otherDeals.length;

	// Store-discounted items float to the top as their own section, and are pulled
	// out of the plan/other lists below so each deal appears exactly once.
	const isSale = (d: Deal) => d.product.onSale;
	const saleDeals = [...planDeals, ...otherDeals]
		.filter(isSale)
		.sort((a, b) => b.savingPct - a.savingPct);
	const planRest = planDeals.filter((d) => !isSale(d));
	const otherRest = otherDeals.filter((d) => !isSale(d));

	const saleSection = saleDeals.length
		? `<h2 class="section">🔻 On sale now</h2>` + saleDeals.map(dealCard).join("")
		: "";

	// Plan section: the non-sale plan deals. If there were no plan deals at all,
	// show the celebratory note; if every plan deal is on sale (already shown
	// above), omit the section rather than render an empty/misleading heading.
	let planSection = "";
	if (planRest.length) {
		planSection = `<h2 class="section">In your plan</h2>` + planRest.map(dealCard).join("");
	} else if (planDeals.length === 0) {
		planSection =
			`<h2 class="section">In your plan</h2>` +
			`<p class="empty-sm">Nothing in your plan is cheaper today. 🎉</p>`;
	}

	const otherSection = otherRest.length
		? `<h2 class="section">Other items on offer</h2>` + otherRest.map(dealCard).join("")
		: "";
	const cards = saleSection + planSection + otherSection;

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
  .section { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 20px 2px 8px; }
  .empty-sm { color: #6b7280; font-size: .9rem; margin: 4px 2px 8px; }
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
  .mine { color: #ca8a04; font-size: .9rem; font-weight: 700; margin-left: 4px; white-space: nowrap; }
  .was { color: #9ca3af; text-decoration: line-through; font-size: .9rem; margin-left: 4px; }
  .meta { color: #6b7280; font-size: .85rem; margin-top: 4px; }
  .prodprice { color: #4b5563; font-weight: 600; }
  .usage { color: #6b7280; font-size: .85rem; margin-top: 2px; }
  .store { color: #1a1d21; font-weight: 600; }
  .sale { color: #b42318; font-weight: 600; }
  .empty { text-align: center; color: #6b7280; padding: 40px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    .sub, .pack, .meta, .per100, .usage, .section, .empty-sm { color: #9aa1ab; }
    .card { background: #171a1f; border-color: #262b32; box-shadow: none; }
    .pct { color: #6ee7b7; background: #06251a; }
    .store { color: #e5e7eb; }
    .was { color: #6b7280; }
    .mine { color: #facc15; }
    .prodprice { color: #cbd2dc; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>🛒 Grocery deals</h1>
    <p class="sub">${date} · ${total} deal${total === 1 ? "" : "s"} beating your prices</p>
    ${cards}
  </div>
</body>
</html>`;
}
