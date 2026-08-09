import type { BlockedProduct, ExclusionFile } from "./exclusions.js";
import { ALL_ITEMS } from "./exclusions.js";
import type { ActionPayload } from "./item-actions.js";
import type { ParkedIngredient } from "./notion.js";
import { PAGE_CSS, addScript, type ChromeOptions } from "./page-chrome.js";
import type { PurchaseEntry, PurchaseFile } from "./purchases.js";
import { filedPurchases, openPurchases } from "./purchases.js";

/**
 * The history page — `public/history.html`, one click down from the deals page.
 *
 * The deals page answers "what should I buy today". Everything that page has to
 * forget in order to stay readable ends up here:
 *
 *   Not in use          — ingredients tagged `Not in Use ATM`, which
 *                         `readGroceryTargets` drops so hard they otherwise have
 *                         no listing anywhere. Reset removes the tag.
 *   Bought              — what you actually put on the grocery list, with the
 *                         three buttons that file it into Ingredients.
 *   Already filed       — the same rows once they're settled, kept as a record.
 *   Never buy again     — the permanent product blocks, so a ban is visible
 *                         rather than being an invisible edit to a JSON file.
 *
 * Same rules as the deals page and for the same reason: the page is static and
 * holds no credentials, so every button is a link to a pre-filled GitHub issue,
 * upgraded to one tap when the browser has a token. CSS and script come from
 * `page-chrome.ts` so the two pages cannot drift apart visually.
 */

export interface HistoryOptions extends ChromeOptions {
	/** Ingredients wearing the parked tag (see `readParkedIngredients`). */
	parked: ParkedIngredient[];
	/** The purchase log. */
	purchases: PurchaseFile;
	/** Exclusions — the `ALL_ITEMS` products become the never-buy list. */
	exclusions: ExclusionFile;
	/**
	 * Set when the parked list could not be read (no Notion token, API down).
	 * An empty section and a failed lookup look identical otherwise, and "you have
	 * nothing parked" is a much worse thing to say wrongly than to not say.
	 */
	parkedError?: string;
}

function esc(s: string): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const money = (n: number | null | undefined) =>
	typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";

function sizeLabel(size: number | null | undefined, volumetric: boolean): string {
	if (!size || size <= 0) return "";
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return size >= 1000 ? `${+(size / 1000).toFixed(2)}${big}` : `${Math.round(size)}${small}`;
}

