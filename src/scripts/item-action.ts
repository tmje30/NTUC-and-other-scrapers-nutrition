import { appendFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { parseActionPayload, type ActionPayload } from "../core/item-actions.js";
import {
	findCooldown,
	startOfNextWeek,
	withCooldown,
	withoutCooldown,
	type CooldownEntry,
} from "../core/cooldown.js";
import { readCooldowns, writeCooldowns } from "../core/cooldown-file.js";
import { ALL_ITEMS, withBlockedProduct, withExcludedTerms } from "../core/exclusions.js";
import { readExclusions, writeExclusions } from "../core/exclusions-file.js";
import { addIngredientTag, parkIngredient, unparkIngredient } from "../core/park.js";
import { readVendorReview, writeVendorReview } from "../core/vendor-review-file.js";
import {
	REJECT_REASONS,
	isRejectReason,
	withRejectedPick,
	withoutPending,
} from "../core/vendor-review.js";
import { PARKED_TAG } from "../core/notion.js";
import {
	createIngredient,
	describeSlotDecision,
	fieldsFromPurchase,
	rebaseIngredient,
	recordVendorPrice,
	replaceIngredientPrice,
} from "../core/ingredient-write.js";
import { lookupMacros, macrosConfigured, type Macros, type MacroResult } from "../core/macros.js";
import { withNeverBuy, withOutcome } from "../core/purchases.js";
import { readPurchases, writePurchases } from "../core/purchases-file.js";

/**
 * The other end of the page's buttons — the "Recently bought" row, and the ⋯ menu
 * under each card's percentage.
 *
 * Run by `.github/workflows/item-actions.yml`, triggered either by a pre-filled
 * GitHub issue (the default path) or by a `repository_dispatch` from the page's
 * one-tap script. Both hand over the same payload.
 *
 *   reset          — delete the item's cooldown so the next daily scan searches it again
 *   park           — tag the Notion ingredient "Not in Use ATM" (and clear its cooldown,
 *                    so a parked item stops appearing under "Recently bought" too)
 *   ignore-week    — snooze the item until the start of next week; nothing was bought
 *   mismatch       — ban words for this item, so every later SEARCH is better
 *   almost         — block one product for this item, leaving the rest of the shop alone
 *   ignore-product — retire one product from every search, for good
 *
 * And the history page's own four:
 *
 *   unpark             — clear `Not in Use ATM` so the ingredient is searched again
 *   add-ingredient     — file a bought product as a NEW Ingredients row, macros included
 *   replace-ingredient — write the bought price/size/shop onto the existing row
 *   never-buy          — the same permanent product block as `ignore-product`
 *
 * `park`, `unpark`, `add-ingredient` and `replace-ingredient` touch Notion. The
 * rest write repo files only, which is why they are cheap enough to offer on
 * every card.
 *
 *   npm run item-action -- --payload '{"v":1,"action":"reset","key":"garlic",…}'
 *   ISSUE_BODY="$(cat issue.md)" npm run item-action
 *   npm run item-action -- --dry-run --payload '…'    # print the plan, write nothing
 */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function argValue(flag: string): string | null {
	const i = args.indexOf(flag);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/** The issue body is prose plus a fenced ```json block — take the JSON. */
function payloadFromIssueBody(body: string): unknown {
	const fenced = body.match(/```json\s*([\s\S]*?)```/i);
	const raw = fenced?.[1] ?? body.match(/\{[\s\S]*\}/)?.[0];
	if (!raw) throw new Error("no JSON payload found in the issue body");
	return JSON.parse(raw);
}

/** Whichever trigger fired, the other one's env var arrives empty — fall through. */
function nonEmptyObject(json: string | undefined): unknown | null {
	if (!json || !json.trim()) return null;
	const parsed = JSON.parse(json);
	if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) return null;
	return parsed;
}

function readPayload(): ActionPayload {
	const inline = argValue("--payload");
	if (inline) return parseActionPayload(JSON.parse(inline));
	const dispatched = nonEmptyObject(process.env.ACTION_PAYLOAD);
	// The page nests under `payload` (repository_dispatch caps client_payload at
	// 10 top-level keys, and Add needs the room). Accept both shapes.
	if (dispatched) return parseActionPayload((dispatched as any).payload ?? dispatched);
	if (process.env.ISSUE_BODY?.trim()) {
		return parseActionPayload(payloadFromIssueBody(process.env.ISSUE_BODY));
	}
	throw new Error("no payload: pass --payload, or set ACTION_PAYLOAD or ISSUE_BODY");
}

/**
 * A date as the user reads it. Never `toISOString().slice(0, 10)` for a cooldown
 * that lands on a Singapore midnight: that instant is 16:00 the PREVIOUS day in
 * UTC, so the report would name the wrong day — and, for "ignore until Monday",
 * name a Sunday.
 */
function sgtDate(d: Date): string {
	return d.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
}

/** Hand a one-line result back to the workflow, which posts it on the issue. */
async function report(summary: string): Promise<void> {
	console.log(summary);
	const out = process.env.GITHUB_OUTPUT;
	if (out) await appendFile(out, `summary<<EOF\n${summary}\nEOF\n`, "utf8");
}

const payload = readPayload();
const label = payload.name || payload.key;
const now = new Date();

if (payload.action === "reset") {
	const { file, removed } = withoutCooldown(await readCooldowns(), payload.key, now);

	// Nothing to remove is a success, not a failure: the cooldown may have expired
	// on its own, or a second tap arrived. Either way the item is searchable, which
	// is what was asked for — so say so plainly rather than erroring.
	if (!removed.length) {
		await report(`**${label}** was not snoozed — nothing to reset. It's in the next scan.`);
		process.exit(0);
	}

	const back = removed
		.map((e) => `${e.days} day${e.days === 1 ? "" : "s"} from ${e.addedAt.slice(0, 10)}`)
		.join(", ");
	if (dryRun) {
		await report(`DRY RUN — would clear the "${payload.key}" cooldown (${back}).`);
		process.exit(0);
	}

	await writeCooldowns(file);
	await report(
		`Reset: **${label}** is searched again from the next daily run.\n` +
			`Cleared a cooldown of ${back}.`,
	);
	process.exit(0);
}

if (payload.action === "ignore-week") {
	const until = startOfNextWeek(now);
	const days = Math.max(1, Math.round((until.getTime() - now.getTime()) / 86_400_000));
	const file = await readCooldowns();

	// Never shorten an existing silence. `withCooldown` replaces any earlier entry
	// on the key by design (re-buying restarts the clock), which would turn "quiet
	// for six weeks, you bought a sack of rice" into "quiet until Monday".
	const existing = findCooldown(file, payload.key, now);
	if (existing && Date.parse(existing.until) >= until.getTime()) {
		await report(
			`**${label}** is already not being searched until ` +
				`${sgtDate(new Date(existing.until))} — left as it is.`,
		);
		process.exit(0);
	}

	const entry: CooldownEntry = {
		key: payload.key,
		ingredientId: payload.ingredientId,
		ingredientName: label,
		reason: "ignored",
		addedAt: now.toISOString(),
		until: until.toISOString(),
		days,
		basis: "ignored from the deals page until the start of next week (Mon, SGT)",
		// Not bought — but recording what was on screen says WHY it was dismissed
		// when this file is read back months later.
		store: payload.store ?? "",
		product: payload.product ?? "",
		packSizeG: null,
		monthlyAmount: 0,
	};

	if (dryRun) {
		await report(`DRY RUN — would ignore **${label}** until ${sgtDate(until)}.`);
		process.exit(0);
	}
	await writeCooldowns(withCooldown(file, entry, now));
	await report(
		`Ignored: **${label}** is not searched until ${sgtDate(until)} ` +
			`(${days} day${days === 1 ? "" : "s"}).\n` +
			`Tap Reset on the page to bring it back sooner.`,
	);
	process.exit(0);
}

if (payload.action === "mismatch") {
	const terms = payload.terms ?? [];
	const { file, added } = withExcludedTerms(
		await readExclusions(),
		terms.map((term) => ({
			key: payload.key,
			term,
			name: label,
			product: payload.product ?? "",
		})),
		now,
	);

	// Every word already banned: the correction has landed, just not today. Same
	// reasoning as a reset with nothing to remove — report the state, don't error.
	if (!added.length) {
		await report(
			`**${label}** already excludes ${terms.map((t) => `\`${t}\``).join(", ")} — nothing to add.`,
		);
		process.exit(0);
	}

	const list = added.map((a) => `\`${a.term}\``).join(", ");
	if (dryRun) {
		await report(`DRY RUN — would stop matching ${list} for **${label}**.`);
		process.exit(0);
	}
	await writeExclusions(file);
	await report(
		`Mismatch recorded: **${label}** no longer matches ${list}.\n` +
			(payload.product ? `Prompted by "${payload.product}". ` : "") +
			`Takes effect on the next daily scan — edit \`data/exclusions.json\` to undo.`,
	);
	process.exit(0);
}

