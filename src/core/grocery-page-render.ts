import { discountPct, totals, type ListRow } from "./grocery-page.js";
import { LOCATION_LABELS, LOCATION_MODES, type LocationMode } from "./vendor-locations.js";

/**
 * The HTML half of `list.html`. Split from `grocery-page.ts` so the Notion read and the
 * rendering can be tested apart — the read needs a client, the render needs nothing.
 *
 * See `grocery-page.ts` for what this page IS and why ticking behaves as it does.
 */

const esc = (s: unknown): string =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const money = (n: number) => `$${n.toFixed(2)}`;

export interface ListPageOptions {
	/** "owner/repo" — kept for the footer's link to the Actions log. */
	repo: string;
	/**
	 * The relay's `/list` endpoint. A tap POSTs here and the Worker dispatches the
	 * workflow, so the page needs no GitHub credential of its own.
	 */
	listEndpoint: string;
	/**
	 * What the page sends as `X-List-Secret`.
	 *
	 * ⚠️ **This is embedded in a PUBLIC page and is not a secret from anyone who opens
	 * it.** That is the trade the user chose (2026-09-11) to get a list that works on any
	 * device with nothing to enable. See the header of `handleList` in `relay/worker.mjs`
	 * for what it does and does not buy an attacker. Unset renders the page read-only.
	 */
	listSecret?: string;
	generatedAt?: Date;
	/**
	 * Public URL of `data/list-live.json`, which the page fetches on load to catch up with
	 * anything texted since it was built. See `ListFragment` — omit it and the page is
	 * exactly what it was before, i.e. correct but up to a day behind.
	 */
	listLiveUrl?: string;
	/** Link back to the deals page, so the pages stay one site. */
	siteUrl?: string;
	/** Shown instead of the list when the Notion read failed. */
	error?: string;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1c1a;--dim:#6b6862;--line:#e6e3dd;--card:#fff;--acc:#1a7f4b;--accbg:#e8f5ee;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#191918;--fg:#eceae5;--dim:#9b968d;--line:#302e2b;--card:#232220;--acc:#4ec585;--accbg:#16301f;--warn:#d6a441}}
*{box-sizing:border-box}
body{margin:0;padding:18px 14px 60px;background:var(--bg);color:var(--fg);
  font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  max-width:680px;margin-inline:auto;-webkit-text-size-adjust:100%}
h1{font-size:1.35rem;margin:0 0 2px}
.sub{color:var(--dim);font-size:.82rem;margin:0 0 16px}
.sub a{color:inherit}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:8px;padding:10px 12px;margin:0 0 14px;font-size:.84rem;color:var(--dim)}
/* ---- Add box ---- */
.add{position:relative;margin:0 0 14px}
.add input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--fg);font:inherit}
.add input:focus{outline:2px solid var(--acc);outline-offset:-1px}
.add input:disabled{opacity:.5}
.hits{list-style:none;margin:6px 0 0;padding:0;border:1px solid var(--line);border-radius:10px;
  background:var(--card);overflow:hidden}
.hits:empty{display:none}
.hits li{display:flex;justify-content:space-between;gap:10px;align-items:baseline;
  padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--line)}
.hits li:last-child{border-bottom:0}
.hits li:hover,.hits li[aria-selected="true"]{background:var(--accbg)}
.hits .hn{font-weight:600;min-width:0;word-break:break-word}
.hits .hp{color:var(--dim);font-size:.8rem;white-space:nowrap}
.hits .new{color:var(--dim);font-style:italic;font-weight:400}
ul.list{list-style:none;margin:0;padding:0}
li.row{display:flex;gap:10px;align-items:flex-start;background:var(--card);
  border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px;
  transition:opacity .3s,transform .3s,max-height .3s;max-height:200px;overflow:hidden}
li.row.going{opacity:0;transform:translateX(28px);max-height:0;padding-top:0;padding-bottom:0;
  margin-bottom:0;border-width:0}
li.row input.tick{width:22px;height:22px;margin:2px 0 0;flex:0 0 auto;accent-color:var(--acc);cursor:pointer}
li.row input.tick:disabled{cursor:not-allowed;opacity:.45}
.qty{flex:0 0 auto;display:flex;align-items:baseline;gap:2px;color:var(--dim);font-size:.9rem}
.qty input{width:2.6em;padding:2px 4px;text-align:right;border:1px solid var(--line);border-radius:6px;
  background:transparent;color:var(--fg);font:inherit;font-size:.9rem}
.qty input:disabled{border-color:transparent;opacity:.7}
.body{flex:1 1 auto;min-width:0}
.nm{font-weight:600;word-break:break-word}
/* The name is a link when the product has a URL. Underlined faintly rather than coloured:
   it must still read as the item on your list first, and a list of blue links is not one. */
a.nm{color:inherit;text-decoration:underline;text-decoration-color:var(--dim);text-underline-offset:3px}
a.nm:hover{text-decoration-color:var(--acc)}
/* ⚠️ The arrow is a ::after, NOT markup: the page's script reads .nm's textContent for the
   undo tray, and an arrow inside the element would ride along into the tray's label. */
