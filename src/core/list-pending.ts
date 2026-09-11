import { readFile, writeFile } from "node:fs/promises";
import type { Client } from "@notionhq/client";
import { GROCERY_LIST_DS, resolveListProps } from "./grocery-list.js";

/**
 * **The night between ticking a box and the row leaving Notion.**
 *
 * ```
 *   tick on list.html ──▶ list-action.yml ──▶ Tickbox = true
 *                                         └─▶ data/list-pending.json  { pageId, tickedAt }
 *
 *   Cloudflare cron, 00:00 SGT ──▶ list-sweep.yml ──▶ THIS, for everything ticked yesterday
 *                                                        └─▶ page moved to Notion's trash
 * ```
 *
 * ⚠️⚠️ **Only rows recorded HERE are ever swept, and that is the safety property this
 * file exists for.** When the page was built the list held 22 rows, **16 of them already
 * ticked** — shopping done at some point in the past, ticked by hand in Notion. A sweep
 * that went looking for ticked rows would have deleted all sixteen on its first run. It
 * does not look: it reads this queue, which starts empty and only ever grows by someone
 * tapping a checkbox on `list.html`. A row ticked in Notion is invisible to it forever.
 *
 * ⚠️⚠️ **"Delete" here means Notion's TRASH, and it cannot mean anything else.** The
 * Notion API has no permanent-delete endpoint: `PATCH /v1/pages/{id}` takes `in_trash`,
 * and `DELETE /v1/blocks/{id}` returns the block rather than destroying it — both land
 * the page in the workspace trash, recoverable for ~30 days and then purged by Notion.
 * Verified against `@notionhq/client` v5's endpoint table, 2026-09-11. If you want the
 * row gone for good before then, empty the trash in Notion.
 *
 * ⚠️ **The clock is Cloudflare's, not GitHub's.** A free public repo queues `schedule:`
 * runs by ~3–3¾ h, which would put "by midnight" somewhere in the small hours. The relay's
 * cron fires a `listsweep` dispatch at 16:00 UTC — midnight SGT, since SGT is UTC+8 with
 * no DST — and removing that trigger stops deletion happening at all. Same dependency,
 * and same failure mode, as the Telegram inbox sweep.
 */

export const PENDING_PATH = "data/list-pending.json";

/**
 * **The boundary a tick has to be older than to be swept: the most recent Singapore
 * midnight.**
 *
 * ⚠️ **This replaced a flat one-hour timer on 2026-09-11, at the user's request, and the
 * change is better than a shorter deadline dressed differently.** An hour after each tick
 * meant rows evaporating mid-trip, one by one, on their own private clocks — tick the
 * carrots at 10:00 and they are gone by 11:00 while you are still in the shop. A single
 * boundary means the list is stable for the whole trip and is cleared once, overnight, so
 * the page you open in the morning is the shopping you have left.
 *
 * ⚠️ **A sweep that runs LATE must still take only the previous day's ticks.** The dispatch
 * can be delayed, or retried, and a rule of "delete everything queued" would then eat a tick
 * made after midnight on a trip that had already started. Comparing against the boundary
 * rather than against the queue's contents makes a late sweep harmless.
 */
export function lastSgtMidnight(now: Date = new Date()): number {
	// SGT is UTC+8 with no DST (since 1982), so shifting the instant, truncating the
	// calendar day and shifting back is exact. Same reasoning as `sgtDate`.
	const shifted = new Date(now.getTime() + 8 * 3600_000);
	const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
	return dayStart - 8 * 3600_000;
}

export interface PendingDelete {
	/** Notion page id of the grocery-list row. */
	pageId: string;
	/** ISO timestamp of the tick that started the clock. */
	tickedAt: string;
	/** The row's title when it was ticked — for the log, so a sweep can say what it removed. */
	name: string;
}

export interface PendingFile {
	v: 1;
	pending: PendingDelete[];
}

const EMPTY: PendingFile = { v: 1, pending: [] };

export async function readPending(path = PENDING_PATH): Promise<PendingFile> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as PendingFile;
		return { v: 1, pending: Array.isArray(raw?.pending) ? raw.pending : [] };
	} catch (e: any) {
		// ⚠️ A missing or unreadable queue is an EMPTY queue, never an error. The file
		// does not exist until the first tick, and a sweep that threw on that would fail
		// every fifteen minutes from the day this shipped until the day someone ticked
		// something.
		if (e?.code !== "ENOENT") console.error(`Warning: ${path} unreadable (${e.message}) — treating as empty.`);
		return { ...EMPTY };
	}
}

