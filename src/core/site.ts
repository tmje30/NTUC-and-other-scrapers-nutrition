import type { Deal, ReviewMiss } from "./compare.js";
import { cooldownKey, type CooldownReason } from "./cooldown.js";
import { suggestExclusionTerms } from "./exclusions.js";
import { groceryRowTitle, type AddPayload } from "./grocery-list.js";
import type { ActionPayload } from "./item-actions.js";
import type { PlanTarget } from "./notion.js";
import { parseNutritionPanel, type PanelMacros } from "./nutrition-panel.js";
import type { StoreProduct } from "./stores/types.js";
import { parseUnitCount, parseWeight } from "./stores/weight.js";
import { PAGE_CSS, addScript, menuScript, type ChromeOptions } from "./page-chrome.js";

/**
 * Renders the daily deals as a self-contained HTML page (deployed to GitHub
 * Pages). One Telegram message links here, keeping the chat to a single message.
 *
 * The stylesheet and the one-tap dispatch script live in `page-chrome.ts`, shared
 * with the history page this one links to at the bottom.
 */

/** Page-wide settings the cards need — how "Add" reaches Notion, and what's snoozed. */
export interface PageOptions extends ChromeOptions {
	/**
	 * Items being skipped because they were recently bought. `key` (the cooldown
	 * being served) and `ingredientId` are what the Reset button needs; without
	 * them the item still lists, just without its buttons.
	 */
	snoozed?: {
		name: string;
		until: string;
		key?: string;
		ingredientId?: string;
		/** Bought (the default) or dismissed from the page — they list separately. */
		reason?: CooldownReason;
	}[];
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
 * The "Buy" button — always a plain link to a pre-filled GitHub issue.
 *
 * ⚠️ **Called "Buy" on the page, but everything underneath it is still `add`** —
 * the CSS class, the `AddPayload`, the `grocery-add` label and the `add-to-list`
 * workflow. It was renamed on the page in 2026-08-04 because a second button
 * called **Add** now sits beside it and files the product into *Ingredients*;
 * two buttons both saying "Add" that write to different databases is exactly the
 * mis-tap worth spending a rename on. Renaming the machinery too would have
 * broken every in-flight issue and the workflow's own allowlist, for nothing.
 *
 * The page is static, so it can hold no credentials of its own. The link works
 * with JavaScript off, in any browser, forever: tap Buy → tap Submit → the
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
	// The issue title keeps the "Add: " prefix the workflow's allowlist matches on.
	// Same reason `actionButton` fixes "Item: ": a label is a display string and must
	// never be load-bearing.
	const aria = `Buy ${esc(label)} — put it on the grocery list`;