a.nm::after{content:" \\2197";font-size:.78em;color:var(--dim);text-decoration:none}
/* The product an offer is ON, under its price. Dimmer and smaller than the price lines —
   it is the label on the thing, not another figure to compare against them. */
.pl.on{font-size:.78rem;color:var(--dim);margin-top:1px;padding-left:2px}
.pl.on a{color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px}
.pl.on a::after{content:" \\2197";font-size:.92em}
.pl.none{font-size:.8rem;color:var(--dim);font-style:italic}
/* ---- Location toggle ---- */
/* ⚠️ Which prices show is pure CSS off :checked — the script only keeps the totals in step,
   so the control still works with scripting off. The radios are visually hidden, not
   display:none, or they stop being focusable. */
.loc{border:1px solid var(--line);border-radius:10px;background:var(--card);margin:0 0 14px;
  padding:8px 10px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.loc legend{font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;padding:0 4px}
.loc input{position:absolute;opacity:0;width:1px;height:1px}
.loc label{font-size:.85rem;padding:5px 12px;border:1px solid var(--line);border-radius:999px;
  cursor:pointer;color:var(--dim);user-select:none}
.loc input:checked + label{background:var(--accbg);border-color:var(--acc);color:var(--acc);font-weight:600}
.loc input:focus-visible + label{outline:2px solid var(--acc);outline-offset:2px}
/* Only the chosen trip's prices are shown. One block per mode is rendered server-side, so
   there is no second price renderer in the browser — see localeBlock(). */
.mode{display:none}
#loc:has(#loc-cheapest:checked) ~ .list .m-cheapest,
#loc:has(#loc-home:checked) ~ .list .m-home,
#loc:has(#loc-work:checked) ~ .list .m-work{display:block}
.pl{font-size:.82rem;word-break:break-word;margin-top:3px;color:var(--dim)}
.pl b{font-weight:600}
/* The regular price is context; the offer is the news. Same size, different weight of
   ink — a smaller offer line would be the wrong way round. */
.pl.reg{opacity:.75}
.pl.cut{color:var(--fg)}
/* An offer at a shop this trip does not pass is still shown — it is what the price here is
   being compared against — but it is not money you are going to save today. */
.pl.cut.away{opacity:.6}
.away{font-size:.74rem;color:var(--dim);font-style:italic;white-space:nowrap}
.tags{margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.off{background:var(--accbg);color:var(--acc);border-radius:999px;padding:1px 8px;
  font-size:.74rem;font-weight:700;white-space:nowrap}
.where{font-size:.76rem;color:var(--dim)}
.where b{color:var(--fg);font-weight:600}
.where a{color:inherit}
.noprice{font-size:.74rem;color:var(--warn)}
.totals{margin-top:22px;border-top:2px solid var(--line);padding-top:12px}
.trow{display:flex;justify-content:space-between;align-items:baseline;padding:5px 2px;font-size:1rem}
.trow.big{font-weight:700;font-size:1.1rem}
.trow .lbl{color:var(--dim)}
.trow.big .lbl{color:var(--fg)}
.trow .amt{font-variant-numeric:tabular-nums}
.saved{color:var(--acc);font-size:.82rem;text-align:right;padding:2px}
.tray{margin-top:20px;font-size:.82rem;color:var(--dim)}
.tray h2{font-size:.82rem;font-weight:600;color:var(--dim);margin:0 0 6px}
.tray li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--line)}
.tray button{background:none;border:0;color:var(--acc);font:inherit;cursor:pointer;padding:0}
.empty{color:var(--dim);text-align:center;padding:32px 0}
footer{margin-top:26px;color:var(--dim);font-size:.76rem;text-align:center}
footer a{color:inherit}
`;

/**
 * The two price lines, **one per price rather than one per unit** (user, 2026-09-11):
 *
 *     $3.38 / 2.82 /10 pc — NTUC          ← what you normally pay, and where
 *     $1.50 / $25.00/kg  −56% — Sheng Siong   ← the offer, and where
 *
 * ⚠️ **This replaced rendering `Price D%/C` verbatim, and the reason for that rule still
 * holds — it was simply the wrong shape.** The formula's own layout splits by UNIT (pack
 * prices on one line, per-kg figures on the other), so the regular price and its own
 * per-kg figure sit on different lines with the discount's numbers between them. Reading
 * "what do I normally pay for this, and where" meant taking one figure off each line.
 * Grouping by price puts each answer on a single line.
 *
 * ⚠️ **The FIGURES are still the user's own** — the pack prices come from `Price , To Buy `
 * and `Current Price `, and both per-unit strings are lifted out of `Price D%/C` unchanged
 * (see `parsePerUnitLine`). Nothing here recomputes a number the user wrote a rule for;
 * only the arrangement is this page's.
 *
 * ⚠️ **A missing half is dropped, never rendered as an empty slot.** Rows texted to the bot
 * have no price at all and rows with no offer have no discount line, and both are normal.
 */
function priceLine(
	price: number | null,
	perUnit: string | null,
	vendor: string | null,
	opts: { cls: string; pct?: number | null; url?: string | null; note?: string } = { cls: "" },
): string {
	if (price == null && !perUnit) return "";
	const bits: string[] = [];
	if (price != null) bits.push(`<b>${money(price)}</b>`);
	if (perUnit) bits.push(esc(perUnit));
	let line = bits.join(" / ");
	if (opts.pct != null) line += ` <span class="off">−${opts.pct}%</span>`;
	if (vendor) {
		const label = `<b>${esc(vendor)}</b>`;
		line +=
			` <span class="where">— ` +
			(opts.url ? `<a href="${esc(opts.url)}" target="_blank" rel="noopener">${label} ↗</a>` : label) +
			`</span>`;
	}
	if (opts.note) line += ` <span class="away">${esc(opts.note)}</span>`;
	return `<div class="pl ${opts.cls}">${line}</div>`;
}

/**
 * The item name, as a link to the product you are actually going to buy.
 *
 * ⚠️ **The name, not just the shop label beside the price** (user, 2026-10-03: "can the
 * card in the grocery list open up the product online"). The shop label has always been a
 * link, but it is three small words at the end of a price line — in a shop, one-handed,
 * the thing you press is the name of the thing you are looking for.
 *
 * ⚠️ **It points at the MAIN product, never the offer**, even on a discounted row. The
 * offer keeps its own small link on the discount line, which is the shape the user asked
 * for; swapping the big target to the promo would mean the obvious tap opens a listing
 * that stops existing the day the promo ends.
 *
 * ⚠️ `.nm` keeps its class either way, so a row with no URL looks exactly as it did, and
 * the page's own script goes on reading `.nm` for the undo tray without caring which it got.
 */
function nameHtml(r: ListRow): string {
	const name = esc(r.name);
	if (!r.currentUrl) return `<span class="nm">${name}</span>`;
	return `<a class="nm" href="${esc(r.currentUrl)}" target="_blank" rel="noopener">${name}</a>`;
}

function priceBlock(r: ListRow): string {
	const pct = discountPct(r);
	const regular = priceLine(r.currentPrice, r.currentPerUnit, r.currentVendor, {
		cls: "reg",
		url: r.currentUrl,
	});
	// ⚠️ **Only a genuine reduction gets a second line.** `Price , To Buy ` is often equal
	// to the regular price (Fish Sauce, $2.29 / $2.29), and repeating the same figure under
	// a heading that means "offer" is how a page trains you to stop reading it.
	const discount =
		pct != null
			? priceLine(r.buyPrice, r.perKg, r.dealVendor ?? r.currentVendor, {
					cls: "cut",
					pct,
					url: r.dealUrl,
				})
			: "";
	return regular + discount + offerName(r, pct != null);
}

/**
 * **What the offer is actually ON, under the discounted price** (user, 2026-10-04).
 *
 * ⚠️ **The row name is not an answer to "which one is on offer".** A row called `Butter`
 * at −16% does not tell you which tub to reach for, and on a row whose promo is a
 * DIFFERENT product from the one normally recorded it is actively misleading — Green Tea's
 * Sheng Siong slot held "Green Tea" while the promo was on another teabag entirely. This is
 * the shop's own wording, from `Item name (Discount)`.
 *
 * ⚠️ **Only under a line that showed a discount.** Without a `−%` above it there is no
 * offer for this name to belong to, and a stray product name under a plain price reads as
 * the thing you are buying rather than the thing that is cheap.
 *
 * ⚠️ The name is the link, as asked. It points at `dealUrl` — the offer's own listing from
 * `URL item (Discount)` — so the two always describe one product.
 */
function offerName(r: ListRow, discounted: boolean): string {
	const name = (r.dealItemName ?? "").trim();
	if (!discounted || !name) return "";
	const label = esc(name);
	return `<div class="pl on">${
		r.dealUrl ? `<a href="${esc(r.dealUrl)}" target="_blank" rel="noopener">${label}</a>` : label
	}</div>`;
}

/** Whatever is left to say about a row once its prices are on the page. */
function tags(r: ListRow): string {
	if (r.currentPrice != null || r.buyPrice != null) return "";
	return `<div class="tags"><span class="noprice">no price — not in the totals</span></div>`;
}

/**
 * ⚠️ **`live` is false when no list endpoint is configured, and the controls are then
 * `disabled` in the MARKUP** — not merely left without a script. A checkbox that ticks and
 * silently forgets is worse than one that plainly cannot, and a local preview built from an
 * empty `.env` is the ordinary way to reach this state.
 */
/**
 * One row's prices **for a trip that is not "wherever is cheapest"**.
 *
 * ⚠️ **Rendered server-side, three times, and switched with CSS.** The alternative was
 * handing the browser the figures and formatting them there — which is a second price
 * renderer, and the one thing this file has consistently refused to grow. See
 * `ListFragment` for the same call made the same way.
 *
 * ⚠️⚠️ **The offer line is shown in EVERY mode, reachable or not** (user, 2026-10-06:
 * "always show the discount row no matter. it is used to compare potential prices"). It
 * first did the opposite — a `−62%` at Sheng Siong simply vanished under the Work heading —
 * which threw away the one figure that tells you what the price in front of you is worth.
 * Seeing "$22.80 NTUC" against "$8.65 Sheng Siong" is the whole point of the toggle; seeing
 * $22.80 alone just looks like the price of toothpaste.
 *
 * ⚠️ **An unreachable offer is marked, not hidden**: dimmed, and labelled *not on this
 * trip*. It is a comparison, so it must not read as money you are about to save — and
 * `modeTotals` deliberately leaves it out of this trip's total for the same reason. An
 * offer shown at full strength AND excluded from the sum would be the page contradicting
 * itself without saying which half to believe.
 */
function localeBlock(r: ListRow, mode: LocationMode): string {
	const pick = r.atLocation?.[mode];
	if (!pick) return "";
	const pct = discountPct(r);
	const dealHere = r.dealVendor != null && normish(r.dealVendor) === normish(pick.vendor ?? "");
	const deal =
		pct != null
			? priceLine(r.buyPrice, r.perKg, r.dealVendor ?? r.currentVendor, {
					cls: dealHere ? "cut" : "cut away",
					pct,
					url: r.dealUrl,
					note: dealHere ? undefined : "not on this trip",
				}) + offerName(r, true)
			: "";
	if (pick.price == null) {
		return (
			`<div class="pl none">${
				pick.elsewhere ? "not at a shop on this trip" : "no price here yet"
			}</div>` + deal
		);
	}
	return priceLine(pick.price, null, pick.vendor, { cls: "reg", url: pick.url }) + deal;
}

/**
 * Which modes this page can offer.
 *
 * ⚠️ **The toggle appears only when the location data actually arrived.** `readGroceryList`
 * leaves `atLocation` unset when the Website Used read fails or when a local preview has no
 * token, and a Home tab that is empty for that reason reads as "nothing is near you" — the
 * worst possible lie for a shopping list to tell. No data, no toggle, page exactly as before.
 */
/**
 * **The Location toggle.** Which trip are you on — anywhere, Home, or Work?
 *
 * ⚠️ **Radio inputs, operable before any script runs**, the same standard the review page's
 * tabs hold themselves to. The script only keeps the TOTALS in step; which prices are shown
 * is pure CSS off `:checked`, so the control still works with scripting off.
 *
 * ⚠️ **`Cheapest` is first and checked.** It is what this page has always shown, and a
 * toggle that silently started you somewhere else would change the meaning of every figure
 * on the page without saying so.
 */
function locationToggle(modes: LocationMode[]): string {
	const buttons = modes
		.map(
			(m, i) =>
				`<input type="radio" name="loc" id="loc-${m}" value="${m}"${i === 0 ? " checked" : ""}>` +
				`<label for="loc-${m}">${esc(LOCATION_LABELS[m])}</label>`,
		)
		.join("\n    ");
	return `<fieldset class="loc" id="loc">
    <legend>Location</legend>
    ${buttons}
  </fieldset>`;
}

export function modesFor(rows: readonly ListRow[]): LocationMode[] {
	return rows.some((r) => r.atLocation) ? LOCATION_MODES : ["cheapest"];
}

/** The same normalisation `normTag` does, without dragging Notion into the renderer. */
const normish = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * What one row costs in one mode: [full, discounted]. Drives the totals, per mode.
 *
 * ⚠️ **`dealHere` gates the TOTAL, not the display.** `localeBlock` prints an unreachable
 * offer anyway, as a comparison; this must not count it, because the total answers "what
 * will this trip cost me" and an offer at a shop you are not going to is not a saving.
 */
function modeTotals(r: ListRow, mode: LocationMode): [number | null, number | null] {
	if (mode === "cheapest") {
		const base = r.currentPrice ?? r.buyPrice;
		return [base, r.buyPrice ?? base];
	}
	const pick = r.atLocation?.[mode];
	if (!pick || pick.price == null) return [null, null];
	const dealHere = r.dealVendor != null && normish(r.dealVendor) === normish(pick.vendor ?? "");
	return [pick.price, dealHere && r.buyPrice != null ? r.buyPrice : pick.price];
}

function rowHtml(r: ListRow, live: boolean, modes: LocationMode[]): string {
	const off = live ? "" : " disabled";
	// ⚠️ One pair of figures per mode, on the <li> itself, because `recount` sums from the
	// DOM and must follow the toggle. A single data-full would total the wrong trip.
	const data = modes
		.map((m) => {
			const [full, disc] = modeTotals(r, m);
			return ` data-full-${m}="${full ?? ""}" data-disc-${m}="${disc ?? ""}"`;
		})
		.join("");
	// ⚠️ `tags` rides INSIDE the cheapest block when there is a toggle. It says "no price —
	// not in the totals", which `localeBlock` already says better per trip ("not at a shop on
	// this trip"), and left outside it printed both at once on an unpriced row.
	const blocks =
		modes.length > 1
			? modes
					.map(
						(m) =>
							`<span class="mode m-${m}">${
								m === "cheapest" ? priceBlock(r) + tags(r) : localeBlock(r, m)
							}</span>`,
					)
					.join("")
			: priceBlock(r) + tags(r);
	return `<li class="row" data-id="${esc(r.pageId)}"${data}>
  <input class="tick" type="checkbox"${off} aria-label="Tick off ${esc(r.name)}">
  <span class="qty"><input class="amt" type="number" min="1" step="1" value="${r.amount}"${off}
    aria-label="How many ${esc(r.name)}"><span>&times;</span></span>
  <span class="body">
    ${nameHtml(r)}
    ${blocks}
  </span>