if (payload.action === "almost") {
	const { file, added } = withBlockedProduct(
		await readExclusions(),
		{
			key: payload.key,
			store: payload.store ?? "",
			product: payload.product ?? "",
			url: payload.url ?? "",
			name: label,
			note: payload.note ?? "",
		},
		now,
	);

	if (!added) {
		await report(`**${payload.product || payload.url}** is already blocked for **${label}**.`);
		process.exit(0);
	}
	if (dryRun) {
		await report(`DRY RUN — would block "${payload.product}" for **${label}**.`);
		process.exit(0);
	}
	await writeExclusions(file);
	await report(
		`Blocked for **${label}**: ${payload.store} · ${payload.product}` +
			(payload.note ? ` (${payload.note})` : "") +
			`.\nOnly this product — other matches for ${label} are unaffected. ` +
			`Takes effect on the next daily scan.`,
	);
	process.exit(0);
}

if (payload.action === "ignore-product") {
	// Keyed to ALL_ITEMS, not `payload.key`: the ingredient is untouched and keeps
	// being searched — it is this listing that is retired, everywhere.
	const { file, added } = withBlockedProduct(
		await readExclusions(),
		{
			key: ALL_ITEMS,
			store: payload.store ?? "",
			product: payload.product ?? "",
			url: payload.url ?? "",
			name: label,
			note: payload.note || "ignored from the deals page",
		},
		now,
	);

	const what = payload.product || payload.url;
	if (!added) {
		await report(`**${what}** is already ignored — nothing to add.`);
		process.exit(0);
	}
	if (dryRun) {
		await report(`DRY RUN — would ignore "${what}" in every future search.`);
		process.exit(0);
	}
	await writeExclusions(file);
	await report(
		`Ignored for good: ${payload.store} · ${what} is no longer offered for any item.\n` +
			`**${label}** itself is unchanged — it is still searched, and other products ` +
			`still compete for it. Takes effect on the next daily scan; ` +
			`edit \`data/exclusions.json\` to undo.`,
	);
	process.exit(0);
}

