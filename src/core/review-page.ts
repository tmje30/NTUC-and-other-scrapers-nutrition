import {
	REVIEW_GROUPS,
	groupOf,
	reasonsFor,
	type PendingReview,
	type ReviewReason,
} from "./vendor-review.js";
import { cooldownKey } from "./cooldown.js";
import { parseName } from "./parse.js";
import { githubOneTapScript } from "./page-chrome.js";

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
 * ⚠️⚠️ **The same one-tap script the deals page uses, for the same reason.** The
 * buttons already carried `data-payload` and `data-event="item-action"` — the
 * attributes that script reads — but the page never emitted the script, so every tap
 * opened GitHub. Reported 2026-09-03: *"when i click a button, it goes into github. i
 * don't want that."* The token lives in `localStorage` on this origin, so a token
 * already pasted on the deals page works here with nothing further to do.
 *
 * ⚠️ Strictly an upgrade over the links underneath. No token, a cancelled prompt, a
 * revoked token, JavaScript off: every one falls back to the two-tap issue flow.
 *
 * ⚠️ Never the relay `addEndpoint` path, which only knows how to ADD — an item action
 * sent there is silently dropped. Same rule as the deals page's own action buttons.
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
/**
 * ⚠️⚠️ **The price comparison is a table, not a sentence.** It was one line carrying
 * two prices, two pack sizes and two per-unit figures joined by an arrow — the reader has
 * to parse it before they can judge it, and judging it is the entire question. Asked for
 * 2026-09-04: the two per-unit figures stacked, labelled, and the new one coloured by
 * direction.
 *
 * ⚠️ Colour is decided by the NUMBERS, not by the reason's name. A `dearer-than-
 * recorded` card is red by construction, but the same block renders a near-miss whose
 * price happens to be lower, and painting that red because of the label would be the
 * card contradicting its own figures.
 *
 * ⚠️ Colour is never the only signal — each row is labelled *current* / *new* in text.
 * Red and green alone would say nothing to a red-green colourblind reader, and this is
 * the one control on the page that writes to the price book.
 */
function comparison(r: Extract<ReviewReason, { kind: "dearer-than-recorded" }>): string {
	const per = r.perWord ?? "1000";
	// ⚠️⚠️ **A card missing its figures renders as nothing, not as an exception.** This
	// block builds a PAGE, and the page build runs inside the sweep: on 2026-09-06 one
	// reason carrying pre-rename field names threw `undefined.toFixed` here and killed a
	// live `--write` run after it had already written prices to Notion. Whatever else is
	// wrong with one queued question, it must not be able to do that. The read boundary
	// repairs the known case (`withLegacyPerFields`); this is the backstop for the next
	// shape nobody predicted.
	if (typeof r.recordedPer !== "number" || typeof r.foundPer !== "number") return "";
	const money = (n: number) => `$${n.toFixed(2)}/${esc(per)}`;
	const cheaper = r.foundPer < r.recordedPer;
	return `<div class="cmp">
  <div class="cmp-h">Dearer than current${r.vendor ? ` ${esc(r.vendor)}` : ""} price</div>
  <div class="cmp-r"><span class="fig cur">${money(r.recordedPer)}</span><span class="lab">current</span></div>
  <div class="cmp-r"><span class="fig ${cheaper ? "down" : "up"}">${money(r.foundPer)}</span><span class="lab">new</span></div>
  <div class="cmp-f">Accept only if the price is acceptable.</div>
</div>`;
}

/**
 * Drop the clause that states WHICH suggestion this is — "this is alternative 2 of 3,
 * offered as a suggestion" — leaving what only the note can say.
 *
 * ⚠️ **On the page, inside a deck, and nowhere else** (user, 2026-09-07). A slide already
 * carries "OPTION 2 OF 3" above it and "3 products … could be this row" above that, so
 * the clause is the third statement of the same fact on one card. What survives is the
 * part nothing else says: nothing MATCHED, and accept only if it is the same thing.
 *
 * ⚠️ The stored note is left ALONE. It is written when a question is queued, so editing
 * it would change nothing for the questions already in the queue until a sweep re-queued
 * them — and the same sentence goes to Telegram, where there is no deck and no label
 * above it, and the position earns its place. The page knows it is a deck; the note does
 * not have to.
 */