</li>`;
}

/** Where the fast-path snapshot is committed. Public repo, so `raw` serves it to the page. */
export const LIST_LIVE_PATH = "data/list-live.json";

/**
 * **The list as the page can swap it in, with no site rebuild.**
 *
 * `list.html` is a static file and the only thing that publishes it is `daily.yml`, which
 * runs the whole shop scan first. Measured 2026-10-01: a list texted at 10:56 UTC had its
 * Notion row within ~30 s and did not reach the page for **~14 hours**, because the next
 * publish was the following morning's. (The 11:30 SGT backstop does not help — the guard
 * skips it once the day's page exists, which is why those runs finish in 9–11 s.)
 *
 * So the inbox commits this instead, and the page fetches it on load. The row markup is
 * rendered by `rowHtml` — **the same function the baked page uses** — because the one thing
 * this must never become is a second renderer that formats prices slightly differently
 * from the real one.
 *
 * ⚠️ **Rows are always rendered LIVE (`rowHtml(r, true)`), whatever the environment that
 * built them.** A read-only page never fetches this: `script()` is only emitted when the
 * endpoint and secret are both set. But `tg-inbox.yml` has no `LIST_SECRET` in its env, so
 * passing the ambient `live` through would quietly commit a fragment full of `disabled`
 * controls — which, swapped into a live page, is a shopping list you cannot tick.
 *
 * ⚠️ **No secret and no token are in here**, only what the page already shows the world.
 */
export interface ListFragment {
	/** When the list last CHANGED, not when the script last ran. See `sameFragment`. */
	generatedAt: string;
	count: number;
	full: number;
	discounted: number;
	unpriced: number;
	/** `<li class="row">…</li>` for every row still to buy. */
	rowsHtml: string;
}

export function listFragment(rows: ListRow[], now: Date = new Date()): ListFragment {
	// Same filter as `renderListPage`: a row already ticked in Notion is shopping that is
	// done, and the page is the list of what is left.
	const open = rows.filter((r) => !r.ticked);
	const t = totals(open);
	return {
		generatedAt: now.toISOString(),
		count: open.length,
		full: t.full,
		discounted: t.discounted,
		unpriced: t.unpriced,
		rowsHtml: open.map((r) => rowHtml(r, true, modesFor(open))).join("\n"),
	};
}

/**
 * True when two snapshots hold the same list. **`generatedAt` is deliberately ignored.**
 *
 * ⚠️ This is what keeps the timestamp meaningful and the signal honest. Rewriting the file
 * on every run would make `generatedAt` "when the inbox last ran" — so the page would
 * re-swap identical rows on every load, and the workflow could not tell a texted list from
 * a `/search` that changed nothing. Compared here, the file is written only when the list
 * really moved, which makes "this file changed" a usable trigger for the rebuild job.
 */
export function sameFragment(a: ListFragment | null | undefined, b: ListFragment): boolean {
	if (!a) return false;
	return (
		a.rowsHtml === b.rowsHtml &&
		a.count === b.count &&
		a.unpriced === b.unpriced &&
		// Rounded to the cent: these are rendered as money, and a float that differs in the
		// twelfth decimal is not a change to the shopping list.
		a.full.toFixed(2) === b.full.toFixed(2) &&
		a.discounted.toFixed(2) === b.discounted.toFixed(2)
	);
}

/**
 * The page's own script. It POSTs to the relay's `/list`, and that is the whole auth story
 * — there is nothing to enable, nothing stored in the browser, and no GitHub credential on
 * the device.
 *
 * ⚠️ **It deliberately does NOT use the deals page's `grocery-add-pat` localStorage token.**
 * That token is per-browser, so a list ticked on your phone would do nothing on a borrowed
 * one, and it carries repo write. The user asked (2026-09-11) for a list that works on any
 * device; a page-embedded, list-scoped secret is the only shape that does.
 *
 * ⚠️ **Written as ES5-flavoured plain JS with no build step**, like every other script in
 * this project — it is served as-is to a phone browser and there is no bundler anywhere
 * in the site build.
 *
 * ⚠️ **The totals are recomputed in the browser, not re-fetched.** See `grocery-page.ts`:
 * a tick must show its arithmetic immediately, and the page is only rewritten daily.
 */
function script(endpoint: string, secret: string, live: { url: string; builtAt: string } | null): string {
	return `<script>