	if (o.addEndpoint) {
		return `<button class="add" type="button" data-payload="${payload}"
        aria-label="${aria}">Buy</button>`;
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
        aria-label="${aria}">Buy</a>`;
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
	ui: {
		label: string;
		done: string;
		aria: string;
		prose: string;
		confirm?: string;
		/** Question to ask before dispatching, pre-filled with `p.terms`. One-tap only. */
		prompt?: string;
		/** Extra class beside `act` — `ignore` paints it red. */
		cls?: string;
		/** What the issue title is ABOUT. Defaults to the ingredient (`p.name`). */
		subject?: string;
	},
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
		`?title=${encodeURIComponent(`Item: ${ui.label} — ${ui.subject ?? p.name}`)}` +
		`&labels=grocery-add` +
		`&body=${encodeURIComponent(body)}`;

	return `<a class="act${ui.cls ? ` ${ui.cls}` : ""}" href="${esc(href)}" target="_blank" rel="noopener"
        data-payload="${esc(JSON.stringify(p))}" data-event="item-action"
        data-done="${esc(ui.done)}"${ui.confirm ? ` data-confirm="${esc(ui.confirm)}"` : ""}${
					ui.prompt
						? ` data-prompt="${esc(ui.prompt)}" data-terms="${esc((p.terms ?? []).join(", "))}"`
						: ""
				}
        aria-label="${esc(ui.aria)}">${esc(ui.label)}</a>`;
}

/**
 * "Ignore" — the red button under Add. Retires the PRODUCT on this card from
 * every future search, permanently.
 *
 * Deliberately not in the ⋯ menu with the other corrections, and deliberately not
 * a variation on them: the menu is for "this match was wrong for this item",
 * whereas this is "I never want to see this listing again" — the shop's own
 * repackaged, over-priced or simply unwanted line, which will otherwise come back
 * tomorrow under a different ingredient. So it is scoped to the product and left
 * out of the item's exclusions entirely; the ingredient stays in the plan, still
 * searched, with every other product still competing for it.
 *
 * Confirmed before it fires. There is no button that undoes it — coming back means
 * editing `data/exclusions.json` — so the dialog says what it does and what it
 * does not touch.
 */
function ignoreButton(t: PlanTarget, p: StoreProduct, o: PageOptions): string {
	return actionButton(
		{
			v: 1,
			action: "ignore-product",
			key: cooldownKey(t.search.searchTerm),
			ingredientId: t.ingredientId,
			name: t.name,
			store: p.store,
			product: p.name,
			url: p.url,
		},
		o,
		{
			label: "Ignore",
			done: "✓ ignored",
			cls: "ignore",
			// The issue is about the PRODUCT, so the title says so — every other
			// button's title names the ingredient, and this one must not be misread
			// as retiring it.
			subject: p.name,
			aria: `Ignore ${p.name} — never offer this product again`,
			// One line: a newline inside an HTML attribute would sit there raw.
			confirm:
				`Ignore "${p.name}" for good? It is never offered again, for any item. ` +
				`"${t.name}" itself keeps being searched.`,
			prose:
				`Ignoring the product **${p.name}** (${p.store}) from the deals page: never ` +
				`offer it again, for any item. The ingredient **${t.name}** is NOT changed — ` +
				`it stays in the plan and other products still match it.`,
		},
	);
}

/**
 * The four per-100g figures the shop published, free — or null when it published
 * none this parser trusts.
 *
 * This is the whole basis of the `has macro` tag AND of what Add writes. Doing it
 * here, at build time, is what makes the free path actually free: no model, no API
 * call, no page fetch. FairPrice ships the panel in its own search payload (34 of
 * 72 products, measured 2026-08-04), so the daily scan already has it in hand.
 *
 * Null covers "no panel" and "a panel we could not trust" identically, and that is
 * on purpose: `parseNutritionPanel` refuses a table whose serving size isn't
 * stated, and a tag promising free macros that then don't appear is worse than no
 * tag at all.
 */
function freeMacros(p: StoreProduct): PanelMacros | null {
	return p.nutritionHtml ? parseNutritionPanel(p.nutritionHtml) : null;
}

/**
 * `has macro` / `no macro` — whether this listing's nutrition is free to file.
 *
 * It describes the SHOP's page, not the Notion row: an ingredient already in the
 * DB has its macros already. What this answers is "if I press Add, do I get the
 * four columns for nothing, or does it need the paid lookup?" — which is exactly
 * the question the **+ Macros** toggle beside it exists to answer.
 */
function macroTag(panel: PanelMacros | null): string {
	return panel
		? `<span class="tag tag-has" title="${esc(panel.basis)}">has macro</span>`
		: `<span class="tag tag-no" title="This shop publishes no nutrition panel for this product — turn on + Macros to look it up (costs money).">no macro</span>`;
}

/** Everything the Ingredients writes need about today's match. Shared by Add and Replace. */
function ingredientPayload(
	t: PlanTarget,
	p: StoreProduct,
	panel: PanelMacros | null,
	action: "add-ingredient" | "rebase-ingredient",
): ActionPayload {
	return {
		v: 1,
		action,
		key: cooldownKey(t.search.searchTerm),
		ingredientId: t.ingredientId,
		name: t.name,
		store: p.store,
		product: p.name,
		url: p.url,
		priceSgd: p.priceSgd,
		packSizeG: p.packWeightG,
		volumetric: p.volumetric,
		// Free figures travel WITH the payload, so the workflow writes them without
		// calling anything. Only their absence can ever cost money.
		macros: panel
			? {
					proteinPer100g: panel.proteinPer100g,
					fatsPer100g: panel.fatsPer100g,
					carbsPer100g: panel.carbsPer100g,
					fiberPer100g: panel.fiberPer100g,
				}
			: null,
		// Always serialised, always false. The toggle flips it in the browser — see
		// `macroToggle` — and it must be present in the baked JSON for that to work.
		findMacros: false,
	};
}

/**
 * **Add** — file today's match into Ingredients as a NEW row.
 *
 * Distinct from **Buy** beside it, which puts the item on the shopping list: this
 * one says "this product should be a thing I track", and it is the same write the
 * history page and the Chrome extension do.
 */
function dealAddButton(t: PlanTarget, p: StoreProduct, panel: PanelMacros | null, o: PageOptions): string {
	return actionButton(ingredientPayload(t, p, panel, "add-ingredient"), o, {
		label: "Add",
		done: "✓ added",
		subject: p.name,
		aria: `Add ${p.name} to Ingredients as a new row`,
		prose:
			`Adding **${p.name}** (${p.store}) to the Ingredients DB as a NEW row, from the ` +
			`deals page. The existing ingredient **${t.name}** is not touched.` +
			(panel ? `\n\nNutrition comes free from the shop's own panel.` : ""),
	});
}

