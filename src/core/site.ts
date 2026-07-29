import type { Deal, ReviewMiss } from "./compare.js";
import { cooldownKey } from "./cooldown.js";
import { groceryRowTitle, type AddPayload } from "./grocery-list.js";

/**
 * Renders the daily deals as a self-contained HTML page (deployed to GitHub
 * Pages). One Telegram message links here, keeping the chat to a single message.
 */

/** Page-wide settings the cards need — how "Add" reaches Notion, and what's snoozed. */
export interface PageOptions {
	/** "owner/repo" for the Add button's pre-filled issue link. */
	repo: string;
	/** One-tap POST endpoint. Empty ⇒ fall back to the GitHub issue link. */
	addEndpoint?: string;
	/** Items being skipped because they were recently bought. */
	snoozed?: { name: string; until: string }[];
}

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

/** What the Add button ships to the workflow: enough to write the row AND set the cooldown. */
function addPayload(d: Deal): AddPayload {
	return {
		v: 1,
		ingredientId: d.target.ingredientId,
		ingredient: d.target.name,
		key: cooldownKey(d.target.search.searchTerm),
		store: d.product.store,
		product: d.product.name,
		priceSgd: d.product.priceSgd,
		myPriceSgd: d.target.packPriceSgd,
		// The pack actually being bought decides how long the cooldown runs; fall
		// back to the user's usual pack when the store didn't publish a size.
		packSizeG: d.product.packWeightG ?? (d.target.packSize || null),
		volumetric: d.product.volumetric,
		monthlyAmount: d.target.monthlyAmount,
		url: d.product.url,
	};
}

/**
 * The Add button — always a plain link to a pre-filled GitHub issue.
 *
 * The page is static, so it can hold no credentials of its own. The link works
 * with JavaScript off, in any browser, forever: tap Add → tap Submit → the
 * `add-to-list` workflow writes the Notion row and the cooldown.
 *
 * `data-add` carries the same payload as the issue body, which is what lets the
 * one-tap script (see `addScript`) intercept the click and skip the GitHub
 * screen entirely. The link is the floor; one-tap is an upgrade layered on top,
 * so a missing or revoked token degrades to two taps rather than to nothing.
 */
function addButton(d: Deal, o: PageOptions): string {
	const p = addPayload(d);
	const label = groceryRowTitle(p.store, p.ingredient);
	const payload = esc(JSON.stringify(p));

	if (o.addEndpoint) {
		return `<button class="add" type="button" data-add="${payload}"
        aria-label="Add ${esc(label)} to the grocery list">Add</button>`;
	}

	const body =
		`Adding **${label}** to the grocery list from today's deals page.\n\n` +
		`${p.product} · $${p.priceSgd.toFixed(2)} · ${p.url}\n\n` +
		"```json\n" +
		`${JSON.stringify(p, null, 2)}\n` +
		"```\n";
	const href =
		`https://github.com/${o.repo}/issues/new` +
		`?title=${encodeURIComponent(`Add: ${label}`)}` +
		`&labels=grocery-add` +
		`&body=${encodeURIComponent(body)}`;

	return `<a class="add" href="${esc(href)}" target="_blank" rel="noopener"
        data-add="${payload}"
        aria-label="Add ${esc(label)} to the grocery list">Add</a>`;
}

function dealCard(d: Deal, o: PageOptions): string {
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

	// The card is a flex row: the Add button on the left, the (clickable) deal on
	// the right. The button has to sit OUTSIDE the product link — a control nested
	// in an <a> is both invalid and untappable without swallowing the link.
	return `
    <div class="card">
      ${addButton(d, o)}
      <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
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
      </a>
    </div>`;
}

/**
 * A close-but-not-exact match. Visually distinct from a deal card (dashed border,
 * no green saving badge) and states exactly which defining property it failed, so
 * a recommendation can never be mistaken for the thing you actually asked for.
 */
