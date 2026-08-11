import { reasonsFor, type PendingReview, type ReviewReason } from "./vendor-review.js";
import { cooldownKey } from "./cooldown.js";
import { parseName } from "./parse.js";

/**
 * **`review.html` — the fourth page.** Every price the scan is unsure about, on one page.
 *
 * ⚠️ **This replaces one Telegram card per pick, and the reason is not taste.** The first
 * live NTUC + Sheng Siong write queued **16** uncertain picks and sent 16 separate
 * messages (2026-08-11). Sixteen notifications for one scan is not a review queue, it is
 * a reason to mute the bot — and a muted bot loses the daily digest too. The project
 * already had the right shape everywhere else: **one message, one page**.
 *
 * The buttons use the same path as the deals page — a pre-filled GitHub issue carrying a
 * JSON payload, gated on the `Item: ` title prefix and the `grocery-add` label, handled by
 * `item-action.ts`. No new mechanism, no server, and it works from a phone.
 *
 * ⚠️ **The payload carries the whole pick, not just its token.** A token would mean the
 * action had to find the record in `data/vendor-review.json`, which makes the button
 * depend on the laptop having committed its queue before you tap. Carrying the price,
 * size, URL and item name means the tap records exactly what the page showed you — which
 * is also the only honest thing for a button quoting a price to do.
 */

const esc = (s: unknown): string =>
	String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ReviewPageOptions {
	/** `owner/repo`, for the issue links. */
	repo: string;
	generatedAt?: Date;
}

/** How the row's `Size[Vendor n]` reads. */
function unitWord(unitType: string): string {
	return unitType === "By Unit" ? " pcs" : unitType === "By ml" ? "ml" : "g";
}

/**
 * ⚠️ The reason a pick is here is the whole point of the card — a bulk pack and a
 * marketplace rescue are completely different questions and must not look alike.
 */
function reasonList(reasons: ReviewReason[]): string {
	if (!reasons.length) return "";
	return `<ul class="why">${reasons.map((r) => `<li class="r-${esc(r.kind)}">${esc(r.note)}</li>`).join("")}</ul>`;
}

function button(
	p: PendingReview,
	o: ReviewPageOptions,
	ui: { action: string; label: string; done: string; cls: string; prose: string; reason?: string },
): string {
	const payload = {
		v: 1,
		action: ui.action,
		token: p.token,
		ingredientId: p.ingredientId,
		name: p.ingredientName,
		// ⚠️ Required by `parseActionPayload` for `review-skip` — a block with no base
		// noun would silently apply to nothing. The fallback re-derives it from the row
		// name so questions queued before this field existed still answer correctly,
		// rather than failing at the moment the user taps.
		key: p.key || cooldownKey(parseName(p.ingredientName).searchTerm),
		vendor: p.vendor,
		priceSgd: p.priceSgd,
		size: p.size,
		url: p.url,
		itemName: p.itemName,
		why: p.reasons.map((r) => r.note).join("; "),
		...(ui.reason ? { reason: ui.reason } : {}),
	};
	const body = `${ui.prose}\n\n` + "```json\n" + `${JSON.stringify(payload, null, 2)}\n` + "```\n";
	const href =
		`https://github.com/${o.repo}/issues/new` +
		`?title=${encodeURIComponent(`Item: ${ui.label} — ${p.ingredientName} @ ${p.vendor}`)}` +
		`&labels=grocery-add` +
		`&body=${encodeURIComponent(body)}`;
	return `<a class="act ${ui.cls}" href="${esc(href)}" target="_blank" rel="noopener"
        data-payload="${esc(JSON.stringify(payload))}" data-event="item-action"
        data-done="${esc(ui.done)}"
        aria-label="${esc(`${ui.label} — ${p.ingredientName} at ${p.vendor}`)}">${esc(ui.label)}</a>`;
}

/**
 * ⚠️ **"Don't use" asks WHY, and it is a `<details>` rather than a `<select>`.**
 *
 * A dropdown's value only reaches the action through JavaScript, and these buttons must
 * keep working as plain links — that is the whole reason they are pre-filled GitHub
 * issues. A disclosure holding one link per reason needs no script, degrades to nothing
 * worse than an extra tap, and records the reason in the payload itself.
 *
 * Each reason routes somewhere (see `REJECT_REASONS`): the pack-size ones re-search
 * preferring a nearer size, `wrong-item` stops this product being offered for this row,
 * and `bad-price` is filed as a parser fault rather than a shopping decision.
 */
function rejectMenu(p: PendingReview, o: ReviewPageOptions): string {
	const items = reasonsFor(p).map((r) =>
		button(p, o, {
			action: "review-skip",
			reason: r.key,
			label: r.label,
			done: "✕ skipped",
			cls: "no small",
			prose:
				`NOT recording this pack for **${p.ingredientName}** at **${p.vendor}**.\n\n` +
				`Reason: **${r.label}** — _${r.hint}_.\n\n` +
				(r.research ? `Please look again for a closer match at this shop.\n\n` : "") +
				(r.key === "wrong-item"
					? `⚠️ This one DOES reach the deals page: block this product for **${p.ingredientName}** so it stops being offered as a deal for this row. It keeps competing for every other item — "ignore forever" is still the deals page's own red Ignore.`
					: `⚠️ This is a PRICE BOOK decision only. The product stays on your deals page; "ignore forever" is a different button, on the deals page itself.`),
		}),
	).join("\n    ");
	return `<details class="why-not">
    <summary>Don't use</summary>
    <div class="reasons">
    ${items}
    </div>
  </details>`;
}

