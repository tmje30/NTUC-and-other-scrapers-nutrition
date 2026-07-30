import type { Deal, ReviewMiss } from "./compare.js";
import { cooldownKey } from "./cooldown.js";
import { groceryRowTitle, type AddPayload } from "./grocery-list.js";
import type { ActionPayload } from "./item-actions.js";
import type { PlanTarget } from "./notion.js";
import type { StoreProduct } from "./stores/types.js";
import { parseUnitCount, parseWeight } from "./stores/weight.js";

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
	/**
	 * Items being skipped because they were recently bought. `key` (the cooldown
	 * being served) and `ingredientId` are what the Reset button needs; without
	 * them the item still lists, just without its buttons.
	 */
	snoozed?: { name: string; until: string; key?: string; ingredientId?: string }[];
	/**
	 * Set when a shop is missing from this scan — "Sheng Siong data is 1 day old".
	 * Without it, a runner that has quietly stopped working looks exactly like a day
	 * with no Sheng Siong bargains, and the page invites you to trust half a search.
	 */
	warning?: string;
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

/**
 * The `[500g]` bracket — omitted when the name it follows already states that
 * size, since "Captain Oats Instant 500g [500g]" is pure noise. Most store names
 * carry their pack size, so this is the common case, not the exception.
 *
 * Only an exact match is suppressed. A name quoting some other number (a
 * multipack's per-unit size, say) keeps its bracket, because the bracket is the
 * size we actually priced against and the name isn't.
 */
function packTag(name: string, grams: number | null | undefined, volumetric: boolean): string {
	if (!grams || grams <= 0) return "";
	const inName = parseWeight(name)?.grams;
	if (inName != null && Math.abs(inName - grams) < 1) return "";
	return ` <span class="pack">[${packLabel(grams, volumetric)}]</span>`;
}

/**
 * The `[30 pcs]` bracket, for a deal priced by the piece. The count is the whole
 * basis of the comparison there, so it has to be on the card — and for the
 * cheapest egg carton FairPrice sells, the count is the ONLY size it publishes.
 * Suppressed when the name already says it ("Eggs 30s").
 */
function countTag(name: string, count: number | null | undefined): string {
	if (!count || count <= 0) return "";
	if (parseUnitCount(name) === count) return "";
	return ` <span class="pack">[${count} pcs]</span>`;
}

/**
 * What the Add button ships to the workflow: enough to write the row AND set the
 * cooldown.
 *
 * `ingredient` becomes the grocery-list row title, so it's a parameter rather
 * than always `target.name`: a close match needs to say which product it actually
 * is (see `recCard`), while a confident deal is simply the ingredient.
 */
function addPayload(t: PlanTarget, p: StoreProduct, ingredient = t.name): AddPayload {
	// How much was actually bought, in grams — the cooldown's whole input. A pack
	// the shop priced by the piece has no weight of its own, so it's converted at
	// the item's own grams-per-piece: 30 eggs against a 550g/10 carton is 1650g,
	// not the 550g the item's own pack weighs. Falls back to the item's pack when
	// the shop gave neither, and to null (flat 14 days) when nothing is known.
	const gramsPerUnit = t.packWeightG && t.packSize > 0 ? t.packWeightG / t.packSize : null;
	const boughtG =
		p.packWeightG ?? (p.unitCount && gramsPerUnit ? p.unitCount * gramsPerUnit : t.packWeightG);

	return {
		v: 1,
		ingredientId: t.ingredientId,
		ingredient,
		key: cooldownKey(t.search.searchTerm),
		store: p.store,
		product: p.name,
		priceSgd: p.priceSgd,
		myPriceSgd: t.packPriceSgd,
		// Both figures are grams — never `packSize`/`monthlyAmount`, which are piece
		// counts on a By-Unit item.
		packSizeG: boughtG,
		volumetric: p.volumetric,
		monthlyAmount: t.monthlyAmountG,
		url: p.url,
	};
}

/**
 * The Add button — always a plain link to a pre-filled GitHub issue.
 *
 * The page is static, so it can hold no credentials of its own. The link works
 * with JavaScript off, in any browser, forever: tap Add → tap Submit → the
 * `add-to-list` workflow writes the Notion row and the cooldown.
 *
 * `data-payload` carries the same payload as the issue body, which is what lets
 * the one-tap script (see `addScript`) intercept the click and skip the GitHub
 * screen entirely. The link is the floor; one-tap is an upgrade layered on top,
 * so a missing or revoked token degrades to two taps rather than to nothing.
 */