/**
 * **Replace** — repoint the ingredient that SEEDED this search at today's match.
 *
 * Writes `Name` (a generic name derived from the product), `Price,SGD`,
 * `Weight /Units of New Product ` and `Vendor, Current `. Deliberately **not** the
 * URL — see `rebase-ingredient` in `item-actions.ts` for why this and the history
 * page's "Replace Current" are different actions rather than one shared one.
 *
 * Confirmed before it fires: it renames a row the user maintains by hand, and
 * there is no undo.
 */
function dealReplaceButton(t: PlanTarget, p: StoreProduct, panel: PanelMacros | null, o: PageOptions): string {
	return actionButton(ingredientPayload(t, p, panel, "rebase-ingredient"), o, {
		label: "Replace",
		done: "✓ replaced",
		aria: `Replace the ingredient ${t.name} with ${p.name}`,
		confirm:
			`Re-base "${t.name}" on "${p.name}"? Its name, price, size and vendor are ` +
			`overwritten, and future scans search for the new name. There is no undo.`,
		prose:
			`Re-basing the ingredient **${t.name}** on **${p.name}** (${p.store}) from the ` +
			`deals page: overwrite its Name, Price,SGD, Weight /Units and Vendor, Current. ` +
			`The product URL and every other column are left alone.`,
	});
}

/**
 * **+ Macros** — the per-card toggle that permits a PAID nutrition lookup.
 *
 * Off by default and red, because off is the safe state: nothing on this page may
 * spend money unasked. On, it turns green and Add / Replace also fill the four
 * per-100g columns, at US$0.003–0.29 depending on the product
 * (see `macro-prompt.ts`).
 *
 * It only ever matters on a `no macro` card. Where the shop published a panel the
 * figures already travel in the payload for free, so the toggle changes nothing —
 * which is why the tag sits on the card telling you which case you are in.
 *
 * A plain `<button>`, not a checkbox: it has to work identically for the one-tap
 * path (flip a flag in the JSON) and the two-tap issue path (rewrite the encoded
 * body), and `toggleScript` does both from one click handler.
 */
function macroToggle(hasFree: boolean): string {
	const why = hasFree
		? "This shop already publishes the nutrition panel, so Add fills it in free either way."
		: "Off: Add and Replace write no nutrition. On: they look it up, which costs money.";
	return `<button class="act macro" type="button" data-macro-toggle aria-pressed="false"
        title="${esc(why)}" aria-label="Look up nutrition when adding or replacing (costs money)">Macros</button>`;
}

/**
 * The menu under a card's percentage: "this match was wrong, and here is how".
 *
 * Three corrections, in order of how much they change:
 *
 *  • Ignore 1× week — nothing is wrong with the match, you just don't want to be
 *    asked again this week. Reversible from the list at the bottom of the page.
 *  • Mismatch item — the product carries words this item never asked for
 *    ("Instant Coffee" → "Indocafe 3 in 1"). Those words are banned for the item
 *    from the next scan on, so the SEARCH improves rather than just today's page.
 *  • Almost, but no — the right kind of product, but a defining property can't be
 *    confirmed (the item wants unpasteurized; the shop doesn't say). There is no
 *    word to ban, so this one product is blocked and the rest of the shop is not.
 *
 * All three go the same way as the Reset/park buttons — a pre-filled GitHub issue,
 * upgraded to one tap where a token is set — because they write to the repo, not
 * to Notion, and the page holds no credentials of its own.
 *
 * `<details>` rather than a scripted popover: it opens, closes and is keyboard-
 * reachable with no JavaScript at all, which is the same floor the buttons inside
 * it stand on.
 */
