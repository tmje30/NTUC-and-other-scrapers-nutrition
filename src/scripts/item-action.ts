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
import { withBlockedProduct, withExcludedTerms } from "../core/exclusions.js";
import { readExclusions, writeExclusions } from "../core/exclusions-file.js";
import { parkIngredient } from "../core/park.js";
import { PARKED_TAG } from "../core/notion.js";

/**
 * The other end of the page's buttons — the "Recently bought" row, and the ⋯ menu
 * under each card's percentage.
 *
 * Run by `.github/workflows/item-actions.yml`, triggered either by a pre-filled
 * GitHub issue (the default path) or by a `repository_dispatch` from the page's
 * one-tap script. Both hand over the same payload.
 *
 *   reset       — delete the item's cooldown so the next daily scan searches it again
 *   park        — tag the Notion ingredient "Not in Use ATM" (and clear its cooldown,
 *                 so a parked item stops appearing under "Recently bought" too)
 *   ignore-week — snooze the item until the start of next week; nothing was bought
 *   mismatch    — ban words for this item, so every later SEARCH is better
 *   almost      — block one product for this item, leaving the rest of the shop alone
 *
 * Only `park` touches Notion. The other four write repo files, which is why they
 * are cheap enough to offer on every card.
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

throw new Error(`action "${payload.action}" is not implemented`);