(function () {
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var SECRET = ${JSON.stringify(secret)};
  var LIVE_URL = ${JSON.stringify(live?.url ?? "")};
  var BUILT_AT = ${JSON.stringify(live?.builtAt ?? "")};

  var list = document.getElementById("list");
  var tray = document.getElementById("tray");
  var trayList = document.getElementById("traylist");

  // ⚠️ **No setup step, on purpose.** This page used to ask for a GitHub token per
  // browser, which is one device at a time and put a repo-write credential in a
  // shopping list. The credential now lives in the relay; the page carries only a
  // list-scoped secret, so a borrowed phone works the same as your own.
  function dispatch(payload) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-List-Secret": SECRET },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
    });
  }

  // ---- Add ---------------------------------------------------------------
  //
  // ⚠️ **The ingredient list is fetched ONCE and searched in the browser**, never
  // queried per keystroke. The page is static and cannot reach Notion, and a shop
  // basement is exactly where a per-keystroke round trip fails. ingredients.json
  // is published beside the page by the daily build.
  //
  // ⚠️ **A free-typed item with no match is still addable.** That is what texting
  // an unknown item to the bot does — it files the line name-only and prices it
  // later — and a box that refused anything not already in Notion would be a worse
  // list than the one you can text.
  var box = document.getElementById("addbox");
  var hits = document.getElementById("hits");
  var INDEX = [];
  var sel = -1;

  if (box) fetch("ingredients.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.items) { INDEX = d.items; box.placeholder = "Add an item\\u2026"; } })
    .catch(function () { /* free-typed adds still work without it */ });

  function norm(s) { return String(s || "").toLowerCase(); }

  // Prefix matches first, then anywhere. Typing "car" should offer Carrots before
  // "Bicarbonate of soda", which contains "car" halfway through.
  function search(q) {
    var n = norm(q), starts = [], contains = [];
    for (var i = 0; i < INDEX.length && starts.length + contains.length < 40; i++) {
      var it = INDEX[i];
      var hay = norm(it.name), term = norm(it.term);
      if (hay.indexOf(n) === 0 || term.indexOf(n) === 0) starts.push(it);
      else if (hay.indexOf(n) >= 0 || term.indexOf(n) >= 0) contains.push(it);
    }
    return starts.concat(contains).slice(0, 7);
  }

  function renderHits() {
    var q = box.value.trim();
    hits.innerHTML = "";
    sel = -1;
    if (!q) return;
    var found = search(q);
    found.forEach(function (it) {
      var li = document.createElement("li");
      li.dataset.id = it.id;
      li.dataset.name = it.name;
      var nm = document.createElement("span");
      nm.className = "hn";
      // A parked row is offered, not hidden — typing its name is the plainest way
      // of saying you want it now. Same call the Telegram intake makes.
      nm.textContent = (it.parked ? "\\u{1F4A4} " : "") + it.name;
      var pr = document.createElement("span");
      pr.className = "hp";
      pr.textContent = it.price != null ? "$" + Number(it.price).toFixed(2) + (it.vendor ? " \\u00b7 " + it.vendor : "") : "";
      li.appendChild(nm); li.appendChild(pr);
      hits.appendChild(li);
    });
    // The escape hatch: add exactly what was typed, with no ingredient behind it.
    var exact = found.some(function (f) { return norm(f.name) === norm(q); });
    if (!exact) {
      var li2 = document.createElement("li");
      li2.dataset.id = "";
      li2.dataset.name = q;
      var n2 = document.createElement("span");
      n2.className = "hn new";
      n2.textContent = "Add \\u201c" + q + "\\u201d";
      var p2 = document.createElement("span");
      p2.className = "hp";
      p2.textContent = "not in Ingredients";
      li2.appendChild(n2); li2.appendChild(p2);
      hits.appendChild(li2);
    }
  }

  function addPicked(li) {
    var name = li.dataset.name;
    box.value = "";
    hits.innerHTML = "";
    box.disabled = true;
    dispatch({ v: 1, op: "add", ingredientId: li.dataset.id || undefined, name: name, amount: 1 })
      .then(function () {
        box.disabled = false;
        box.placeholder = "\\u2713 " + name + " added";
        // ⚠️ The row is NOT drawn onto the list here. It does not exist until the
        // workflow writes it, and inventing a line with a made-up id would give the
        // user a checkbox that ticks nothing. The next build shows it for real.
        setTimeout(function () { box.placeholder = "Add an item\\u2026"; }, 4000);
      })
      .catch(function () {
        box.disabled = false;
        box.value = name;
        flash(box, "could not add \\u2014 try again");
      });
  }

  if (box) {
    box.addEventListener("input", renderHits);
    hits.addEventListener("click", function (ev) {
      var li = ev.target.closest("li");
      if (li) addPicked(li);
    });
    // Keyboard: arrows move, Enter takes the highlighted row, or the first one.
    box.addEventListener("keydown", function (ev) {
      var items = hits.querySelectorAll("li");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!items.length) return;
        ev.preventDefault();
        if (sel >= 0) items[sel].removeAttribute("aria-selected");
        sel = ev.key === "ArrowDown" ? (sel + 1) % items.length : (sel <= 0 ? items.length - 1 : sel - 1);
        items[sel].setAttribute("aria-selected", "true");
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        var pick = sel >= 0 ? items[sel] : items[0];
        if (pick) addPicked(pick);
      } else if (ev.key === "Escape") {
        box.value = "";
        hits.innerHTML = "";
      }
    });
  }

  // ---- Totals ----------------------------------------------------------
  // Only rows still ON the list count. A ticked row has left the shopping, so it
  // leaves the total in the same motion — that is the whole point of ticking it.
  // ---- Location --------------------------------------------------------
  //
  // ⚠️ **The script does NOT decide which prices are visible** — the CSS does, off the
  // radio's :checked. All this does is tell recount() which pair of data attributes to
  // sum, so the totals follow the trip. With scripting off the toggle still switches the
  // prices; only the totals stay on the mode the page was built in.
  //
  // ⚠️ The chosen mode is remembered per browser, because the trip you are on does not
  // change between page loads the way the list does. localStorage is wrapped: it throws in
  // a private window, and a shopping list must not die for want of a preference.
  var LOC_KEY = "grocery-list-location";
  function currentMode() {
    var on = document.querySelector('#loc input[name="loc"]:checked');
    return on ? on.value : "cheapest";
  }
  function MODE_KEY() {
    var m = currentMode();
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function recount() {
    var full = 0, disc = 0, n = 0;
    list.querySelectorAll("li.row:not(.going)").forEach(function (li) {
      var q = parseInt(li.querySelector("input.amt").value, 10);
      if (!isFinite(q) || q < 1) q = 1;
      // ⚠️ Per MODE. One pair of figures would total whichever trip was rendered first,
      // which is how a Home total ends up quoting prices from a shop you are not visiting.
      var f = parseFloat(li.dataset["full" + MODE_KEY()]), d = parseFloat(li.dataset["disc" + MODE_KEY()]);
      if (isFinite(f)) { full += f * q; disc += (isFinite(d) ? d : f) * q; }
      n++;
    });
    document.getElementById("tfull").textContent = "$" + full.toFixed(2);
    document.getElementById("tdisc").textContent = "$" + disc.toFixed(2);
    var save = document.getElementById("tsave");
    var d = full - disc;
    save.textContent = d > 0.004 ? "saving $" + d.toFixed(2) : "";
    document.getElementById("count").textContent = n + (n === 1 ? " item" : " items");
    document.getElementById("empty").hidden = n > 0;
  }

  function flash(el, msg) {
    var old = el.title; el.title = msg;
    el.style.outline = "2px solid #c0392b";
    setTimeout(function () { el.style.outline = ""; el.title = old; }, 2500);
  }

  // ---- Ticking ---------------------------------------------------------
  list.addEventListener("change", function (ev) {
    var el = ev.target;
    var li = el.closest("li.row");
    if (!li) return;

    if (el.classList.contains("tick") && el.checked) {
      el.disabled = true;
      dispatch({ v: 1, op: "tick", pageId: li.dataset.id })
        .then(function () {
          li.classList.add("going");
          recount();
          addToTray(li);
        })
        .catch(function (e) {
          el.checked = false; el.disabled = false;
          flash(el, e.message === "auth" ? "token rejected" : "could not save \\u2014 try again");
        });
      return;
    }

    if (el.classList.contains("amt")) {
      var q = parseInt(el.value, 10);
      if (!isFinite(q) || q < 1) { q = 1; el.value = "1"; }
      recount();
      dispatch({ v: 1, op: "amount", pageId: li.dataset.id, amount: q })
        .catch(function () { flash(el, "not saved"); });
    }
  });

  // ---- The day of grace ------------------------------------------------
  // A ticked row is cleared at midnight, not now — so all day it has to be
  // possible to take the tick back. Without this the grace period would be a delay
  // with nothing to do in it.
  function addToTray(li) {
    tray.hidden = false;
    var name = li.querySelector(".nm").textContent;
    var item = document.createElement("li");
    var span = document.createElement("span");
    span.textContent = name;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "undo";
    btn.addEventListener("click", function () {
      btn.disabled = true; btn.textContent = "\\u2026";
      dispatch({ v: 1, op: "untick", pageId: li.dataset.id })
        .then(function () {
          item.remove();
          li.classList.remove("going");
          li.querySelector("input.tick").checked = false;
          li.querySelector("input.tick").disabled = false;
          if (!trayList.children.length) tray.hidden = true;
          recount();
        })
        .catch(function () { btn.disabled = false; btn.textContent = "retry"; });
    });
    item.appendChild(span); item.appendChild(btn);
    trayList.appendChild(item);
  }

  // ---- Catching up with a list texted since this page was built -----------
  //
  // ⚠️ **This is why a texted item shows up in seconds instead of tomorrow.** The page
  // itself is republished only by the daily scan; the inbox commits data/list-live.json
  // as it writes the Notion row, and that file is served by raw.githubusercontent with
  // Access-Control-Allow-Origin:* (checked 2026-10-01). So this is one GET to a CDN, not
  // a rebuild.
  //
  // ⚠️ **Only when the snapshot is NEWER than this page.** The daily build bakes the same
  // rows in, so after a rebuild the file is older than the page and must be left alone —
  // otherwise every load would overwrite fresh markup with a stale copy of itself.
  //
  // ⚠️ **And only before you have touched anything.** Replacing the list wholesale would
  // detach the <li> each undo button in the tray closes over, so a tick taken during the
  // round trip would lose its undo. A page you have started shopping on is never rewritten
  // under you; the swap happens on load or not at all.
  //
  // ⚠️ Failure is silent and harmless: no network, a 404 before the first commit, or junk
  // JSON all leave the baked page exactly as it was. That is the whole point of baking it.
  function catchUp() {
    if (!LIVE_URL || !BUILT_AT) return;
    // Cache-buster: raw sends max-age=300, and five minutes is long enough to look broken.
    fetch(LIVE_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || typeof d.rowsHtml !== "string" || !d.generatedAt) return;
        if (d.generatedAt <= BUILT_AT) return;
        if (trayList.children.length) return;
        list.innerHTML = d.rowsHtml;
        recount();
        var sub = document.getElementById("count");
        if (sub) sub.title = "updated from your texted list at " + d.generatedAt;
      })
      .catch(function () { /* the baked page is already correct enough */ });
  }

  var locBox = document.getElementById("loc");
  if (locBox) {
    try {
      var saved = localStorage.getItem(LOC_KEY);
      var savedBtn = saved && document.getElementById("loc-" + saved);
      if (savedBtn) savedBtn.checked = true;
    } catch (e) { /* private window — the default mode is a fine answer */ }
    locBox.addEventListener("change", function () {
      try { localStorage.setItem(LOC_KEY, currentMode()); } catch (e) {}
      recount();
    });
  }

  recount();
  catchUp();
})();
</script>`;
}

export function renderListPage(rows: ListRow[], o: ListPageOptions): string {
	const builtAt = o.generatedAt ?? new Date();
	const when = builtAt.toLocaleString("en-SG", {
		timeZone: "Asia/Singapore",
		dateStyle: "medium",
		timeStyle: "short",
	});

	// ⚠️ A row already ticked in Notion is NOT shown. It is shopping that is done, and
	// the page is the list of what is left. The 16 rows ticked before this page existed
	// are exactly this case — they stay in Notion, untouched, and are never swept.
	const open = rows.filter((r) => !r.ticked);
	const t = totals(open);

	// ⚠️ **No secret configured renders a READ-ONLY page, not a broken one.** A local
	// preview (`npm run build-list` with nothing in `.env`) is the normal way to hit this.
	// Controls that looked live and silently dropped every tick would be worse than
	// controls that say plainly they cannot save.
	const live = Boolean(o.listSecret) && Boolean(o.listEndpoint) && !o.error;
	const modes = modesFor(open);

	const body = o.error
		? `<div class="note">The list could not be read from Notion just now, so this page is
       showing nothing rather than showing it wrong. Your list is safe in Notion.<br>
       <code>${esc(o.error)}</code></div>`
		: `${
				live
					? `<div class="add">
    <input id="addbox" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="Add an item…" aria-label="Add an item to the list">
    <ul class="hits" id="hits" role="listbox"></ul>
  </div>`
					: ""
			}
  ${modes.length > 1 ? locationToggle(modes) : ""}
  <ul class="list" id="list">${open.map((r) => rowHtml(r, live, modes)).join("\n")}</ul>
  <p class="empty" id="empty"${open.length ? " hidden" : ""}>Nothing on the list. Text the bot to add something.</p>

  <div class="totals">
    <div class="trow"><span class="lbl">Total cost</span><span class="amt" id="tfull">${money(t.full)}</span></div>
    <div class="trow big"><span class="lbl">Total cost with %</span><span class="amt" id="tdisc">${money(t.discounted)}</span></div>
    <div class="saved" id="tsave">${t.full - t.discounted > 0.004 ? `saving ${money(t.full - t.discounted)}` : ""}</div>
    ${
			t.unpriced
				? `<div class="note" style="margin-top:10px">${t.unpriced} item${t.unpriced === 1 ? " has" : "s have"} no price yet, so ${t.unpriced === 1 ? "it is" : "they are"} not in either total.</div>`
				: ""
		}
  </div>

  <div class="tray" id="tray" hidden>
    <h2>Ticked off — clearing from Notion at midnight</h2>
    <ul id="traylist"></ul>
  </div>`;


	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grocery list</title>
<style>${CSS}</style>
</head>
<body>
<h1>Grocery list</h1>
<p class="sub"><span id="count">${open.length} item${open.length === 1 ? "" : "s"}</span> ·
  built ${esc(when)} SGT${o.siteUrl ? ` · <a href="${esc(o.siteUrl)}">today's deals →</a>` : ""}</p>
${
	!live && !o.error
		? `<div class="note">Read-only — this copy has no list endpoint configured, so ticking
     and amounts will not save. The published page at your site does.</div>`
		: ""
}
${body}
<footer>Ticking a box clears the row from your Notion list at midnight.
  Amounts save as you change them.</footer>
${
	live
		? script(
				o.listEndpoint,
				o.listSecret!,
				// ⚠️ ISO on both sides, so the page's string compare is a real date compare.
				o.listLiveUrl ? { url: o.listLiveUrl, builtAt: builtAt.toISOString() } : null,
			)
		: ""
}
</body>
</html>`;
}