function recCard(r: ReviewMiss): string {
	const p = r.product;
	const u = bigUnit(p.volumetric);
	const prodPack = p.packWeightG ? ` <span class="pack">[${packLabel(p.packWeightG, p.volumetric)}]</span>` : "";
	const prodBig = r.productPer100g != null ? `$${(r.productPer100g * 10).toFixed(2)}/${u}` : "";
	const baseBig = r.baselinePer100g != null ? `$${(r.baselinePer100g * 10).toFixed(2)}/${u}` : "";
	const why = r.missing.length
		? `<div class="why">not <b>${esc(r.missing.join(", "))}</b> — check before buying</div>`
		: `<div class="why">close match — check before buying</div>`;

	// No Add button here on purpose: a recommendation is explicitly NOT the item
	// you asked for, so one tap must never put it on the list — and, worse, start
	// a cooldown that hides the real item.
	return `
    <div class="card rec">
      <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
        <div class="row1">
          <span class="name">${esc(r.target.name)}</span>
          <span class="tag">closest</span>
        </div>
        <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)}${prodPack} <span class="prodprice">$${p.priceSgd.toFixed(2)}</span></div>
        <div class="price"><b>${prodBig}</b> <span class="was">vs ${baseBig}</span></div>
        ${why}
      </a>
    </div>`;
}

/**
 * One tap, with no server anywhere.
 *
 * `api.github.com` answers cross-origin requests — a preflighted, authenticated
 * POST from `tmje30.github.io` comes back with a readable status, verified
 * 2026-07-29. So the page can fire `repository_dispatch` at the `add-to-list`
 * workflow itself, using a fine-grained PAT the user pastes in once. The token
 * lives only in that browser's localStorage: never in the repo, the page source,
 * or a build artifact.
 *
 * Why this rather than a relay service: it's free, there's nothing to deploy,
 * and — unlike a POST to a Notion webhook, which returns no CORS headers and so
 * an opaque response — the button can read the real status and tell the truth
 * about whether GitHub accepted the job.
 *
 * It is strictly an upgrade over the link underneath it. No token, a cancelled
 * prompt, a revoked token, JavaScript disabled: every one of those falls back to
 * the two-tap issue flow instead of failing.
 */
function githubOneTapScript(o: PageOptions): string {
	return `<script>
(function () {
  var REPO = ${JSON.stringify(o.repo)};
  var KEY = "grocery-add-pat";
  var toggle;

  var token = function () { return localStorage.getItem(KEY) || ""; };

  function paint() {
    if (!toggle) return;
    toggle.textContent = token() ? "⚡ one-tap on · tap to remove token" : "⚡ enable one-tap";
  }

  function configure() {
    if (token()) {
      if (confirm("Remove the saved token? Add will go back to opening GitHub.")) {
        localStorage.removeItem(KEY);
      }
    } else {
      var t = (prompt(
        "Paste a GitHub fine-grained token for this repo (Contents: read and write).\\n\\n" +
        "It is stored only in this browser."
      ) || "").trim();
      if (t) localStorage.setItem(KEY, t);
    }
    paint();
  }

  function dispatch(btn) {
    var label = btn.textContent;
    btn.dataset.state = "busy";
    btn.textContent = "…";
    fetch("https://api.github.com/repos/" + REPO + "/dispatches", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      // Nested: GitHub rejects a client_payload with over 10 top-level keys.
      body: JSON.stringify({
        event_type: "add-to-list",
        client_payload: { payload: JSON.parse(btn.dataset.add) }
      })
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          // Bad or revoked token: forget it, so the next tap opens the issue.
          localStorage.removeItem(KEY);
          paint();
          throw new Error("auth");
        }
        if (!r.ok) throw new Error(r.status);
        // 204 = GitHub accepted the job. The Notion row lands ~20s later, so
        // "queued" is the honest word; claiming "added" would be a guess.
        btn.dataset.state = "done";
        btn.textContent = "queued";
      })
      .catch(function (e) {
        btn.dataset.state = "failed";
        btn.textContent = e.message === "auth" ? "token?" : "retry";
        setTimeout(function () { btn.dataset.state = ""; btn.textContent = label; }, 4000);
      });
  }

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest) return;
    if (ev.target.closest("#onetap")) { ev.preventDefault(); configure(); return; }

    var btn = ev.target.closest(".add[data-add]");
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    // No token? Do nothing and let the link open the pre-filled issue.
    if (!token()) return;
    ev.preventDefault();
    dispatch(btn);
  });

  toggle = document.getElementById("onetap");
  paint();
})();
</script>
`;
}