function actionMenu(t: PlanTarget, p: StoreProduct, o: PageOptions, missing: string[] = []): string {
	const base = {
		v: 1 as const,
		key: cooldownKey(t.search.searchTerm),
		ingredientId: t.ingredientId,
		name: t.name,
		store: p.store,
		product: p.name,
		url: p.url,
	};
	// What the item itself asks for, so its own words are never offered as
	// "extra" — built from the parsed parts, never the raw name, so a {private
	// note} stays out of it exactly as it does in matching.
	const s = t.search;
	const itemText = `${s.searchTerm} ${s.mustMatch.join(" ")} ${s.properties.join(" ")}`;
	const terms = suggestExclusionTerms(itemText, `${p.name} ${p.brand ?? ""}`);
	const note = missing.length ? `not ${missing.join(", ")}` : "close, but not confirmed";

	const ignore = actionButton({ ...base, action: "ignore-week" }, o, {
		label: "Ignore 1× week",
		done: "✓ ignored",
		aria: `Ignore ${t.name} until the start of next week`,
		prose:
			`Ignoring **${t.name}** from the deals page: don't search for it again ` +
			`until the start of next week.`,
	});

	// Suggested words only — the user edits them before anything is saved. "Extra"
	// honestly includes the brand, and whether to ban a brand for an item is their
	// call, not a guess this page should make for them.
	const mismatch = actionButton({ ...base, action: "mismatch", terms }, o, {
		label: "Mismatch item",
		done: "✓ excluded",
		aria: `Exclude the wrong words in ${p.name} from future ${t.name} searches`,
		prompt:
			`Words to stop matching for "${t.name}" (comma-separated) — ` +
			`edit or delete any that belong.`,
		prose:
			`Mismatch on **${t.name}**: \`${p.name}\` is not this item. Stop matching ` +
			`the words listed in \`terms\` below for it. **Edit that list before ` +
			`submitting** — remove anything the item legitimately uses.`,
	});

	const almost = actionButton({ ...base, action: "almost", note }, o, {
		label: "Almost, but no",
		done: "✓ blocked",
		aria: `Block ${p.name} for ${t.name} — similar but missing a property`,
		prose:
			`Almost, but no, on **${t.name}**: \`${p.name}\` is close but ` +
			`${note}. Block this one product for this item; leave everything else alone.`,
	});

	return `
        <details class="menu">
          <summary aria-label="Correct the match for ${esc(t.name)}">⋯</summary>
          <div class="panel">${ignore}${mismatch}${almost}</div>
        </details>`;
}

/**
 * "Rescan" — rebuild this page from scratch. Only ever rendered inside the
 * missing-shop warning, because that is the only time it does anything useful.
 *
 * It exists because the two halves of the hybrid heal at different times. If the
 * laptop is shut at 05:30, Task Scheduler runs the missed Sheng Siong scan when
 * it next wakes (`StartWhenAvailable`), so fresh prices land in the repo by
 * mid-morning — but the cloud already built the page at 10:00 and nothing looks
 * again. The laptop half fixes itself; this is the button for the other half.
 *
 * One tap fires `repository_dispatch: rescan` at the daily workflow. Without a
 * token it falls back to that workflow's own page, where "Run workflow" does the
 * same job in one more tap — the same floor as every other button here.
 */
