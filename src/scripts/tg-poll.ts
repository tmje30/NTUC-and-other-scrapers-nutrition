import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { commitAndPushData } from "../core/git-data-push.js";
import { runInbox, type Publisher } from "../core/tg-inbox.js";
import { useBotToken } from "../core/telegram.js";
import type { NewItemResult, NewItemsFile } from "../core/new-items.js";
import { sgtDate } from "../core/sgt.js";

/**
 * The Telegram inbox poller — the residential-IP half of the texted-list flow.
 *
 * It runs where the Sheng Siong scan already runs (the laptop), and for the same
 * reason: pricing a new item means asking Sheng Siong, and Sheng Siong answers a
 * residential address and challenges a datacenter one. Anything the cloud could
 * do here it would have to do FairPrice-only.
 *
 * ```
 *   long-poll getUpdates  →  parse + match  →  Notion grocery List   (immediate)
 *                                           └→ scan shops for new items
 *                                              → data/new-items-latest.json
 *                                              → git push + repository_dispatch
 *                                              → cloud rebuilds Pages
 * ```
 *
 * Usage:
 *   npm run tg-poll                # long-poll until killed (the Task Scheduler job)
 *   npm run tg-poll -- --once      # drain whatever is waiting, then exit
 *   npm run tg-poll -- --no-push   # scan and reply, but don't commit/dispatch
 *
 * ⚠️ **This process holds NOTION_TOKEN and TELEGRAM_BOT_TOKEN**, unlike
 * `push-shengsiong.ts`, which deliberately carries only a narrow GitHub PAT. It
 * has to: filing a row in Notion is the whole point. Keep it on the dev machine
 * or a clone with its own `.env`; do not put these in the phone runner.
 */

const ONCE = process.argv.includes("--once");
const NO_PUSH = process.argv.includes("--no-push");
const OUT = "data/new-items-latest.json";
const SOURCE = process.env.RUNNER_SOURCE ?? "laptop";

/**
 * Ask the cloud to rebuild Pages now.
 *
 * `repository_dispatch` runs immediately — it is only the `schedule:` trigger
 * that GitHub queues by hours on a free public repo (measured every day 01–04
 * Aug; see HANDOVER "Infrastructure truths"). This is the same mechanism the
 * page's Rescan button uses, so if that works, this works.
 *
 * Needs a PAT in `GITHUB_TOKEN` with `contents: read/write` on this repo. Without
 * one the file is still committed and the page appears on the next daily run —
 * later, but never lost.
 */
function dispatch(): void {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error("No GITHUB_TOKEN — pushed the file; the page will build on the next run.");
		return;
	}
	execSync(
		`curl -sS -X POST -H "Accept: application/vnd.github+json" ` +
			`-H "Authorization: Bearer ${token}" ` +
			`https://api.github.com/repos/${config.repo()}/dispatches ` +
			`-d "{\\"event_type\\":\\"newitems\\"}"`,
		{ stdio: "inherit" },
	);
}

/**
 * Commit and push the priced new items, retrying a rejected push.
 *
 * ⚠️ This one usually runs in the DEV clone (it needs NOTION_TOKEN), so the
 * retry's working-tree reset is refused outright when anything else is
 * uncommitted — the file stays committed locally and the error says so. Losing
 * a session's edits to save one page build is not a trade worth making. See
 * `src/core/git-data-push.ts`.
 */
function gitPush(count: number): Promise<unknown> {
	return commitAndPushData({
		file: OUT,
		message: `data: priced ${count} new item(s) from Telegram (${SOURCE})`,
	});
}

const publisher: Publisher = {
	async publish(results: NewItemResult[]): Promise<void> {
		await mkdir("data", { recursive: true });
		const payload: NewItemsFile = {
			date: sgtDate(),
			generatedAt: new Date().toISOString(),
			source: SOURCE,
			results,
		};
		await writeFile(OUT, JSON.stringify(payload), "utf8");
		console.error(`Wrote ${OUT} (${results.length} items).`);
		if (NO_PUSH) {
			console.error("--no-push: skipping git commit/dispatch.");
			return;
		}
		// A throw here is caught by `drainQueue`, which tells the user over
		// Telegram that the items were priced but the page didn't publish.
		// Dispatching after a failed push would rebuild the site without the
		// file it needs, so it deliberately doesn't run.
		await gitPush(results.length);
		dispatch();
	},
};

// Everything this process sends and receives is as the INBOX bot, not the digest
// bot — the two must be different, because the digest bot carries the Notion
// Worker's webhook and Telegram refuses `getUpdates` on a bot that has one. See
// `config.telegramInboxBotToken`.
useBotToken(config.telegramInboxBotToken());

const notion = new Client({ auth: config.notionToken() });
console.error(`Telegram inbox listening (chat ${config.telegramChatId()})${ONCE ? " — once" : ""}…`);
await runInbox({ notion, publisher }, { once: ONCE });