/**
 * Client-side half of the relay one-tap path (a Notion Worker webhook). Only
 * emitted when an endpoint is configured; otherwise the page uses the
 * GitHub-direct script above, which needs no service at all.
 *
 * Two constraints shape this, both from the Notion Worker webhook on the other
 * end (see `docs/one-tap-add.md`):
 *
 *  • It returns no CORS headers, so the request must be a "simple" one — POST,
 *    `text/plain`, no custom headers — to avoid a preflight the browser would
 *    reject. `mode: "no-cors"` sends it; the response comes back opaque.
 *  • Opaque means we cannot read the status. The tick therefore means "sent",
 *    not "confirmed" — the row itself shows up in Notion a few seconds later.
 *    That honesty is why this path is opt-in and the issue button is default.
 *
 * The endpoint lives in a public page, so it's gated by a token the user is
 * asked for once and the browser then remembers.
 */
function addScript(o: PageOptions): string {
	if (!o.addEndpoint) return githubOneTapScript(o);
	return `<script>
(function () {
  var endpoint = ${JSON.stringify(o.addEndpoint)};
  var KEY = "grocery-add-token";

  function token() {
    var t = localStorage.getItem(KEY);
    if (!t) {
      t = (prompt("One-time setup: paste your Add token") || "").trim();
      if (t) localStorage.setItem(KEY, t);
    }
    return t;
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest(".add[data-add]") : null;
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    ev.preventDefault();

    var t = token();
    if (!t) return;

    var label = btn.textContent;
    var body = JSON.parse(btn.dataset.add);
    body.token = t;

    btn.dataset.state = "busy";
    btn.textContent = "…";
    fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    })
      .then(function () {
        // Opaque response: delivered, not verified. Say "sent", not "added".
        btn.dataset.state = "done";
        btn.textContent = "sent";
      })
      .catch(function () {
        btn.dataset.state = "failed";
        btn.textContent = "retry";
        setTimeout(function () {
          btn.dataset.state = "";
          btn.textContent = label;
        }, 4000);
      });
  });
})();
</script>
`;
}

