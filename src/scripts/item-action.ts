import { appendFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { parseActionPayload, type ActionPayload } from "../core/item-actions.js";
import { withoutCooldown } from "../core/cooldown.js";
import { readCooldowns, writeCooldowns } from "../core/cooldown-file.js";
import { parkIngredient } from "../core/park.js";
import { PARKED_TAG } from "../core/notion.js";

/**
 * The other end of the page's "Recently bought · not searched" buttons.
 *
 * Run by `.github/workflows/item-actions.yml`, triggered either by a pre-filled
 * GitHub issue (the default path) or by a `repository_dispatch` from the page's
 * one-tap script. Both hand over the same payload.
 *
 *   reset — delete the item's cooldown so the next daily scan searches it again
 *   park  — tag the Notion ingredient "Not in Use ATM" (and clear its cooldown,
 *           so a parked item stops appearing under "Recently bought" too)
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
