import type { MovesSnapshot } from "./vendor-review.js";
import type { PriceMove } from "./vendor-scan.js";

/**
 * **`moves.html` — the fifth page.** What the last sweep changed in the price book.
 *
 * ⚠️ **This replaces a long Telegram message, not a short one.** `renderPriceMoves`
 * built a list of up to nineteen lines, each carrying two prices, two pack sizes and two
 * per-unit figures — a table pretending to be a sentence. On a phone it wrapped into a
 * wall of text that is read once and never referred back to. The user asked for it as a
 * page (2026-09-03); the message keeps the headline and a link, which is the same
 * "one message, one page" shape as the deals page and the review queue.
 *
 * ⚠️ **A reduction and a first price are different news and are not mixed.** A row that
 * has never had a price at this shop is the gap the price book exists to close — the
 * 2026-08-11 report found 49 rows tagged Sheng Siong with no price between them — so the
 * two get their own sections rather than one list you have to read the middle of to sort.
 *
 * ⚠️ **No buttons.** Everything here is already written; there is nothing to decide. The
 * page that asks questions is `review.html`, and mixing the two would make a page of
 * settled facts look like a page of chores.
 */

const esc = (s: unknown): string =>
	String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface MovesPageOptions {
	generatedAt?: Date;
}

const per = (n: number, word: string) => `$${n.toFixed(2)}/${word}`;

/**
 * How much cheaper, as a percentage of the old price.
 *
 * ⚠️ Computed from `pricePer1000`, never from the pack price, because the pack can change
 * size underneath a movement: Tau Kwa went $1.40 → $1.40 while the pack went 400g → 500g,
 * which is a 20% cut that a pack-price comparison reports as no change at all.
 */
function drop(m: PriceMove): number | null {
	if (m.recordedPer1000 == null || m.recordedPer1000 <= 0) return null;
	return Math.round((1 - m.foundPer1000 / m.recordedPer1000) * 100);
}

/**
 * ⚠️⚠️ **The whole card is the link to the shop, and the product is named.** A row
 * name says what was wanted; it does not say what the shop actually sold. On this project
 * those differ constantly — `Milk (Fresh) (Normal)` held Bandung Rose Milk, Farmhouse UHT
 * and Greenfields inside one week, and the page reported three price movements without
 * ever saying the product had changed underneath them. Same reasoning as `review.html`:
 * you cannot check a price without seeing the thing it is for.
 *
 * ⚠️ A snapshot with no URL renders as a plain card, never a dead link.
 */
function shell(m: PriceMove, inner: string, tag: string): string {
	const head = `<div class="hd"><span class="ing">${esc(m.row.trim())}</span><span class="shop">${esc(m.vendor)}</span></div>
  ${inner}
  ${m.product ? `<div class="prod">${esc(m.product)}${m.url ? ' <span class="go">↗</span>' : ""}</div>` : ""}
  ${tag}`;
	return m.url
		? `<article class="card"><a class="body" href="${esc(m.url)}" target="_blank" rel="noopener">${head}</a></article>`
		: `<article class="card">${head}</article>`;
}

function cheaperCard(m: PriceMove): string {
	const d = drop(m);
	return shell(
		m,
		`<div class="move">
    <span class="was">${esc(m.recordedText)} <i>= ${esc(per(m.recordedPer1000!, m.perWord))}</i></span>
    <span class="arrow">→</span>
    <span class="now"><b>${esc(m.foundText)}</b> <i>= ${esc(per(m.foundPer1000, m.perWord))}</i></span>
  </div>`,
		d != null && d > 0 ? `<div class="tag down">${d}% cheaper</div>` : "",
	);
}