function rescanButton(o: PageOptions): string {
	const payload = esc(JSON.stringify({ v: 1, reason: "rescan requested from the deals page" }));
	const href = `https://github.com/${o.repo}/actions/workflows/daily.yml`;
	return `<a class="act rescan" href="${esc(href)}" target="_blank" rel="noopener"
        data-payload="${payload}" data-event="rescan" data-done="✓ rescanning"
        aria-label="Rescan the shops and rebuild this page">↻ Rescan</a>`;
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

	// The shop's own nutrition panel, parsed once: it decides the tag AND rides in
	// both button payloads, so a card that says "has macro" cannot then fail to
	// deliver them.
	const panel = freeMacros(p);

	// Layout, and why it is shaped like this (redesigned 2026-08-04):
	//
	// The text is FIVE short rows rather than four long ones, and the right rail is
	// five items — %, ⋯, then Add / Replace / Macros. That pairing is the whole
	// trick: three more controls had to go somewhere, and a rail only costs text
	// width while it is taller than the text beside it. Splitting "item [size] price"
	// into two lines makes the rail and the text the same height, so the rail is free.
	//
	// The rail is FLOATED, not a flex column, for the original reason: a control
	// inside the product <a> is invalid and untappable, and a real column would eat
	// the width on every row including the ones below the buttons. The float ends
	// where the buttons do and the usage line reclaims the full card.
	//
	// ⚠️ Buy and Ignore stay in the left `.cta` column, away from the rail. Buy is the
	// one button pressed on purpose and Ignore is the one with no undo; neither
	// belongs a mis-tap away from three quieter controls.
	return `
    <div class="card">
      <div class="cta">${addButton(addPayload(t, p), o)}${ignoreButton(t, p, o)}</div>
      <div class="main">
        <!-- The % saving, the wrong-match menu, then the three Ingredients controls.
             The gap under ⋯ is deliberate: it splits "what this deal is" from
             "what to do about it", so Macros can never be read as part of the menu. -->
        <div class="rail">
          <span class="pct">−${d.savingPct.toFixed(0)}%</span>
          ${actionMenu(t, p, o)}
          <span class="railgap"></span>
          ${dealAddButton(t, p, panel, o)}
          ${dealReplaceButton(t, p, panel, o)}
          ${macroToggle(Boolean(panel))}
        </div>
        <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
          <!-- Row 1: your item, on its own so a long name has the width for it -->
          <div class="row1"><span class="name">${esc(t.name)}</span></div>
          <!-- Row 2: its pack size and what you pay for it (yellow) -->
          <div class="meta">${itemPack || `<span class="pack">[—]</span>`} <span class="mine">Price ${myPrice}</span></div>
          <!-- Row 3: the cheaper product we found -->
          <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)}</div>
          <!-- Row 4: its pack size, its price, and the shop's own sale % (red) -->
          <div class="meta">${prodPack || `<span class="pack">[—]</span>`} <span class="prodprice">${prodPrice}</span>${sale}</div>
          <!-- Row 5: product $/kg vs your $/kg (struck through) -->
          <div class="price"><b>${dealKg}</b> <span class="was">vs ${baseKg}</span></div>
          <!-- Row 6: usage and whether nutrition is free here. Always rendered, because
               the tag has to appear even on an item outside the active plan. -->
          <div class="usage">${t.inActivePlan ? `uses ~${usage}/month` : ""}${macroTag(panel)}</div>
        </a>
      </div>
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
      <div class="cta">${addButton(payload, o)}${ignoreButton(t, p, o)}</div>
      <div class="main">
        <!-- Percentage, the "closest" label, then the menu — this is the section
             where a wrong match is most likely, so the correction sits right under
             the label that says the match is only close. -->
        <div class="pctcol">
          <span class="pct">−${savingPct.toFixed(0)}%</span>
          <span class="tag">closest</span>
          ${actionMenu(t, p, o, r.missing)}
        </div>
        <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">
          <div class="row1">
            <span class="name">${esc(t.name)}${itemPack}${myPrice}</span>
          </div>
          <div class="meta"><span class="store">${esc(p.store)}</span> · ${esc(p.name)}${prodPack} <span class="prodprice">$${p.priceSgd.toFixed(2)}</span></div>
          <div class="price"><b>${prodBig}</b> <span class="was">vs ${baseBig}</span></div>
          ${t.inActivePlan ? `<div class="usage">uses ~${usage}/month</div>` : ""}
          ${why}
        </a>
      </div>
    </div>`;
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
	// with no explanation. Say so, and say when each one comes back. Items you
	// merely dismissed for the week are listed apart: calling those "recently
	// bought" would be a straight lie about what happened, and the two are undone
	// for completely different reasons.
	const snoozed = o.snoozed ?? [];
	const bought = snoozed.filter((s) => (s.reason ?? "bought") === "bought");
	const ignored = snoozed.filter((s) => s.reason === "ignored");
	const snoozeSection =
		(bought.length
			? `<h2 class="section">Recently bought · not searched</h2>` +
				bought.map((s) => snoozeRow(s, o)).join("")
			: "") +
		(ignored.length
			? `<h2 class="section">Ignored this week</h2>` +
				ignored.map((s) => snoozeRow(s, o)).join("")
			: "");

	const cards = saleSection + planSection + otherSection + recSection + snoozeSection;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Grocery deals · ${date}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <h1>🛒 Grocery deals</h1>
    <p class="sub">${date} · ${total} deal${total === 1 ? "" : "s"} beating your prices</p>
    ${
			o.warning
				? `<div class="warn">⚠️ ${esc(o.warning)}
      <div class="warnrow">${rescanButton(o)}
        <span class="warnhint">Open your laptop first — it scans Sheng Siong by itself once
          it wakes. Rescan then rebuilds this page (~3 min).</span>
      </div>
    </div>`
				: ""
		}
    ${cards}
    <!-- The way into the history page: parked ingredients, what you've bought,
         and the never-buy list. A separate page on purpose — none of it is a
         deal, and putting it here would bury the deals it sits under. -->
    <p class="foot" style="margin-top:26px">
      <a class="act" href="./history.html" style="font-size:.82rem"
         aria-label="Open the history page: not in use, bought items, never buy again"
        >📋 Not in use · bought items · never buy again →</a>
    </p>
    ${
			o.addEndpoint
				? ""
				: `<p class="foot"><a href="#" id="onetap">⚡ enable one-tap</a></p>`
		}
  </div>
${menuScript()}${addScript(o)}</body>
</html>`;
}