function dayLabel(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	return new Date(t).toLocaleDateString("en-SG", {
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
}

/**
 * One button. Identical contract to the deals page's `actionButton` — a
 * pre-filled issue link carrying `data-payload`, which the shared script
 * intercepts when a token is set.
 *
 * Not shared as code with `site.ts` on purpose: that one builds its title from
 * the ingredient and knows about `terms` prompts, and folding both into one
 * function would mean a parameter for every difference. The contract they share
 * is the DATA (`data-payload`, `data-event`, `data-done`, `data-confirm`), and
 * that lives in `page-chrome.ts` where the script reads it.
 */
function button(
	p: ActionPayload,
	o: HistoryOptions,
	ui: { label: string; done: string; aria: string; prose: string; subject: string; cls?: string; confirm?: string },
): string {
	const body = `${ui.prose}\n\n` + "```json\n" + `${JSON.stringify(p, null, 2)}\n` + "```\n";
	// "Item: " is the prefix the workflow's allowlist gate matches on — the same
	// gate the deals page passes through, so a new button needs no workflow change.
	const href =
		`https://github.com/${o.repo}/issues/new` +
		`?title=${encodeURIComponent(`Item: ${ui.label} — ${ui.subject}`)}` +
		`&labels=grocery-add` +
		`&body=${encodeURIComponent(body)}`;

	return `<a class="act${ui.cls ? ` ${ui.cls}` : ""}" href="${esc(href)}" target="_blank" rel="noopener"
        data-payload="${esc(JSON.stringify(p))}" data-event="item-action"
        data-done="${esc(ui.done)}"${ui.confirm ? ` data-confirm="${esc(ui.confirm)}"` : ""}
        aria-label="${esc(ui.aria)}">${esc(ui.label)}</a>`;
}

/** One parked ingredient, with the Reset that clears its tag. */
function parkedRow(p: ParkedIngredient, o: HistoryOptions): string {
	const others = p.tags.filter((t) => t !== "Not in Use ATM");
	const bits = [
		p.category,
		p.packPriceSgd ? money(p.packPriceSgd) : "",
		p.packSize ? `${p.packSize}${p.unitType === "By Unit" ? " units" : p.unitType === "By ml" ? "ml" : "g"}` : "",
		p.vendor,
	].filter(Boolean);

	const reset = button(
		{ v: 1, action: "unpark", key: "", ingredientId: p.ingredientId, name: p.name },
		o,
		{
			label: "Reset",
			done: "✓ back in",
			subject: p.name,
			aria: `Reset ${p.name} — remove the Not in Use ATM tag and search for it again`,
			prose:
				`Un-parking **${p.name}** from the history page: remove the \`Not in Use ATM\` ` +
				`tag so the next daily scan searches for it again. No other tag is touched.`,
		},
	);

	return `
    <div class="hrow">
      <div class="hmain">
        <div class="hname">${esc(p.name)}</div>
        ${bits.length ? `<div class="hsub">${esc(bits.join(" · "))}</div>` : ""}
        ${others.length ? `<div class="hsub">also tagged ${esc(others.join(", "))}</div>` : ""}
      </div>
      <div class="hacts">${reset}</div>
    </div>`;
}

/**
 * One bought item, with the three buttons.
 *
 * The order is deliberate and matches how often each is right: filing a new
 * ingredient is the common case, updating the one you already have is next, and
 * the destructive one is last and red. "Never buy again" is the only one that
 * asks first — the other two write a Notion row you can edit, while this writes
 * a ban whose only undo is editing a JSON file in the repo.
 */
function boughtRow(e: PurchaseEntry, o: HistoryOptions): string {
	const base = {
		v: 1 as const,
		key: e.key,
		ingredientId: e.ingredientId,
		name: e.ingredientName,
		store: e.store,
		product: e.product,
		url: e.url,
		purchaseId: e.id,
		priceSgd: e.priceSgd,
		// ⚠️ **The log's `packSizeG` is a COOLDOWN figure, not a pack size**, and for a
		// counted pack it is deliberately converted to grams (30 eggs at 55 g each →
		// 1650 g) because "how long until I need more" is a question about quantity.
		// Handing that to the Ingredients write would file the tray as 1650 By Gram
		// instead of 30 By Unit. So where the count is known, the derived weight is
		// suppressed and the count is sent instead — see `fieldsFromPurchase`, which
		// otherwise prefers a weight and would take the wrong one.
		packSizeG: e.unitCount && e.unitCount > 0 ? null : e.packSizeG,
		unitCount: e.unitCount ?? null,
		volumetric: e.volumetric,
	};
	const size = sizeLabel(e.packSizeG, e.volumetric);
	const priced = `${money(e.priceSgd)}${size ? ` · ${size}` : ""}`;

	// `findMacros: true` keeps this button doing exactly what it did before the deals
	// page grew its own opt-in toggle: file the row AND look the nutrition up. It is
	// set explicitly rather than left to default because the default is now OFF —
	// nothing may spend money unasked, and here the asking is the button itself.
	// Filing a purchase is a deliberate, one-off act on a product you already bought,
	// unlike a deals card you are still only browsing.
	const add = button({ ...base, action: "add-ingredient", findMacros: true }, o, {
		label: "Add to Ingredients",
		done: "✓ added",
		cls: "file",
		subject: e.product,
		aria: `Add ${e.product} to Ingredients as a new row`,
		prose:
			`Adding **${e.product}** (${e.store}) to the Ingredients database as a NEW row, ` +
			`from the history page.\n\n` +
			`Price, pack size, shop and the product URL come from the payload below. ` +
			`Protein, fat, carbohydrate and fibre per 100g are looked up before the row is ` +
			`written — from the product page where it publishes a panel, by search otherwise, ` +
			`and from generic values for the food when the exact product can't be pinned down. ` +
			`The reply says which of the three it used.`,
	});

	const replace = button({ ...base, action: "replace-ingredient" }, o, {
		label: "Replace Current",
		done: "✓ replaced",
		subject: e.ingredientName,
		aria: `Replace the price and size on ${e.ingredientName} with what you actually bought`,
		prose:
			`Updating the existing ingredient **${e.ingredientName}** from the history page: ` +
			`write the price (${money(e.priceSgd)}), the pack size${size ? ` (${size})` : ""} and ` +
			`the shop (${e.store}) that were actually bought.\n\n` +
			`Only those fields change. The name, nutrition, tags, plan formulas and relations ` +
			`are left exactly as they are.`,
	});

	const never = button({ ...base, action: "never-buy" }, o, {
		label: "Never buy again",
		done: "✓ banned",
		cls: "ignore",
		subject: e.product,
		aria: `Never buy ${e.product} again — block it from every future search`,
		// One line: a newline inside an HTML attribute would sit there raw.
		confirm:
			`Never buy "${e.product}" again? It is blocked from every future search, for every ` +
			`item, and "${e.ingredientName}" itself keeps being searched.`,
		prose:
			`Never buying **${e.product}** (${e.store}) again, from the history page. ` +
			`Block it from every future search, for every item.\n\n` +
			`The ingredient **${e.ingredientName}** is NOT changed — it stays in the plan and ` +
			`other products still match it. It is this product that is retired.`,
	});

	return `
    <div class="hrow">
      <div class="hmain">
        <div class="hname">${esc(e.product)}</div>
        <div class="hsub">${esc(e.store)} · ${esc(priced)} · bought ${esc(dayLabel(e.addedAt))}</div>
        <div class="hsub">for <b>${esc(e.ingredientName)}</b>${
					e.url
						? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">the product →</a>`
						: ""
				}</div>
      </div>
      <div class="hacts">${add}${replace}${never}</div>
    </div>`;
}

/** A settled row — no buttons, just what happened to it. */
function filedRow(e: PurchaseEntry): string {
	const verb = e.outcome === "added" ? "added to Ingredients" : "replaced the current price";
	return `
    <div class="hrow done">
      <div class="hmain">
        <div class="hname">${esc(e.product)}</div>
        <div class="hsub">${esc(e.store)} · ${esc(money(e.priceSgd))} · bought ${esc(dayLabel(e.addedAt))}</div>
        <div class="hsub">for ${esc(e.ingredientName)}</div>
      </div>
      <div class="hacts"><span class="hdone">✓ ${esc(verb)}${
				e.resolvedAt ? ` ${esc(dayLabel(e.resolvedAt))}` : ""
			}</span></div>
    </div>`;
}

/** One never-buy entry. No un-ban button — see the section note. */
function neverRow(b: BlockedProduct): string {
	return `
    <div class="hrow done">
      <div class="hmain">
        <div class="hname hnever">${esc(b.product || b.url)}</div>
        <div class="hsub">${esc([b.store, b.note].filter(Boolean).join(" · "))}${
					b.addedAt ? ` · blocked ${esc(dayLabel(b.addedAt))}` : ""
				}</div>
        ${
					b.url
						? `<div class="hsub"><a href="${esc(b.url)}" target="_blank" rel="noopener">the product →</a></div>`
						: ""
				}
      </div>
    </div>`;
}

export function renderHistoryPage(
	options: HistoryOptions,
	generatedAt = new Date(),
): string {
	const o = options;
	const date = generatedAt.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});

	const open = openPurchases(o.purchases);
	const filed = filedPurchases(o.purchases);
	// The never-buy list is exactly the ALL_ITEMS blocks — the same entries the red
	// Ignore button on the deals page writes. One mechanism, one file, so this list
	// can never disagree with what the scan is actually skipping.
	const never = (o.exclusions.products ?? [])
		.filter((b) => b.key === ALL_ITEMS)
		.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));

	const parkedSection =
		`<h2 class="section">Not in use · not searched</h2>` +
		(o.parkedError
			? `<div class="warn">⚠️ Couldn't read the parked list — ${esc(o.parkedError)}</div>`
			: o.parked.length
				? `<p class="hnote">Tagged <code>Not in Use ATM</code> in Notion, so the daily scan skips
             them entirely. Reset removes that one tag and leaves every other tag alone.</p>` +
					o.parked.map((p) => parkedRow(p, o)).join("")
				: `<p class="empty-sm">Nothing is parked. 🎉</p>`);

	const boughtSection =
		`<h2 class="section">Bought · added to the grocery list</h2>` +
		(open.length
			? `<p class="hnote">Everything you've tapped Add on. File each one into Ingredients when
           you get home — <b>Add to Ingredients</b> creates a new row (and looks up its macros),
           <b>Replace Current</b> updates the row you already have.</p>` +
				open.map((e) => boughtRow(e, o)).join("")
			: `<p class="empty-sm">Nothing outstanding — everything bought has been filed.</p>`);

	const filedSection = filed.length
		? `<h2 class="section">Already filed</h2>` + filed.map(filedRow).join("")
		: "";

	// Listed but not undoable from here, deliberately: a one-tap un-ban beside a
	// list of things you decided never to buy again is a mis-tap waiting to happen,
	// and the file is right there for the rare time you mean it.
	const neverSection = never.length
		? `<h2 class="section">Never buy again</h2>` +
			`<p class="hnote">Blocked from every search, for every item. To bring one back, delete its
         entry from <code>data/exclusions.json</code> — deliberately not a button.</p>` +
			never.map(neverRow).join("")
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Grocery history · ${date}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <a class="back" href="./index.html">← back to today's deals</a>
    <h1>📋 History</h1>
    <p class="sub">${date} · ${o.parked.length} parked · ${open.length} to file · ${never.length} never buying</p>
    ${parkedSection}
    ${boughtSection}
    ${filedSection}
    ${neverSection}
    ${
			o.addEndpoint ? "" : `<p class="foot"><a href="#" id="onetap">⚡ enable one-tap</a></p>`
		}
  </div>
${addScript(o)}</body>
</html>`;
}