function firstCard(m: PriceMove): string {
	return shell(
		m,
		`<div class="move"><span class="now"><b>${esc(m.foundText)}</b> <i>= ${esc(per(m.foundPer1000, m.perWord))}</i></span></div>`,
		`<div class="tag new">first price at this shop</div>`,
	);
}
export function renderMovesPage(snapshot: MovesSnapshot | null, o: MovesPageOptions = {}): string {
	const moves = snapshot?.moves ?? [];
	const reconfirmed = snapshot?.reconfirmed ?? 0;
	const cheaper = moves.filter((m) => m.recordedPer1000 != null);
	const first = moves.filter((m) => m.recordedPer1000 == null);
	const when = snapshot?.generatedAt
		? new Date(snapshot.generatedAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })
		: (o.generatedAt ?? new Date()).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });

	const headline = [
		cheaper.length ? `${cheaper.length} price${cheaper.length === 1 ? "" : "s"} got cheaper` : "",
		first.length ? `${first.length} newly recorded` : "",
	]
		.filter(Boolean)
		.join(" · ");

	// ⚠️ The empty state is rendered, not skipped — same reason as `review.html`. The
	// message links here unconditionally, and a 404 reads as broken while "nothing
	// changed" reads as a sweep that ran and found the book already correct.
	const body = moves.length
		? [
				cheaper.length ? `<h2>Cheaper than what was recorded</h2>\n${cheaper.map(cheaperCard).join("\n")}` : "",
				first.length ? `<h2>Newly recorded</h2>\n${first.map(firstCard).join("\n")}` : "",
			]
				.filter(Boolean)
				.join("\n")
		: `<p class="empty">Nothing moved. Every price the last sweep found was the one already recorded.</p>`;

	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Price book changes</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#111; --mut:#666; --line:#e3e3e3; --card:#fafafa; --ok:#0a7d32; --new:#1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --bg:#131313; --fg:#eee; --mut:#9a9a9a; --line:#2c2c2c; --card:#1b1b1b; --ok:#4ade80; --new:#93b4fd; } }
* { box-sizing:border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:720px; margin-inline:auto; }
h1 { font-size:1.25rem; margin:0 0 4px; }
h2 { font-size:.82rem; text-transform:uppercase; letter-spacing:.05em; color:var(--mut);
  margin:22px 0 10px; font-weight:600; }
.sub { color:var(--mut); font-size:.85rem; margin:0 0 6px; }
.note { color:var(--mut); font-size:.82rem; border-left:3px solid var(--line); padding:6px 10px; margin:0 0 8px; }
.card { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:12px 14px; margin-bottom:10px; }
.hd { display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap; }
.ing { font-weight:600; }
.shop { color:var(--mut); font-size:.8rem; white-space:nowrap; }
.move { margin:8px 0 0; display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; font-size:.95rem; }
.was { color:var(--mut); text-decoration:line-through; text-decoration-thickness:1px; }
.arrow { color:var(--mut); }
.move i { font-style:normal; color:var(--mut); font-size:.86rem; }
.now b { font-size:1.02rem; }
.tag { display:inline-block; margin-top:8px; font-size:.76rem; font-weight:600;
  border:1px solid currentColor; border-radius:999px; padding:2px 9px; }
.tag.down { color:var(--ok); }
.tag.new { color:var(--new); }
.prod { font-size:.88rem; opacity:.85; margin-top:8px; word-break:break-word; }
.go { opacity:.55; }
.body { display:block; color:inherit; text-decoration:none; border-radius:8px; margin:-4px -6px; padding:4px 6px; }
.body:hover, .body:focus-visible { background:rgba(128,128,128,.09); outline:none; }
.empty { color:var(--mut); }
.foot { color:var(--mut); font-size:.82rem; margin-top:20px; }
</style></head>
<body>
<h1>Price book changes</h1>
<p class="sub">${esc(headline || "nothing moved")} · ${esc(when)}</p>
<p class="note">What the last sweep wrote into <b>Vendor 1&ndash;4</b>. These are shelf prices, not
offers &mdash; a discount belongs on the deals page. Nothing here needs a decision; the page that
asks is <b>Prices to check</b>.</p>
${body}
${reconfirmed ? `<p class="foot">${reconfirmed} other${reconfirmed === 1 ? "" : "s"} re-confirmed unchanged.</p>` : ""}
</body></html>`;
}