function withoutPosition(note: string): string {
	return note.replace(/\s*—\s*this is [^.]*\.\s*/i, ". ");
}

function reasonList(reasons: ReviewReason[], inDeck = false): string {
	if (!reasons.length) return "";
	const cmp = reasons.filter((r) => r.kind === "dearer-than-recorded").map(comparison).join("");
	const rest = reasons.filter((r) => r.kind !== "dearer-than-recorded");
	const text = (r: ReviewReason) =>
		inDeck && r.kind === "near-miss" ? withoutPosition(r.note) : r.note;
	return (
		cmp +
		(rest.length ? `<ul class="why">${rest.map((r) => `<li class="r-${esc(r.kind)}">${esc(text(r))}</li>`).join("")}</ul>` : "")
	);
}

function button(
	p: PendingReview,
	o: ReviewPageOptions,
	ui: {
		action: string;
		label: string;
		done: string;
		cls: string;
		prose: string;
		reason?: string;
		/**
		 * `data-hide-card` scope, read by the shared one-tap script — see `hideCards`.
		 *
		 * ⚠️ Only ever set on **OK inside a deck**, and only because accepting settles the
		 * whole slot: the queue drops the losing options too (`withoutPendingForSlot`), so
		 * leaving them on screen would show questions that no longer exist. **Don't use**
		 * never carries it — refusing one product says nothing about the next.
		 *
		 * ⚠️ The two-tap fallback never reaches it, deliberately: there the click opens an
		 * issue the user may abandon, and cards that vanished on a request never sent would
		 * be the page lying about what it did.
		 */
		hide?: string;
	},
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
        data-done="${esc(ui.done)}"${ui.hide ? ` data-hide-card="${esc(ui.hide)}"` : ""}
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

/** Which row, at which shop. Shared by every option in a deck, so it is hoisted out. */
function head(p: PendingReview): string {
	return `<div class="hd">
      <span class="ing">${esc(p.ingredientName)}</span>
      <span class="shop">${esc(p.vendor)}</span>
    </div>`;
}

/**
 * One pick: what it costs, what it is, why it is being asked about, and the two answers.
 *
 * ⚠️ The whole body is the link to the shop — the question being asked is "is this the
 * right pack?", and you cannot answer it without looking at the thing. A small link
 * buried under a price made that a deliberate act; this makes it the obvious one. The
 * buttons sit OUTSIDE the anchor so they stay separately tappable.
 */
function face(
	p: PendingReview,
	o: ReviewPageOptions,
	opt: { withHead: boolean; hide?: string; inDeck?: boolean },
): string {
	return `<a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
    ${opt.withHead ? head(p) : ""}
    <div class="price"><b>$${p.priceSgd.toFixed(2)}</b> / ${esc(p.size)}${esc(unitWord(p.unitType))}${
			p.perLabel ? ` <span class="per">= ${esc(p.perLabel)}</span>` : ""
		}</div>
    <div class="prod">${esc(p.itemName)}${
			p.statedSize ? ` <span class="stated">(${esc(p.statedSize)})</span>` : ""
		}${p.brandName ? ` <span class="maker">[${esc(p.brandName)}]</span>` : ""} <span class="go">↗</span></div>
    ${reasonList(p.reasons, opt.inDeck)}
  </a>
  <div class="acts">
    ${button(p, o, {
			action: "review-ok",
			label: "OK",
			done: "✓ recorded",
			cls: "ok",
			hide: opt.hide,
			prose: `Recording this price against **${p.ingredientName}** at **${p.vendor}** from the review page.`,
		})}
    ${rejectMenu(p, o)}
  </div>`;
}

function card(p: PendingReview, o: ReviewPageOptions): string {
	return `<article class="card">
  ${face(p, o, { withHead: true })}
</article>`;
}

/**
 * **Several products offered for ONE slot, as slides rather than as stacked cards.**
 *
 * ⚠️ Asked for 2026-09-06, looking at the CeraVe row: two NTUC cards, identical headers,
 * one question. `nearMisses` offers up to `MAX_SUGGESTIONS` picks per row×shop and each
 * became a full card, so the page repeated the item name and the shop for every one and
 * gave no sign they were competing for the same slot. They are alternatives, and a deck
 * is what alternatives look like.
 *
 * ⚠️ **Only built for a real contest — two or more options.** A lone question stays a
 * plain card: a one-slide carousel with a "1 of 1" counter is a control that suggests
 * there is something else to see.
 *
 * ⚠️ **No JavaScript in the sliding.** Scroll-snap does it, the dots are ordinary
 * fragment links, and with scripting off the deck degrades to a horizontally scrollable
 * strip that still shows every option and still has working buttons — the same standard
 * the rest of this page holds itself to.
 */
function deck(options: PendingReview[], o: ReviewPageOptions): string {
	const first = options[0]!;
	const gid = `${first.ingredientId}|${first.vendor}`;
	const slides = options
		.map(
			(p, i) => `<section class="slide" id="opt-${esc(p.token)}">
    <p class="which">Option ${i + 1} of ${options.length}${i === 0 ? " · closest match" : ""}</p>
    ${face(p, o, { withHead: false, hide: "group", inDeck: true })}
  </section>`,
		)
		.join("\n  ");
	const dots = options
		.map(
			(p, i) =>
				`<a href="#opt-${esc(p.token)}" aria-label="${esc(`Option ${i + 1} of ${options.length}: ${p.itemName}`)}">${i + 1}</a>`,
		)
		.join("");
	return `<article class="card deck" data-group="${esc(gid)}">
  ${head(first)}
  <p class="multi">${options.length} products at ${esc(first.vendor)} could be this row — drag or swipe between them. Accepting one drops the rest.</p>
  <div class="slides">
  ${slides}
  </div>
  <nav class="dots">${dots}</nav>
</article>`;
}

/**
 * Group the queue by the thing a question is actually about: **one row's slot at one
 * shop.** That is the unit the price book writes and the unit `withoutPendingForSlot`
 * clears, so it is the unit the page should ask about.
 *
 * ⚠️ Groups appear in the order their FIRST question sits in the queue, so an unrelated
 * regrouping never reshuffles the page. Within a group the order is `rank` — closest
 * match first — because the queue's own order is the reverse of that (see `rank`).
 */
function decks(pending: PendingReview[]): PendingReview[][] {
	const order: string[] = [];
	const by = new Map<string, PendingReview[]>();
	for (const p of pending) {
		const k = `${p.ingredientId}|${p.vendor}`;
		if (!by.has(k)) {
			by.set(k, []);
			order.push(k);
		}
		by.get(k)!.push(p);
	}
	// Stable, so questions with no rank keep exactly the order they arrived in.
	return order.map((k) => by.get(k)!.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)));
}

