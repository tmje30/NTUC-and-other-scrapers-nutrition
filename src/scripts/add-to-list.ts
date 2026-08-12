import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import {
	addToGroceryList,
	groceryRowTitle,
	parseAddPayload,
	type AddPayload,
} from "../core/grocery-list.js";
import { planCooldown, withCooldown, type CooldownEntry } from "../core/cooldown.js";
import { readCooldowns, writeCooldowns } from "../core/cooldown-file.js";
import { purchaseFromAdd, withPurchase } from "../core/purchases.js";
import { readPurchases, writePurchases } from "../core/purchases-file.js";

/**
 * The other end of the page's Add button: put one deal on the Notion grocery
 * list and start its cooldown.
 *
 * Run by `.github/workflows/add-to-list.yml`, which is triggered either by a
 * pre-filled GitHub issue (the default path) or by a `repository_dispatch` from
 * the Cloudflare Worker (the one-tap path). Both hand over the same payload.
 *
 *   npm run add -- --payload '{"v":1,"ingredient":"Garlic",...}'
 *   ISSUE_BODY="$(cat issue.md)" npm run add
 *   npm run add -- --dry-run --payload '…'     # print the plan, write nothing
 */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function argValue(flag: string): string | null {
	const i = args.indexOf(flag);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/**
 * The issue body is human-readable prose plus a fenced ```json block — the user
 * can see exactly what they're submitting before they hit Submit. Take the JSON.
 */
function payloadFromIssueBody(body: string): unknown {
	const fenced = body.match(/```json\s*([\s\S]*?)```/i);
	const raw = fenced?.[1] ?? body.match(/\{[\s\S]*\}/)?.[0];
	if (!raw) throw new Error("no JSON payload found in the issue body");
	return JSON.parse(raw);
}

/**
 * Both env vars are always set by the workflow — whichever trigger fired, the
 * other one arrives as "null" or "" — so an empty value has to fall through
 * rather than blow up.
 */
function nonEmptyObject(json: string | undefined): unknown | null {
	if (!json || !json.trim()) return null;
	const parsed = JSON.parse(json);
	if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) return null;
	return parsed;
}

function readPayload(): AddPayload {
	const inline = argValue("--payload");
	if (inline) return parseAddPayload(JSON.parse(inline));
	const dispatched = nonEmptyObject(process.env.ADD_PAYLOAD);
	// repository_dispatch allows at most 10 top-level client_payload properties
	// and an add has 12, so senders nest it under `payload`. Accept both shapes.
	if (dispatched) return parseAddPayload((dispatched as any).payload ?? dispatched);
	if (process.env.ISSUE_BODY?.trim()) {
		return parseAddPayload(payloadFromIssueBody(process.env.ISSUE_BODY));
	}
	throw new Error("no payload: pass --payload, or set ADD_PAYLOAD or ISSUE_BODY");
}

/**
 * Hand a one-line result back to the workflow, which posts it on the issue.
 *
 * ⚠️ **The heredoc delimiter is randomised per call, and a literal `EOF` is not
 * good enough.** `summary` quotes the product — `itemName`, `vendor` — and that
 * text is not ours: it arrives in `ISSUE_BODY`, having started life as a title
 * someone typed into a shop listing. A Carousell seller writes their own. A title
 * carrying a line that is exactly `EOF` ends the block early, and everything after
 * it is read by Actions as further `name=value` output rather than as prose — so a
 * crafted listing could set workflow outputs this script never wrote. A random
 * delimiter cannot be guessed by someone writing a title days earlier, which is
 * why GitHub documents this form.
 */
async function report(summary: string): Promise<void> {
	console.log(summary);
	const out = process.env.GITHUB_OUTPUT;
	if (!out) return;
	const delim = `EOF_${randomUUID()}`;
	await appendFile(out, `summary<<${delim}\n${summary}\n${delim}\n`, "utf8");
}

const payload = readPayload();
const now = new Date();

// Cooldown first, so the numbers appear in the log even on a dry run.
const cd = planCooldown(payload.packSizeG, payload.monthlyAmount, now, {
	volumetric: payload.volumetric,
	weeklyBuy: payload.weeklyBuy,
});
console.error(`Cooldown: ${cd.days} days (${cd.basis}) — key "${payload.key}"`);

if (dryRun) {
	await report(
		`DRY RUN — would add "${groceryRowTitle(payload)}" at ` +
			`$${payload.priceSgd.toFixed(2)} and snooze "${payload.key}" for ${cd.days} days.`,
	);
	process.exit(0);
}

const client = new Client({ auth: config.notionToken() });
const added = await addToGroceryList(client, payload);

const entry: CooldownEntry = {
	key: payload.key,
	ingredientId: payload.ingredientId,
	ingredientName: payload.ingredient,
	addedAt: now.toISOString(),
	until: cd.until,
	days: cd.days,
	basis: cd.basis,
	store: payload.store,
	product: payload.product,
	packSizeG: payload.packSizeG,
	monthlyAmount: payload.monthlyAmount,
};
await writeCooldowns(withCooldown(await readCooldowns(), entry, now), undefined);

// The purchase log — the history page's whole input, and the only lasting record
// of what this product cost today. Written AFTER the Notion row exists, so the
// log never claims a purchase that failed to land. Non-fatal: a log write that
// fails must not turn a successful add into a failed workflow run, because the
// row is already on the user's list and re-running would duplicate it.
try {
	const purchase = purchaseFromAdd(payload, now);
	const { file, added: logged } = withPurchase(await readPurchases(), purchase, now);
	if (logged) await writePurchases(file);
} catch (e) {
	console.error(`Warning: could not write the purchase log — ${(e as Error).message}`);
}

// No Telegram ping here by design — the user gets one daily digest and doesn't
// want an add narrating itself. The issue comment below is the whole receipt.
const back = new Date(cd.until).toLocaleDateString("en-SG", {
	day: "numeric",
	month: "short",
	year: "numeric",
	timeZone: "Asia/Singapore",
});
await report(
	`${added.alreadyListed ? "Already on the list" : "Added"}: **${added.title}** — ` +
		`$${payload.priceSgd.toFixed(2)}` +
		(added.amount == null
			? ""
			: added.alreadyListed
				? `, Amount now **${added.amount}**`
				: `, Amount **1**`) +
		`.\n` +
		`Snoozed for **${cd.days} days** (back ${back}) — ${cd.basis}.`,
);