function card(p: PendingReview, o: ReviewPageOptions): string {
	// ⚠️ The whole card body is the link to the shop — the question being asked is
	// "is this the right pack?", and you cannot answer it without looking at the thing.
	// A small link buried under a price made that a deliberate act; this makes it the
	// obvious one. The buttons sit OUTSIDE the anchor so they stay separately tappable.
	return `<article class="card">
  <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
    <div class="hd">
      <span class="ing">${esc(p.ingredientName)}</span>
      <span class="shop">${esc(p.vendor)}</span>
    </div>
    <div class="price"><b>$${p.priceSgd.toFixed(2)}</b> / ${esc(p.size)}${esc(unitWord(p.unitType))}${
			p.perLabel ? ` <span class="per">= ${esc(p.perLabel)}</span>` : ""
		}</div>
    <div class="prod">${esc(p.itemName)} <span class="go">↗</span></div>
    ${reasonList(p.reasons)}
  </a>
  <div class="acts">
    ${button(p, o, {
			action: "review-ok",
			label: "OK",
			done: "✓ recorded",
			cls: "ok",
			prose: `Recording this price against **${p.ingredientName}** at **${p.vendor}** from the review page.`,
		})}
    ${rejectMenu(p, o)}
  </div>
</article>`;
}

export function renderReviewPage(pending: PendingReview[], o: ReviewPageOptions): string {
	const when = (o.generatedAt ?? new Date()).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
	const body = pending.length
		? pending.map((p) => card(p, o)).join("\n")
		: `<p class="empty">Nothing waiting. Every price the last scan found was clear enough to record.</p>`;

	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prices to check</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#111; --mut:#666; --line:#e3e3e3; --card:#fafafa; --ok:#0a7d32; --no:#a3231d; }
@media (prefers-color-scheme: dark) { :root { --bg:#131313; --fg:#eee; --mut:#9a9a9a; --line:#2c2c2c; --card:#1b1b1b; --ok:#4ade80; --no:#f87171; } }
* { box-sizing:border-box; }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:720px; margin-inline:auto; }
h1 { font-size:1.25rem; margin:0 0 4px; }
.sub { color:var(--mut); font-size:.85rem; margin:0 0 6px; }
.note { color:var(--mut); font-size:.82rem; border-left:3px solid var(--line); padding:6px 10px; margin:0 0 18px; }
.card { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:12px 14px; margin-bottom:12px; }
.hd { display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap; }
.ing { font-weight:600; }
.shop { color:var(--mut); font-size:.8rem; white-space:nowrap; }
.price { margin:6px 0 2px; font-size:1.05rem; }
.per { color:var(--mut); font-size:.9rem; }
.body { display:block; color:inherit; text-decoration:none; border-radius:8px; margin:-4px -6px 8px; padding:4px 6px; }
.body:hover, .body:focus-visible { background:rgba(128,128,128,.09); outline:none; }
.prod { font-size:.88rem; opacity:.85; margin-bottom:8px; word-break:break-word; }
.go { opacity:.55; }
.why { margin:8px 0 10px; padding-left:18px; font-size:.85rem; color:var(--mut); }
.why li { margin:2px 0; }
.why li.r-bulk, .why li.r-floor-rescue { color:var(--no); }
.acts { display:flex; gap:8px; align-items:flex-start; }
.act { display:block; text-align:center; text-decoration:none; padding:9px 12px; border-radius:8px;
  border:1px solid var(--line); font-size:.92rem; font-weight:600; }
.acts > .act { flex:1; }
.act.ok { color:var(--ok); border-color:var(--ok); }
.act.no { color:var(--no); border-color:var(--no); }
.act.small { font-weight:500; font-size:.86rem; padding:8px 10px; text-align:left; }
.act.done { opacity:.55; pointer-events:none; }
.why-not { flex:1; }
.why-not > summary { list-style:none; cursor:pointer; text-align:center; padding:9px 12px;
  border:1px solid var(--no); color:var(--no); border-radius:8px; font-size:.92rem; font-weight:600; }
.why-not > summary::-webkit-details-marker { display:none; }
.why-not[open] > summary { border-bottom-left-radius:0; border-bottom-right-radius:0; }
.reasons { display:flex; flex-direction:column; gap:6px; padding:8px;
  border:1px solid var(--no); border-top:0; border-radius:0 0 8px 8px; }
.empty { color:var(--mut); }
</style></head>
<body>
<h1>Prices to check</h1>
<p class="sub">${pending.length} waiting · ${esc(when)}</p>
<p class="note"><b>OK</b> records the price. <b>Don't use</b> doesn't — and that is all it does:
the product still appears on your deals page. To drop it from there too, use <b>Ignore</b> on the deals page.</p>
${body}
</body></html>`;
}