if (payload.action === "park") {
	// Notion first. If the tag write fails the item must stay snoozed rather than
	// come back into the scan — a half-applied park that re-searches an ingredient
	// you just retired is the one outcome worth avoiding here.
	const client = new Client({ auth: config.notionToken() });
	const parked = await parkIngredient(client, payload.ingredientId, dryRun);

	const { file, removed } = withoutCooldown(await readCooldowns(), payload.key, now);
	if (!dryRun && removed.length) await writeCooldowns(file);

	const cooldownNote = removed.length
		? ` Cleared its cooldown, so it drops off the page at the next rebuild.`
		: "";
	const verb = parked.alreadyParked ? "Already parked" : dryRun ? "Would park" : "Parked";
	await report(
		`${dryRun ? "DRY RUN — " : ""}${verb}: ` +
			`**${label}** is tagged \`${PARKED_TAG}\` and is no longer searched.${cooldownNote}\n` +
			`Tags: ${parked.tags.join(", ")}. Remove the tag in Notion to bring it back.`,
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// The history page's own actions.
// ---------------------------------------------------------------------------

/**
 * Settle one row of the purchase log.
 *
 * Deliberately non-fatal and always LAST: the Notion write is the thing the user
 * asked for, and it has already happened by the time this runs. A log that fails
 * to update leaves a stale button on the page — annoying, and fixed by tapping
 * again. Throwing here would report the whole action as failed when the row is
 * already sitting in their Ingredients DB, which is the more expensive lie.
 */
/**
 * The four per-100g figures for a row about to be written — free ones first, and a
 * paid lookup ONLY when the payload asked for one.
 *
 * ⚠️ **The order here is the whole cost story, and it is not an optimisation.**
 *
 * 1. `payload.macros` — parsed off the shop's own published panel when the page
 *    was built. Free, deterministic, and already scaled to per-100g. If it's
 *    there, nothing is looked up, *even with the toggle on* — the answer is
 *    already better than a model's.
 * 2. `payload.findMacros` — the user pressed **+ Macros** on the card. Only this
 *    spends money (US$0.003–0.29, see `macro-prompt.ts`).
 * 3. Otherwise **null**, and the row is written without nutrition.
 *
 * Step 3 is the default and that is deliberate: before 2026-08-04 this function
 * did not exist and every add looked up unconditionally, which meant a page could
 * spend real money on a tap that never mentioned it. Nothing may spend unasked;
 * the toggle is the asking.
 *
 * Never throws — `lookupMacros` returns null on every failure path, and a row
 * without nutrition is always better than a lost add.
 */
async function macrosFor(
	payload: ActionPayload,
	categoryKey: string | null | undefined,
): Promise<MacroResult | Macros | null> {
	if (payload.macros) {
		console.error("Nutrition: using the shop's own panel — free, no lookup.");
		return payload.macros;
	}
	if (!payload.findMacros) {
		console.error("Nutrition: not requested (+ Macros was off) — writing the row without it.");
		return null;
	}
	return await lookupMacros({
		product: payload.product ?? "",
		store: payload.store,
		url: payload.url,
		ingredientName: payload.name,
		category: categoryKey ?? undefined,
		// Same value, under the field `isCommodityFood` actually reads — fresh produce and raw
		// meat skip the (measured) 40-50 cent search that only ever returns a generic figure.
		categoryKey: categoryKey ?? undefined,
		// The page already narrowed these to the label views; `lookupMacros` re-gates them
		// anyway. Empty means a text-only lookup, exactly as this was before 2026-08-04 —
		// which is what every deals-page lookup got, FairPrice included, until the pack
		// shots were threaded through.
		images: payload.images ?? [],
	});
}

/** How the reply describes where the figures came from — or why there are none. */
function macroNote(payload: ActionPayload, macros: MacroResult | Macros | null): string {
	if (!macros) {
		return payload.findMacros
			? `⚠️ No nutrition figures could be established — fill in protein/fat/carbs/fibre by hand.`
			: `No nutrition written (**+ Macros** was off, and this shop publishes no panel).`;
	}
	const src = "source" in macros ? macros.source : null;
	const where = src ? ("note" in macros ? macros.note : src) : "from the shop's own nutrition panel (free)";
	return (
		`Nutrition per 100g — protein ${macros.proteinPer100g ?? "?"}, fat ${macros.fatsPer100g ?? "?"}, ` +
		`carbs ${macros.carbsPer100g ?? "?"}, fibre ${macros.fiberPer100g ?? "?"} (${where}).` +
		(src === "generic"
			? `\n⚠️ These are **generic values**, not this product's own label — check them.`
			: "")
	);
}

async function settlePurchase(
	id: string,
	outcome: "added" | "replaced" | "never",
	note: string,
): Promise<void> {
	if (!id || dryRun) return;
	try {
		const { file, entry } = withOutcome(await readPurchases(), id, outcome, note, now);
		if (!entry) {
			console.error(`Warning: no purchase "${id}" in the log — nothing to settle.`);
			return;
		}
		await writePurchases(file);
	} catch (e) {
		console.error(`Warning: could not settle the purchase log — ${(e as Error).message}`);
	}
}

if (payload.action === "unpark") {
	const client = new Client({ auth: config.notionToken() });
	const res = await unparkIngredient(client, payload.ingredientId, dryRun);

	// `Don't Search` is set by hand and is permanent. Un-parking would clear the
	// reversible tag and leave the item just as invisible — a button that appears
	// to work and changes nothing. Say why instead.
	if (res.blockedBy) {
		await report(
			`**${label}** also carries \`${res.blockedBy}\`, which is permanent and set by hand.\n` +
				`Nothing was changed — remove that tag in Notion first if you want it searched again.`,
		);
		process.exit(0);
	}
	// Same reasoning as a reset with nothing to remove: the end state is what was
	// asked for, so report it rather than erroring.
	if (res.notParked) {
		await report(`**${label}** was not tagged \`${PARKED_TAG}\` — it is already being searched.`);
		process.exit(0);
	}

	await report(
		`${dryRun ? "DRY RUN — would un-park" : "Un-parked"}: **${label}** no longer carries ` +
			`\`${PARKED_TAG}\`, so the next daily scan searches for it again.\n` +
			`Tags now: ${res.tags.length ? res.tags.join(", ") : "(none)"}.`,
	);
	process.exit(0);
}

if (payload.action === "never-buy") {
	const { file, added } = withBlockedProduct(
		await readExclusions(),
		{
			key: ALL_ITEMS,
			store: payload.store ?? "",
			product: payload.product ?? "",
			url: payload.url ?? "",
			name: label,
			note: payload.note || "never buy again, from the history page",
		},
		now,
	);
	const what = payload.product || payload.url;

	if (dryRun) {
		await report(`DRY RUN — would never buy "${what}" again.`);
		process.exit(0);
	}
	if (added) await writeExclusions(file);

	// Settle every OPEN purchase of this product, not just the row that was
	// tapped — see `withNeverBuy`. A second open row for the same dead product
	// would otherwise sit there offering to add it to Ingredients.
	let cleared = 0;
	try {
		const purchases = await readPurchases();
		const res = withNeverBuy(
			purchases,
			{ store: payload.store ?? "", product: payload.product ?? "", url: payload.url ?? "" },
			"never buy again",
			now,
		);
		cleared = res.count;
		if (cleared) await writePurchases(res.file);
	} catch (e) {
		console.error(`Warning: could not settle the purchase log — ${(e as Error).message}`);
	}

	await report(
		(added
			? `Never buying again: ${payload.store} · ${what}.`
			: `**${what}** was already on the never-buy list.`) +
			`\nIt is blocked from every future search, and drops off the history page.` +
			(cleared > 1 ? ` Settled ${cleared} open rows naming it.` : "") +
			`\nEdit \`data/exclusions.json\` to undo.`,
	);
	process.exit(0);
}

if (payload.action === "replace-ingredient") {
	const price = payload.priceSgd ?? null;
	const size = payload.packSizeG ?? null;
	if (price == null && size == null && !payload.store) {
		throw new Error("nothing to write — the payload carries no price, size or shop");
	}

	if (dryRun) {
		await report(
			`DRY RUN — would record $${price?.toFixed(2) ?? "—"}` +
				`${size ? ` / ${size}${payload.volumetric ? "ml" : "g"}` : ""} from ${payload.store} ` +
				`in **${label}**'s ${payload.store} vendor slot.`,
		);
		process.exit(0);
	}

	const client = new Client({ auth: config.notionToken() });
	const res = await replaceIngredientPrice(client, payload.ingredientId, {
		priceSgd: price,
		size,
		unitType: size ? (payload.volumetric ? "By ml" : "By Gram") : undefined,
		vendor: payload.store || undefined,
		url: payload.url || undefined,
		// The shop's own wording for the thing this price was quoted on, recorded
		// beside the price rather than only on the row.
		itemName: payload.product || undefined,
	});

	// A refusal is a legitimate outcome — "every slot is taken and this isn't cheaper",
	// "that shop has no Vendor option" — so the log records what actually happened
	// rather than claiming a replacement.
	//
	// ⚠️ **The test is the SLOT decision, not the written list.** A refused replace
	// still writes `Unit type `, so counting written properties reported an
	// unrecognised shop as "Replaced: … now records $1.00 from Cold Storage" while
	// the price was correctly skipped — caught by a live test on 2026-08-09. Only the
	// price book landing counts as a replacement.
	const priced = res.slot != null && res.slot.kind !== "none";
	await settlePurchase(
		payload.purchaseId ?? "",
		"replaced",
		priced ? `price/size written onto ${label}` : `nothing written to ${label}'s price book`,
	);

	const why = describeSlotDecision(res.slot);
	await report(
		(priced
			? `Replaced: **${label}** now records $${price?.toFixed(2) ?? "—"}` +
				`${size ? ` for ${size}${payload.volumetric ? "ml" : "g"}` : ""} from ${payload.store}.`
			: `**${label}**'s price book was NOT changed.`) +
			(why ? `\n${why}` : "") +
			`\nWrote: ${res.written.join(", ") || "nothing"}.` +
			(res.skipped.length ? `\nSkipped: ${res.skipped.join("; ")}.` : "") +
			`\nNutrition, tags and plan formulas were left alone.`,
	);
	process.exit(0);
}

if (payload.action === "add-ingredient") {
	const fields = fieldsFromPurchase({
		product: payload.product ?? "",
		store: payload.store ?? "",
		priceSgd: payload.priceSgd ?? 0,
		packSizeG: payload.packSizeG ?? null,
		unitCount: payload.unitCount ?? null,
		volumetric: Boolean(payload.volumetric),
		url: payload.url ?? "",
		ingredientName: payload.name ?? "",
	});

	if (dryRun) {
		await report(
			`DRY RUN — would add **${fields.name}** ("${fields.exactName}") at ` +
				`$${(fields.priceSgd ?? 0).toFixed(2)} / ${fields.size ?? "?"} ${fields.unitType}, ` +
				`vendor ${fields.vendor}` +
				(macrosConfigured() ? ", after looking up its macros." : " — no ANTHROPIC_API_KEY, so no macros."),
		);
		process.exit(0);
	}

	const macros = await macrosFor(payload, fields.categoryKey);

	const client = new Client({ auth: config.notionToken() });
	const res = await createIngredient(client, { ...fields, macros });

	await settlePurchase(
		payload.purchaseId ?? "",
		"added",
		`filed as a new Ingredients row${macros ? ` (${"source" in macros ? macros.source : "shop panel"} macros)` : " without macros"}`,
	);

	const nutrition = macroNote(payload, macros);

	await report(
		`Added to Ingredients: **${fields.name}** — "${fields.exactName}", ` +
			`$${(fields.priceSgd ?? 0).toFixed(2)} for ${fields.size ?? "?"} (${fields.unitType}), ` +
			`vendor ${fields.vendor}.\n${describeSlotDecision(res.slot)}\n${nutrition}\n` +
			`Wrote: ${res.written.join(", ")}.` +
			(res.skipped.length ? `\nSkipped: ${res.skipped.join("; ")}.` : ""),
	);
	process.exit(0);
}

/**
 * "Replace" on the deals page — re-base the ingredient that seeded the search on
 * the product that beat it.
 *
 * The only write in this file that changes an ingredient's NAME, which is why it
 * is a separate action from the history page's `replace-ingredient` and why the
 * page asks for confirmation first. The name matters beyond cosmetics: it is the
 * search term the daily scan uses, so re-basing without renaming would leave the
 * scan hunting for the thing that was just replaced.
 *
 * The URL is deliberately not written — see `rebaseIngredient`.
 */
if (payload.action === "rebase-ingredient") {
	const fields = fieldsFromPurchase({
		product: payload.product ?? "",
		store: payload.store ?? "",
		priceSgd: payload.priceSgd ?? 0,
		packSizeG: payload.packSizeG ?? null,
		unitCount: payload.unitCount ?? null,
		volumetric: Boolean(payload.volumetric),
		url: payload.url ?? "",
		ingredientName: payload.name ?? "",
	});

	if (dryRun) {
		await report(
			`DRY RUN — would re-base **${payload.name}** on "${payload.product}": ` +
				`Name → ${fields.name}, and $${(fields.priceSgd ?? 0).toFixed(2)} for ` +
				`${fields.size ?? "?"} (${fields.unitType}) into ${fields.vendor}'s vendor slot ` +
				`— whichever slot that shop owns, or the first free one, or the dearest one if it beats it. ` +
				`Every other column left alone.`,
		);
		process.exit(0);
	}

	const macros = await macrosFor(payload, fields.categoryKey);

	const client = new Client({ auth: config.notionToken() });
	const res = await rebaseIngredient(client, payload.ingredientId, {
		name: fields.name,
		priceSgd: fields.priceSgd,
		size: fields.size,
		unitType: fields.unitType,
		vendor: fields.vendor,
		// Written since 2026-08-09: it lands in `URL [Vendor n]` for the slot that
		// names THIS shop, so the misfiling that kept it out before can't happen.
		url: fields.url,
		itemName: fields.itemName,
		// Only ever set when the shop published a panel or the toggle was on; otherwise
		// the row keeps whatever nutrition it already had, which is the right default
		// for a row the user maintains.
		macros: macros ?? undefined,
	});

	await report(
		`Re-based **${payload.name}** on "${payload.product}" (${payload.store}).\n` +
			`${describeSlotDecision(res.slot)}\n` +
			`Wrote: ${res.written.join(", ") || "nothing"}.` +
			(res.skipped.length ? `\nSkipped: ${res.skipped.join("; ")}.` : "") +
			`\n${macroNote(payload, macros)}\n` +
			`Tags and plan formulas were left alone.`,
	);
	process.exit(0);
}

/**
 * **The review page's OK button.** Records a price the scan was unsure about.
 *
 * The payload carries the whole pick rather than just a token, so this writes exactly the
 * price the page showed — see `review-page.ts`. Slot safety is unchanged: `recordVendorPrice`
 * only ever refreshes a slot that already names this shop.
 */
if (payload.action === "review-ok") {
	if (dryRun) {
		await report(`DRY RUN — would record $${payload.priceSgd} / ${payload.size} for **${label}** at ${payload.vendor}.`);
		process.exit(0);
	}
	const client = new Client({ auth: config.notionToken() });
	const res = await recordVendorPrice(client, payload.ingredientId, {
		vendor: payload.vendor ?? "",
		priceSgd: payload.priceSgd,
		size: payload.size,
		url: payload.url,
		itemName: payload.itemName,
	});
	// ⚠️ The test is the SLOT decision, never "were any properties sent" (live bug,
	// 2026-08-09). A button reporting a write it did not make is worse than one that fails.
	const landed = res.slot != null && res.slot.kind !== "none";
	await writeVendorReview(withoutPending(await readVendorReview(), payload.token ?? ""));
	await report(
		landed
			? `Recorded for **${label}** at ${payload.vendor}: $${payload.priceSgd} / ${payload.size}.\n` +
					`${describeSlotDecision(res.slot)}\nWrote: ${res.written.join(", ")}.`
			: `Not written for **${label}**: ${describeSlotDecision(res.slot)}`,
	);
	process.exit(0);
}

/**
 * **The review page's "Don't use", with its reason.**
 *
 * ⚠️ Read `REJECT_REASONS` before changing anything here. Every reason refuses the price
 * book, and exactly one — `wrong-item` — also reaches the DEALS PAGE, by the user's
 * explicit decision (2026-08-11). It writes a per-item block keyed to this ingredient,
 * never `ALL_ITEMS`; "ignore forever" remains the deals page's own red Ignore.
 */
if (payload.action === "review-skip") {
	const reason = typeof payload.reason === "string" && isRejectReason(payload.reason) ? payload.reason : undefined;
	const meta = REJECT_REASONS.find((r) => r.key === reason);

	if (dryRun) {
		await report(`DRY RUN — would refuse "${payload.itemName}" for **${label}** (${meta?.label ?? "no reason given"}).`);
		process.exit(0);
	}

	const { file: reviewFile } = withRejectedPick(withoutPending(await readVendorReview(), payload.token ?? ""), {
		ingredientId: payload.ingredientId,
		vendor: payload.vendor ?? "",
		url: payload.url ?? "",
		store: payload.vendor ?? "",
		product: payload.itemName ?? "",
		name: label,
		why: payload.why ?? "",
		reason,
		// Bounds the NEXT pick when the complaint was about size — see `sizeBoundsFor`.
		packGrams: reason === "too-big" || reason === "too-small" ? (payload.size ?? null) : null,
	});
	await writeVendorReview(reviewFile);

	const extra: string[] = [];

	if (reason === "wrong-item") {
		const { file, added } = withBlockedProduct(
			await readExclusions(),
			{
				key: payload.key,
				store: payload.vendor ?? "",
				product: payload.itemName ?? "",
				url: payload.url ?? "",
				name: label,
				note: "wrong item, from the review page",
			},
			now,
		);
		if (added) await writeExclusions(file);
		extra.push(
			added
				? `Also blocked as a DEAL for **${label}** — it will stop appearing on the deals page for this row. ` +
						`Every other item still competes for it.`
				: `It was already blocked for **${label}**.`,
		);
	}

	if (reason === "wrong-brand") {
		// ⚠️ Adds an EXISTING tag option to this row. It never creates schema — if the
		// live `Select` has no "Brand Specific" option, this reports and changes nothing.
		try {
			const client = new Client({ auth: config.notionToken() });
			const tagged = await addIngredientTag(client, payload.ingredientId, "Brand Specific");
			extra.push(
				tagged
					? `Tagged **${label}** \`Brand Specific\` — only the [bracketed] brand will match from now on.`
					: `Could not tag **${label}** \`Brand Specific\` — that option is not on the live \`Select\` property, and this tool never creates schema. Add it in Notion if you want it.`,
			);
		} catch (e: any) {
			extra.push(`Could not tag **${label}** \`Brand Specific\`: ${e.message}`);
		}
	}

	if (reason === "bad-price") {
		// Not a shopping decision — a parser fault. Said plainly so it is triaged as one.
		extra.push(
			`⚠️ Logged as a **parsing fault**, not a preference: $${payload.priceSgd} / ${payload.size} was read from ` +
				`"${payload.itemName}". Worth checking the size parser against that title.`,
		);
	}

	if (meta?.research) {
		extra.push(`The next scan will look again at ${payload.vendor} and offer the closest pack it can find.`);
	}

	await report(
		`Not recorded for **${label}** at ${payload.vendor}: ${payload.itemName}\n` +
			`Reason: ${meta?.label ?? "not given"}.\n` +
			(reason === "wrong-item" ? "" : `It still appears on your deals page.\n`) +
			extra.join("\n"),
	);
	process.exit(0);
}

throw new Error(`action "${payload.action}" is not implemented`);