export function renderReviewPage(pending: PendingReview[], o: ReviewPageOptions): string {
	const when = (o.generatedAt ?? new Date()).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
	const groups = decks(pending);

	/**
	 * ⚠️⚠️ **Tabs, and no JavaScript in them** (user, 2026-09-09). Radio inputs plus a
	 * sibling selector: with scripting off every section is simply shown, which is the
	 * same standard the deck holds itself to. A tabbed page that goes blank without JS
	 * would hide the queue rather than degrade it.
	 *
	 * ⚠️ An empty tab is still rendered, with its count — a tab that disappears when it
	 * empties makes the page look different every morning for no reason the reader can
	 * see.
	 */
	const tabbed = REVIEW_GROUPS.map((g) => ({
		...g,
		decks: groups.filter((d) => groupOf(d[0]!.category ?? "") === g.key),
	}));
	const counted = tabbed.map((t) => ({ ...t, n: t.decks.reduce((a, d) => a + d.length, 0) }));
	// The first tab holding anything opens, so the page never lands on an empty one.
	const opening = counted.find((t) => t.n > 0)?.key ?? counted[0]!.key;

	const tabs = counted
		.map(
			(t) =>
				`<input type="radio" name="tab" id="tab-${t.key}" class="tabin"${t.key === opening ? " checked" : ""}>`,
		)
		.join("");
	const tabBar = counted
		.map((t) => `<label class="tab" for="tab-${t.key}">${esc(t.label)} <span class="n">${t.n}</span></label>`)
		.join("");
	const panels = counted
		.map(
			(t) =>
				`<section class="panel p-${t.key}">` +
				(t.decks.length
					? t.decks.map((g) => (g.length > 1 ? deck(g, o) : card(g[0]!, o))).join("\n")
					: `<p class="empty">Nothing waiting under ${esc(t.label)}.</p>`) +
				`</section>`,
		)
		.join("");

	const body = pending.length
		? `${tabs}<nav class="tabs">${tabBar}</nav>${panels}`
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
/* ⚠️ Tabs with no JavaScript: radios carry the state, a sibling selector shows the panel.
   The radios sit before .tabs in the markup so ~ can reach both the labels and the panels. */
.tabin { position:absolute; opacity:0; pointer-events:none; }
.tabs { display:flex; gap:6px; margin:0 0 14px; flex-wrap:wrap; }
.tab { cursor:pointer; padding:7px 12px; border:1px solid var(--line); border-radius:999px;
  font-size:.86rem; font-weight:600; color:var(--mut); user-select:none; }
.tab .n { opacity:.7; font-weight:400; }
/* ⚠️ Every panel is shown when nothing is checked — the scripting-off, CSS-failed floor. */
.panel { display:block; }
#tab-food:checked ~ .tabs [for=tab-food],
#tab-supplements:checked ~ .tabs [for=tab-supplements],
#tab-household:checked ~ .tabs [for=tab-household],
#tab-cosmetics:checked ~ .tabs [for=tab-cosmetics] { color:var(--fg); border-color:var(--fg); }
/* Only once a radio IS checked does hiding begin, so the floor above still holds. */
.tabin:checked ~ .panel { display:none; }
#tab-food:checked ~ .p-food,
#tab-supplements:checked ~ .p-supplements,
#tab-household:checked ~ .p-household,
#tab-cosmetics:checked ~ .p-cosmetics { display:block; }
.tab:focus-within, .tabin:focus-visible + .tabs .tab { outline:2px solid var(--fg); }
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
/* The shop's own words for the pack, and whose product it is. */
.stated { color:var(--mut); }
.maker { color:var(--mut); font-weight:600; }
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
.cmp { margin:10px 0; border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
.cmp-h { font-size:.82rem; font-weight:600; color:var(--mut); margin-bottom:7px; }
.cmp-r { display:flex; align-items:baseline; gap:9px; margin:3px 0; }
.cmp-r .fig { font-size:1.02rem; font-weight:600; font-variant-numeric:tabular-nums; min-width:8.5ch; }
.cmp-r .fig.cur { color:var(--fg); }
.cmp-r .fig.up { color:var(--no); }
.cmp-r .fig.down { color:var(--ok); }
.cmp-r .lab { font-size:.8rem; color:var(--mut); }
.cmp-f { font-size:.8rem; color:var(--mut); margin-top:7px; }
/* A deck — one slot, several candidates, one slide each. Scroll-snap does the sliding;
   the dots are fragment links, so none of this needs JavaScript. */
.deck .slides { display:flex; gap:14px; overflow-x:auto; scroll-snap-type:x mandatory;
  -webkit-overflow-scrolling:touch; scrollbar-width:none; }
.deck .slides::-webkit-scrollbar { display:none; }
.deck .slide { flex:0 0 100%; min-width:0; scroll-snap-align:start; }
/* Drag affordance for a MOUSE. A finger needs none — it just scrolls the strip. */
.deck .slides { cursor:grab; }
.deck .slides.grabbing { cursor:grabbing; user-select:none; }
.deck .slides a { cursor:pointer; }
.multi { color:var(--mut); font-size:.82rem; margin:6px 0 10px; }
.which { color:var(--mut); font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; margin:0 0 7px; }
.dots { display:flex; gap:6px; justify-content:center; margin-top:12px; }
.dots a { min-width:28px; text-align:center; padding:4px 8px; border:1px solid var(--line);
  border-radius:999px; color:var(--mut); text-decoration:none; font-size:.8rem; font-variant-numeric:tabular-nums; }
.dots a:hover, .dots a:focus-visible { color:var(--fg); border-color:var(--mut); outline:none; }
/* hideCards adds this before removing the card; without it an accepted deck vanishes (no backticks here: template literal)
   between two frames and the ✓ that confirmed it is never read. */
.card.going { opacity:0; transform:scale(.98); transition:opacity .2s ease, transform .2s ease; }
.empty { color:var(--mut); }
.foot { color:var(--mut); font-size:.82rem; margin-top:22px; }
.foot a { color:inherit; }
</style></head>
<body>
<h1>Prices to check</h1>
<p class="sub"><span id="waiting">${pending.length}</span> waiting · ${esc(when)}</p>
<p class="note"><b>OK</b> records the price. <b>Don't use</b> doesn't — and that is all it does:
the product still appears on your deals page. To drop it from there too, use <b>Ignore</b> on the deals page.</p>
${body}
<p class="foot"><a href="#" id="onetap">⚡ enable one-tap</a></p>
${githubOneTapScript({ repo: o.repo })}
<script>
(function () {
  // The shared one-tap script removes an accepted deck but knows nothing about this
  // page's own counter, and "55 waiting" printed over a page with 40 cards left is the
  // header describing a queue that no longer exists. Re-derived from the DOM rather
  // than tracked, so it stays right however many questions one tap settles.
  //
  // Counted in QUESTIONS, not cards: a deck is one card holding several. A page with no
  // MutationObserver just keeps the number it was built with, which is what it did before.
  //
  // ⚠️⚠️ NO subtree, and the page hanging is why. Writing the count is itself a DOM
  // mutation, so a subtree observer on body re-triggers on its own write and spins
  // forever. It did not even need a card to be removed to start: the one-tap script
  // paints its own label on load, this fired on that, and the tab locked up before
  // anything could be tapped (reported 2026-09-07, "Page Unresponsive").
  //
  // Cards are DIRECT children of body, so plain childList sees every removal, while the
  // two things that rewrite text — this counter inside p.sub and the one-tap toggle
  // inside p.foot — are one level down and invisible to it. The equality guard below is
  // the second lock on the same door. (No backticks in here: template literal.)
  var label = document.getElementById("waiting");
  if (!label || !window.MutationObserver) return;
  var last = null;
  var recount = function () {
    var n =
      document.querySelectorAll(".deck .slide").length +
      document.querySelectorAll(".card:not(.deck)").length;
    if (n === last) return;
    last = n;
    label.textContent = String(n);
  };
  new MutationObserver(recount).observe(document.body, { childList: true });
})();

(function () {
  // Drag a deck sideways with a MOUSE, the way a finger already drags it.
  //
  // ⚠️ Mouse only, deliberately. A touchscreen scrolls this strip natively, with
  // momentum and rubber-banding the platform tunes and this cannot match; intercepting
  // touch here would replace something good with something worse. Asked for 2026-09-07
  // — the dots were the only way to move between options with a mouse.
  //
  // ⚠️ The whole card body is a link to the shop, so a drag that ends on it would
  // otherwise open the product. The click after a real drag is swallowed in the capture
  // phase, before the anchor sees it.
  var drag = null;
  var swallow = false;

  document.addEventListener("pointerdown", function (ev) {
    if (ev.pointerType !== "mouse" || ev.button !== 0 || !ev.target.closest) return;
    var strip = ev.target.closest(".slides");
    if (!strip) return;
    drag = { strip: strip, x: ev.clientX, y: ev.clientY, from: strip.scrollLeft, moving: false };
  });

  document.addEventListener("pointermove", function (ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.x;
    // Sideways only, and only past a threshold: a vertical drag is the user scrolling
    // the PAGE, and stealing it would trap them inside the deck.
    if (!drag.moving) {
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(ev.clientY - drag.y)) return;
      drag.moving = true;
      drag.strip.classList.add("grabbing");
    }
    drag.strip.scrollLeft = drag.from - dx;
    if (ev.cancelable) ev.preventDefault();
  });

  function release() {
    if (!drag) return;
    var strip = drag.strip, moved = drag.moving;
    drag = null;
    if (!moved) return;
    strip.classList.remove("grabbing");
    // ⚠️ scroll-snap does NOT re-snap after a scrollLeft set from script, so a drag that
    // stops between two options would leave both half shown. Snap to the nearest.
    var gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    var step = strip.clientWidth + gap;
    if (step > 0) strip.scrollTo({ left: Math.round(strip.scrollLeft / step) * step, behavior: "smooth" });
    swallow = true;
  }
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);

  document.addEventListener("click", function (ev) {
    if (!swallow) return;
    swallow = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
})();
</script>
</body></html>`;
}