export function renderDealsPage(
	planDeals: Deal[],
	otherDeals: Deal[],
	generatedAt = new Date(),
	recommendations: ReviewMiss[] = [],
	options: PageOptions = { repo: "tmje30/NTUC-and-other-scrapers-nutrition" },
): string {
	const o = options;
	const card = (d: Deal) => dealCard(d, o);
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
		? `<h2 class="section">🔻 On sale now</h2>` + saleDeals.map(card).join("")
		: "";

	// Plan section: the non-sale plan deals. If there were no plan deals at all,
	// show the celebratory note; if every plan deal is on sale (already shown
	// above), omit the section rather than render an empty/misleading heading.
	let planSection = "";
	if (planRest.length) {
		planSection = `<h2 class="section">In your plan</h2>` + planRest.map(card).join("");
	} else if (planDeals.length === 0) {
		planSection =
			`<h2 class="section">In your plan</h2>` +
			`<p class="empty-sm">Nothing in your plan is cheaper today. 🎉</p>`;
	}

	const otherSection = otherRest.length
		? `<h2 class="section">Other items on offer</h2>` + otherRest.map(card).join("")
		: "";
	// Recommendations last: not what you asked for, so they must never sit above a
	// real deal or be mistaken for one.
	const recSection = recommendations.length
		? `<h2 class="section">Close matches · not exactly what you asked for</h2>` +
			recommendations.map(recCard).join("")
		: "";
	// Items you've just bought aren't searched at all, so they'd otherwise vanish
	// with no explanation. Say so, and say when each one comes back.
	const snoozed = o.snoozed ?? [];
	const snoozeSection = snoozed.length
		? `<h2 class="section">Recently bought · not searched</h2>` +
			`<p class="empty-sm">` +
			snoozed
				.map(
					(s) =>
						`${esc(s.name)} <span class="pack">back ${esc(
							new Date(s.until).toLocaleDateString("en-SG", {
								day: "numeric",
								month: "short",
								timeZone: "Asia/Singapore",
							}),
						)}</span>`,
				)
				.join(" · ") +
			`</p>`
		: "";

	const cards = saleSection + planSection + otherSection + recSection + snoozeSection;

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
  .card { display: flex; align-items: stretch; gap: 10px; color: inherit; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .body { display: block; flex: 1; min-width: 0; text-decoration: none; color: inherit;
    transition: transform .05s ease; }
  .body:active { transform: scale(.995); }
  /* Add: pushes the item onto the Notion grocery list. Deliberately chunky — it's
     the one thing on this page you tap on purpose rather than to read more. */
  .add { flex: 0 0 auto; align-self: flex-start; display: inline-flex; align-items: center;
    justify-content: center; min-width: 52px; min-height: 34px; padding: 0 12px; font: inherit;
    font-size: .85rem; font-weight: 700; text-decoration: none; cursor: pointer;
    color: #067647; background: #ecfdf3; border: 1px solid #a6f4c5; border-radius: 9px;
    -webkit-tap-highlight-color: transparent; transition: transform .05s ease; }
  .add:active { transform: scale(.94); }
  .add[data-state="busy"] { opacity: .6; }
  .add[data-state="done"] { color: #fff; background: #067647; border-color: #067647; }
  .add[data-state="failed"] { color: #b42318; background: #fef3f2; border-color: #fecdca; }
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
  .card.rec { border-style: dashed; background: #fcfcfd; }
  .tag { color: #6b7280; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 1px 7px; white-space: nowrap; }
  .why { color: #92400e; font-size: .82rem; margin-top: 4px; }
  /* Deliberately quiet: setting a token is a once-per-device errand, not a
     feature to advertise on every visit. */
  .foot { margin: 22px 2px 8px; font-size: .8rem; }
  .foot a { color: #9ca3af; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    .sub, .pack, .meta, .per100, .usage, .section, .empty-sm { color: #9aa1ab; }
    .card { background: #171a1f; border-color: #262b32; box-shadow: none; }
    .pct { color: #6ee7b7; background: #06251a; }
    .store { color: #e5e7eb; }
    .was { color: #6b7280; }
    .mine { color: #facc15; }
    .prodprice { color: #cbd2dc; }
    .card.rec { background: #141619; }
    .tag { border-color: #2c323a; }
    .why { color: #fbbf24; }
    .add { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .add[data-state="done"] { color: #04140e; background: #6ee7b7; border-color: #6ee7b7; }
    .add[data-state="failed"] { color: #fda29b; background: #2b1512; border-color: #5c2420; }
    .foot a { color: #6b7280; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>🛒 Grocery deals</h1>
    <p class="sub">${date} · ${total} deal${total === 1 ? "" : "s"} beating your prices</p>
    ${cards}
    ${
			o.addEndpoint
				? ""
				: `<p class="foot"><a href="#" id="onetap">⚡ enable one-tap</a></p>`
		}
  </div>
${addScript(o)}</body>
</html>`;
}