function addButton(p: AddPayload, o: PageOptions): string {
	const label = groceryRowTitle(p.store, p.ingredient);
	const payload = esc(JSON.stringify(p));

	if (o.addEndpoint) {
		return `<button class="add" type="button" data-payload="${payload}"
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
        data-payload="${payload}"
        aria-label="Add ${esc(label)} to the grocery list">Add</a>`;
}

/**
 * The small buttons on a snoozed item. Always the GitHub-issue link, never the
 * relay `addEndpoint`: that endpoint only knows how to add: an item action sent
 * there would be silently dropped, and a button that lies is worse than a button
 * that takes two taps.
 *
 * `data-event` routes the one-tap dispatch to the `item-actions` workflow instead
 * of `add-to-list`; `data-done` is the label to settle on, since "✓ sent" says
 * nothing useful here.
 */
function actionButton(
	p: ActionPayload,
	o: PageOptions,
	ui: { label: string; done: string; aria: string; prose: string; confirm?: string },
): string {
	const body =
		`${ui.prose}\n\n` +
		"```json\n" +
		`${JSON.stringify(p, null, 2)}\n` +
		"```\n";
	// "Item: " is what the workflow's allowlist gate matches on — a fixed prefix
	// rather than the button's label, so renaming a button can't quietly stop the
	// two-tap path from being honoured.
	const href =
		`https://github.com/${o.repo}/issues/new` +
		`?title=${encodeURIComponent(`Item: ${ui.label} — ${p.name}`)}` +
		`&labels=grocery-add` +
		`&body=${encodeURIComponent(body)}`;

	return `<a class="act" href="${esc(href)}" target="_blank" rel="noopener"
        data-payload="${esc(JSON.stringify(p))}" data-event="item-action"
        data-done="${esc(ui.done)}"${ui.confirm ? ` data-confirm="${esc(ui.confirm)}"` : ""}
        aria-label="${esc(ui.aria)}">${esc(ui.label)}</a>`;
}

/** One line in "Recently bought · not searched": the item, when it's back, its buttons. */
function snoozeRow(s: NonNullable<PageOptions["snoozed"]>[number], o: PageOptions): string {
	const back = new Date(s.until).toLocaleDateString("en-SG", {
		day: "numeric",
		month: "short",
		timeZone: "Asia/Singapore",
	});

	// No key means nothing can be acted on — list the item plainly rather than
	// offering buttons that would post an unusable payload. "Not in use" also
	// needs the ingredient row itself, so it's gated on the id as well.
	const id = s.ingredientId ?? "";
	const reset = s.key
		? actionButton({ v: 1, action: "reset", key: s.key, ingredientId: id, name: s.name }, o, {
				label: "Reset",
				done: "✓ reset",
				aria: `Reset ${s.name} — search for it again`,
				prose:
					`Resetting **${s.name}** from the deals page: clear its cooldown so the ` +
					`next daily scan searches for it again.`,
			})
		: "";
	// Confirmed, unlike Reset: this one edits the Notion inventory, and undoing it
	// means finding the row and removing the tag by hand.
	const park =
		s.key && id
			? actionButton({ v: 1, action: "park", key: s.key, ingredientId: id, name: s.name }, o, {
					label: "Not in use",
					done: "✓ tagged",
					aria: `Tag ${s.name} as not in use — stop searching for it`,
					// One line, deliberately: a newline here would sit raw inside an HTML
					// attribute, and the dialog reads fine without it.
					confirm:
						`Tag "${s.name}" as Not in Use ATM? ` +
						`It stops being searched until you remove the tag in Notion.`,
					prose:
						`Parking **${s.name}** from the deals page: tag the ingredient ` +
						`\`Not in Use ATM\` so it is no longer searched, and clear its cooldown.`,
				})
			: "";
	const buttons = reset + park;

	return `
    <div class="snooze">
      <span class="sname">${esc(s.name)}</span>
      <span class="pack">back ${esc(back)}</span>
      <span class="acts">${buttons}</span>
    </div>`;
}

function dealCard(d: Deal, o: PageOptions): string {
	const t = d.target; // your ingredient (the "main item")
	const p = d.product; // the cheaper store product we found
	const u = bigUnit(p.volumetric); // "kg" (or "L" for liquids)
	const small = smallUnit(p.volumetric); // "100g" (or "100ml")

	// Pack-size brackets — same style, one per line, dropped where the name already
	// says it. A per-piece deal brackets the COUNT instead: that's what was compared,
	// and a count-only carton has no weight to show anyway.
	const byPiece = d.dimension === "unit";
	const itemPack = byPiece
		? countTag(t.name, t.packSize)
		: packTag(t.name, t.packWeightG, p.volumetric);
	const prodPack = byPiece
		? countTag(p.name, p.unitCount)
		: packTag(p.name, p.packWeightG, p.volumetric);

	// Prices — build each piece once, then arrange them in the rows below.
	const myPrice = `$${t.packPriceSgd.toFixed(2)}`; // what you pay for your own pack
	const prodPrice = `$${p.priceSgd.toFixed(2)}`; // the found product's current price
	// Row 3 is always "what one of these costs, versus what you pay for one" — per
	// kg/L when compared by weight, per piece when compared by the piece. Pieces are
	// cheap enough to need 3 decimals: eggs differ by fractions of a cent.
	const baseKg = byPiece ? `$${d.baseline.toFixed(3)} each` : `$${(d.baseline * 10).toFixed(2)}/${u}`;
	const dealKg = byPiece
		? `$${d.productPrice.toFixed(3)} each`
		: `$${(d.productPrice * 10).toFixed(2)}/${u}`;

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
      ${addButton(addPayload(t, p), o)}
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

/** Is this near-miss priced at all, and cheaper than the item's own baseline? */
function recIsCheaper(r: ReviewMiss): boolean {
	return (
		r.dimension != null &&
		r.productPrice != null &&
		r.baseline != null &&
		r.baseline > 0 &&
		r.productPrice < r.baseline
	);
}

/**
 * A close-but-not-exact match. Laid out exactly like a deal card — same rows in
 * the same order, same Add button, same green saving badge — so the two read as
 * one list and nothing has to be re-learned. Only three things mark it out: the
 * dashed border, the "closest" label under the percentage, and the line naming
 * the defining property it failed.
 *
 * Only ever called with a cheaper match (see `recIsCheaper`), so the percentage
 * is always a saving.
 */
function recCard(r: ReviewMiss, o: PageOptions): string {
	const t = r.target;
	const p = r.product;
	const u = bigUnit(p.volumetric);

	// Same two-dimension rules as a deal card — see `dealCard`.
	const byPiece = r.dimension === "unit";
	const itemPack = byPiece
		? countTag(t.name, t.packSize)
		: packTag(t.name, t.packWeightG, p.volumetric);
	const prodPack = byPiece
		? countTag(p.name, p.unitCount)
		: packTag(p.name, p.packWeightG, p.volumetric);

	const myPrice = t.packPriceSgd > 0 ? ` <span class="mine">Price $${t.packPriceSgd.toFixed(2)}</span>` : "";
	const prodBig = byPiece
		? `$${r.productPrice!.toFixed(3)} each`
		: `$${(r.productPrice! * 10).toFixed(2)}/${u}`;
	const baseBig = byPiece ? `$${r.baseline!.toFixed(3)} each` : `$${(r.baseline! * 10).toFixed(2)}/${u}`;
	const savingPct = ((r.baseline! - r.productPrice!) / r.baseline!) * 100;

	const usage =
		t.unitType === "By Unit" ? `${t.monthlyAmount} units` : amount(t.monthlyAmount, p.volumetric);

	const why = r.missing.length
		? `<div class="why">not <b>${esc(r.missing.join(", "))}</b> — check before buying</div>`
		: `<div class="why">close match — check before buying</div>`;

	// The row title names the product, not just the ingredient: this is explicitly
	// NOT the thing you asked for, so a bare "[NTUC] Organic Rolled Oats" would
	// send you hunting at the shop for something the store doesn't stock at that
	// price. Adding it still snoozes the ingredient — you came home with oats.
	const payload = addPayload(t, p, `${t.name} ≈ ${p.name}`);

	return `
    <div class="card rec">
      ${addButton(payload, o)}
      <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
        <div class="row1">
          <span class="name">${esc(t.name)}${itemPack}${myPrice}</span>
          <span class="pctcol"><span class="pct">−${savingPct.toFixed(0)}%</span><span class="tag">closest</span></span>
        </div>
        <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)}${prodPack} <span class="prodprice">$${p.priceSgd.toFixed(2)}</span></div>
        <div class="price"><b>${prodBig}</b> <span class="was">vs ${baseBig}</span></div>
        ${t.inActivePlan ? `<div class="usage">uses ~${usage}/month</div>` : ""}
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
        event_type: btn.dataset.event || "add-to-list",
        client_payload: { payload: JSON.parse(btn.dataset.payload) }
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
        // 204 = GitHub accepted the job; the row appears ~15s later. This is the
        // FINAL state — nothing polls afterwards — so the label has to read as
        // finished. "queued" did not: it looks like a pending state, and you sit
        // there waiting for it to change into something else.
        btn.dataset.state = "done";
        btn.textContent = btn.dataset.done || "✓ sent";
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

    // Every button on the page carries its payload the same way — Add, and the
    // Reset/park buttons on a snoozed item. data-event picks the workflow.
    var btn = ev.target.closest("[data-payload]");
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    // No token? Do nothing and let the link open the pre-filled issue.
    if (!token()) return;
    // Only the destructive buttons set data-confirm. Cancelling must not fall
    // through to the link, or "no" would open the issue form instead.
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    dispatch(btn);
  });

  // Shared setup link: opening ".../#add-token=XXX" stores the token and strips
  // it back out of the address bar, so a second person (partner sharing the
  // page) is set up by tapping one link instead of pasting a token on a phone.
  // The fragment is never sent to the server — but it DOES persist in whatever
  // chat you sent it through, so treat such a link as the secret it contains.
  var shared = location.hash.match(/[#&]add-token=([^&]+)/);
  if (shared) {
    localStorage.setItem(KEY, decodeURIComponent(shared[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }

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
    // Relay path: adds only. The item-action buttons keep their issue links.
    var btn = ev.target.closest ? ev.target.closest(".add[data-payload]") : null;
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    ev.preventDefault();

    var t = token();
    if (!t) return;

    var label = btn.textContent;
    var body = JSON.parse(btn.dataset.payload);
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
	// real deal or be mistaken for one. A near-miss that isn't cheaper is worth
	// nothing here — it's neither the right product NOR a saving — so it's dropped
	// rather than shown with a badge pointing the wrong way. (`runOnce` already
	// filters on this; enforced here too so any caller gets the same page.)
	const recs = recommendations.filter(recIsCheaper);
	const recSection = recs.length
		? `<h2 class="section">Close matches · not exactly what you asked for</h2>` +
			recs.map((r) => recCard(r, o)).join("")
		: "";
	// Items you've just bought aren't searched at all, so they'd otherwise vanish
	// with no explanation. Say so, and say when each one comes back.
	const snoozed = o.snoozed ?? [];
	const snoozeSection = snoozed.length
		? `<h2 class="section">Recently bought · not searched</h2>` +
			snoozed.map((s) => snoozeRow(s, o)).join("")
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
  .add[data-state="busy"], .act[data-state="busy"] { opacity: .6; }
  .add[data-state="done"] { color: #fff; background: #067647; border-color: #067647; }
  .add[data-state="failed"], .act[data-state="failed"] { color: #b42318; background: #fef3f2; border-color: #fecdca; }
  /* Recently-bought rows: quieter than a card, but the buttons still need a
     thumb-sized target, so the row is taller than the old one-line paragraph. */
  .snooze { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 5px 2px; }
  .sname { font-weight: 600; font-size: .95rem; }
  .acts { margin-left: auto; display: flex; gap: 6px; }
  .act { display: inline-flex; align-items: center; justify-content: center; min-height: 32px;
    padding: 0 10px; font: inherit; font-size: .78rem; font-weight: 600; text-decoration: none;
    cursor: pointer; color: #4b5563; background: #f3f4f6; border: 1px solid #e5e7eb;
    border-radius: 8px; white-space: nowrap; -webkit-tap-highlight-color: transparent;
    transition: transform .05s ease; }
  .act:active { transform: scale(.94); }
  .act[data-state="done"] { color: #067647; background: #ecfdf3; border-color: #a6f4c5; }
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
  /* A shop missing from the scan. Loud enough to notice, quiet enough not to
     look like an error page — the deals below are still real. */
  .warn { color: #92400e; background: #fffaeb; border: 1px solid #fedf89; border-radius: 10px;
    font-size: .85rem; margin: 0 2px 14px; padding: 8px 12px; }
  .card.rec { border-style: dashed; background: #fcfcfd; }
  /* Percentage on top, "closest" beneath it, both hugging the right edge. */
  .pctcol { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
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
    .warn { color: #fbbf24; background: #241a06; border-color: #4a3410; }
    .add { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .add[data-state="done"] { color: #04140e; background: #6ee7b7; border-color: #6ee7b7; }
    .add[data-state="failed"], .act[data-state="failed"] { color: #fda29b; background: #2b1512; border-color: #5c2420; }
    .act { color: #cbd2dc; background: #1c2026; border-color: #2c323a; }
    .act[data-state="done"] { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .foot a { color: #6b7280; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>🛒 Grocery deals</h1>
    <p class="sub">${date} · ${total} deal${total === 1 ? "" : "s"} beating your prices</p>
    ${o.warning ? `<p class="warn">⚠️ ${esc(o.warning)}</p>` : ""}
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
