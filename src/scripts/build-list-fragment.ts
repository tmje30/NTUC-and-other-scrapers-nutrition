import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { readGroceryList } from "../core/grocery-page.js";
import {
	LIST_LIVE_PATH,
	listFragment,
	sameFragment,
	type ListFragment,
} from "../core/grocery-page-render.js";

/**
 * Writes `data/list-live.json` — the snapshot `list.html` fetches on load so a texted item
 * shows up in seconds rather than at the next site build.
 *
 * ```
 *   text ─▶ relay ─▶ tg-inbox.yml ─▶ tg-handle (Notion row) ─▶ THIS ─▶ commit
 *                                                                        │
 *                               list.html fetches it from raw.github ◀────┘
 * ```
 *
 * Needs Notion and nothing else — no shop, no scan — so it costs seconds, which is the
 * entire reason it exists. See `ListFragment` for the measurement that prompted it.
 *
 * ⚠️ **It rewrites the file only when the list actually CHANGED**, and that is what makes
 * the output below trustworthy. See `sameFragment`: an unconditional write would make
 * `generatedAt` mean "when the inbox last ran", so the page would re-swap identical rows on
 * every load and the workflow could not tell a texted list from a `/search`.
 *
 * ⚠️ **Prints `changed=true|false` to `$GITHUB_OUTPUT`** when running in Actions, which is
 * what gates both the commit and the full rebuild job. Outside Actions that is skipped and
 * the same answer goes to stderr.
 *
 * Usage:
 *   npm run build-list-fragment
 */

const client = new Client({ auth: config.notionToken() });
const next = listFragment(await readGroceryList(client));

const prev: ListFragment | null = await readFile(LIST_LIVE_PATH, "utf8")
	.then((t) => JSON.parse(t) as ListFragment)
	// Missing (the first run) and unparseable (a half-written file) are the same answer:
	// there is nothing to compare against, so write a good one.
	.catch(() => null);

const changed = !sameFragment(prev, next);

if (changed) {
	await mkdir(dirname(LIST_LIVE_PATH), { recursive: true });
	await writeFile(LIST_LIVE_PATH, JSON.stringify(next), "utf8");
	console.error(
		`Wrote ${LIST_LIVE_PATH} — ${next.count} to buy, ` +
			`$${next.full.toFixed(2)} full / $${next.discounted.toFixed(2)} with discounts` +
			(next.unpriced ? `, ${next.unpriced} unpriced` : ""),
	);
} else {
	console.error(`${LIST_LIVE_PATH} unchanged — the list is the same as the committed one.`);
}

if (process.env.GITHUB_OUTPUT) {
	await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, "utf8");
}
