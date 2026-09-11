import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { commitAndPushData } from "../core/git-data-push.js";
import { PENDING_PATH, readPending, sweepPending, writePending, type PendingFile } from "../core/list-pending.js";

/**
 * **Clear the rows ticked off yesterday.** Driven by the Cloudflare cron that also sweeps
 * the Telegram inbox — see `list-pending.ts` for why the clock cannot be GitHub's.
 *
 * ⚠️⚠️ **This is the only script in the project that removes a user's Notion row.** It
 * deletes from a queue that only `list-action` writes to, it re-reads the Tickbox first
 * and spares anything un-ticked since, and "delete" means Notion's trash — recoverable
 * for ~30 days. All three guarantees are argued in `list-pending.ts`; read that before
 * changing anything here.
 *
 * ⚠️ **Cheap when idle, because it runs every fifteen minutes.** An empty queue exits
 * before opening a Notion client.
 *
 * Usage:
 *   npm run list-sweep              # delete what has expired, commit, push
 *   npm run list-sweep -- --dry-run # say what WOULD go, touch nothing
 *   npm run list-sweep -- --no-push # delete and rewrite the file, but don't commit
 */

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push");

const before = await readPending();
if (!before.pending.length) {
	console.error("Nothing ticked off — nothing to delete.");
	process.exit(0);
}

const client = new Client({ auth: config.notionToken() });
const { result, file: after } = await sweepPending(client, before, { dryRun: DRY_RUN });

for (const d of result.deleted) console.error(`Deleted: ${d.name} (ticked ${d.tickedAt})`);
for (const s of result.skipped) console.error(`Kept: ${s.entry.name} — ${s.reason}`);
for (const f of result.failed) console.error(`Failed: ${f.entry.name} — ${f.error}`);

if (DRY_RUN) {
	console.error(`Dry run: ${result.skipped.length} due, ${result.remaining} ticked since midnight.`);
	process.exit(0);
}

if (!result.deleted.length && !result.skipped.length) {
	console.error(`Nothing due yet — ${result.remaining} ticked today, clearing at midnight.`);
	process.exit(0);
}

await writePending(after);
console.error(
	`Swept ${result.deleted.length} row(s) to Notion's trash; ` +
		`${result.skipped.length} spared, ${result.failed.length} failed, ${result.remaining} still waiting.`,
);

if (NO_PUSH) process.exit(0);

/** The ids this run settled — deleted or deliberately spared. Both leave the queue. */
const settled = new Set([...result.deleted, ...result.skipped.map((s) => s.entry)].map((e) => e.pageId));

await commitAndPushData({
	file: PENDING_PATH,
	message: `list: cleared ${result.deleted.length} ticked item(s) at midnight`,
	/**
	 * ⚠️ **Keep THEIRS and remove only what this run settled.** A tick landing while the
	 * sweep ran would be erased by writing our whole copy over the remote — the row would
	 * then never be deleted, because nothing else ever puts it back on the queue. Same
	 * reasoning as `tg-sweep.ts`: all this run is entitled to say is "these are dealt with".
	 */
	reapply: (theirs) => {
		if (!theirs) return `${JSON.stringify(after, null, 2)}\n`;
		try {
			const base = JSON.parse(theirs) as PendingFile;
			const pending = (Array.isArray(base?.pending) ? base.pending : []).filter(
				(p) => !settled.has(p.pageId),
			);
			return `${JSON.stringify({ v: 1, pending }, null, 2)}\n`;
		} catch {
			return `${JSON.stringify(after, null, 2)}\n`;
		}
	},
});