export async function writePending(file: PendingFile, path = PENDING_PATH): Promise<void> {
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Queue a ticked row for deletion. Re-ticking an already-queued row keeps its original time. */
export function queue(file: PendingFile, entry: PendingDelete): PendingFile {
	if (file.pending.some((p) => p.pageId === entry.pageId)) return file;
	return { v: 1, pending: [...file.pending, entry] };
}

/** Take a row back off the queue — the Undo button, any time before midnight. */
export function unqueue(file: PendingFile, pageId: string): PendingFile {
	return { v: 1, pending: file.pending.filter((p) => p.pageId !== pageId) };
}

/**
 * Split the queue into what the midnight boundary has passed for and what is still today's.
 *
 * ⚠️ **An entry with an unparseable timestamp is treated as NOT due.** The alternative —
 * `NaN` comparisons falling through to "delete it" — is a bad date destroying a row.
 * Erring towards leaving a row on a shopping list is free; erring the other way is not.
 */
export function due(
	file: PendingFile,
	now: Date | number = new Date(),
): { due: PendingDelete[]; waiting: PendingDelete[] } {
	const boundary = lastSgtMidnight(typeof now === "number" ? new Date(now) : now);
	const ready: PendingDelete[] = [];
	const waiting: PendingDelete[] = [];
	for (const p of file.pending) {
		const at = Date.parse(p.tickedAt);
		if (Number.isFinite(at) && at < boundary) ready.push(p);
		else waiting.push(p);
	}
	return { due: ready, waiting };
}

export interface SweepResult {
	deleted: PendingDelete[];
	/** Rows the sweep declined to delete, and why — an untick that landed first, mostly. */
	skipped: { entry: PendingDelete; reason: string }[];
	failed: { entry: PendingDelete; error: string }[];
	remaining: number;
}

/**
 * Delete everything ticked before midnight. **This is the only code in the project that removes
 * a user's Notion row**, so it re-checks rather than trusting the queue.
 *
 * ⚠️⚠️ **The Tickbox is re-read from Notion immediately before each delete, and a row
 * that is no longer ticked is SPARED.** The queue entry was written earlier in the day and the
 * user owns that row in the meantime — unticking it in Notion itself is the plainest way
 * there is of saying "not that one", and it must outrank a queue entry. Without this the
 * only undo would be the page's own button.
 *
 * ⚠️ A row already gone (deleted by hand, moved out of the database) is a SKIP, not a
 * failure: the queue wanted it gone and it is gone.
 */
export async function sweepPending(
	client: Client,
	file: PendingFile,
	opts: { now?: Date | number; dryRun?: boolean } = {},
): Promise<{ result: SweepResult; file: PendingFile }> {
	const { due: ready, waiting } = due(file, opts.now ?? new Date());
	const result: SweepResult = { deleted: [], skipped: [], failed: [], remaining: waiting.length };
	if (!ready.length) return { result, file: { v: 1, pending: waiting } };

	const ds = (await client.dataSources.retrieve({ data_source_id: GROCERY_LIST_DS })) as any;
	const props = resolveListProps(ds.properties ?? {});

	// Entries that failed go BACK on the queue, so a Notion outage delays a deletion
	// rather than cancelling it. Skips do not: a spared row has been decided about.
	const keep: PendingDelete[] = [...waiting];

	for (const entry of ready) {
		try {
			const page = (await client.pages.retrieve({ page_id: entry.pageId })) as any;
			if (page.in_trash || page.archived) {
				result.skipped.push({ entry, reason: "already in the trash" });
				continue;
			}
			const stillTicked = props.done ? Boolean(page.properties?.[props.done]?.checkbox) : true;
			if (!stillTicked) {
				result.skipped.push({ entry, reason: "un-ticked in Notion since — spared" });
				continue;
			}
			if (opts.dryRun) {
				result.skipped.push({ entry, reason: "dry run" });
				continue;
			}
			// Notion's strongest delete. See the file header: there is no purge endpoint.
			await client.pages.update({ page_id: entry.pageId, in_trash: true } as any);
			result.deleted.push(entry);
		} catch (e: any) {
			// 404 = the page is gone, which is what the queue asked for.
			if (e?.status === 404 || e?.code === "object_not_found") {
				result.skipped.push({ entry, reason: "no longer in Notion" });
				continue;
			}
			result.failed.push({ entry, error: e?.message ?? String(e) });
			keep.push(entry);
		}
	}

	result.remaining = keep.length;
	return { result, file: { v: 1, pending: keep } };
}
