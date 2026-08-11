import { writeFile, readFile, mkdir } from "node:fs/promises";
import { commitAndPushData } from "../core/git-data-push.js";
import { isUsableScan } from "../core/stores/shengsiong-file.js";
import { shengsiong } from "../core/stores/shengsiong.js";
import type { StoreProduct } from "../core/stores/types.js";

/**
 * Phone / laptop runner (residential IP). Sheng Siong blocks the cloud's
 * datacenter IP, so this runs where the IP is trusted:
 *
 *   1. Fetch the search terms from the public Pages file (no token needed).
 *   2. Run the Sheng Siong scan only (plain Node DDP, no browser, KB-sized).
 *   3. Write data/shengsiong-latest.json and git-push it.
 *
 * The cloud daily job reads that file for Sheng Siong prices; if today's file
 * isn't there it falls back to FairPrice-only. Carries ONE narrow secret (a
 * fine-grained GitHub PAT with contents:write) — no Notion or Telegram tokens.
 *
 * Usage:
 *   npm run push-ss              # skip if today's file already exists, then push
 *   npm run push-ss -- --force   # rescan even if fresh
 *   npm run push-ss -- --no-push # scan + write locally, don't commit/push
 */

const TARGETS_URL =
	process.env.TARGETS_URL ??
	"https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/targets.json";
const OUT = "data/shengsiong-latest.json";
const FORCE = process.argv.includes("--force");
const NO_PUSH = process.argv.includes("--no-push");
/** Which runner produced this data (for the commit message + payload). */
const SOURCE = process.env.RUNNER_SOURCE ?? "phone";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Today's date in Singapore (UTC+8, no DST) as YYYY-MM-DD. */
function sgtDate(): string {
	return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

async function alreadyFreshToday(today: string): Promise<boolean> {
	try {
		// `isUsableScan`, not `date === today`: a file dated today that searched no
		// terms is the 2026-08-09 failure, and self-gating on one would keep the
		// runner from replacing it for the rest of the day.
		return isUsableScan(JSON.parse(await readFile(OUT, "utf8")), today);
	} catch {
		return false;
	}
}

async function fetchTerms(): Promise<string[]> {
	const res = await fetch(TARGETS_URL, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`targets.json ${res.status} from ${TARGETS_URL}`);
	const data: any = await res.json();
	const terms: unknown = Array.isArray(data) ? data : data?.terms;
	if (!Array.isArray(terms)) throw new Error("targets.json has no terms[] array");
	const unique = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
	// ⚠️ An empty list is a broken targets.json, never a day with nothing to buy.
	// On 2026-08-09 this scanned all zero of them, wrote `{terms: 0, results: {}}`,
	// pushed it, and exited 0 — a green tick on a run that published nothing. The
	// cheapest place to stop that is before the scan, so it never becomes a file.
	if (unique.length === 0) {
		throw new Error(`targets.json lists no terms — refusing to publish an empty scan (${TARGETS_URL})`);
	}
	return unique;
}

/**
 * Commit and push today's scan.
 *
 * ⚠️ A bare `git push` here is how a good scan gets lost: the laptop wakes
 * before DNS is up, `run.cmd`'s `git pull` fails, the scan runs anyway and the
 * push is rejected for being behind. `commitAndPushData` re-applies this file
 * onto the new remote and retries — the file is regenerated in full every run,
 * so there is nothing to merge. See `src/core/git-data-push.ts`.
 */
function gitPush(today: string): Promise<unknown> {
	return commitAndPushData({
		file: OUT,
		message: `data: Sheng Siong scan ${today} (${SOURCE})`,
	});
}

async function main(): Promise<void> {
	const today = sgtDate();
	if (!FORCE && (await alreadyFreshToday(today))) {
		console.error(`Already fresh for ${today}; nothing to do (use --force to rescan).`);
		return;
	}

	const terms = await fetchTerms();
	console.error(`Scanning Sheng Siong for ${terms.length} terms…`);
	const results: Record<string, StoreProduct[]> = {};
	let errors = 0;
	for (const term of terms) {
		try {
			// Drop the bulky `raw` debug payload — the cloud reader doesn't use it,
			// and this file is committed daily (keep it lean).
			results[term] = (await shengsiong.search(term)).map(({ raw, ...p }) => p);
			console.error(`  ${term}: ${results[term].length}`);
		} catch (e: any) {
			errors++;
			results[term] = [];
			console.error(`  ${term}: ERROR ${e.message}`);
		}
		await sleep(400); // be polite between calls
	}
	shengsiong.close();

	if (errors === terms.length && terms.length > 0) {
		throw new Error(`All ${terms.length} searches failed — not writing (likely blocked/offline).`);
	}

	await mkdir("data", { recursive: true });
	const payload = {
		date: today,
		generatedAt: new Date().toISOString(),
		source: SOURCE,
		terms: terms.length,
		results,
	};
	await writeFile(OUT, JSON.stringify(payload), "utf8");
	console.error(`Wrote ${OUT} (${terms.length} terms, ${errors} errors).`);

	if (NO_PUSH) {
		console.error("--no-push: skipping git commit/push.");
		return;
	}
	await gitPush(today);
}

main().catch((e) => {
	console.error(e?.stack ?? String(e));
	process.exit(1);
});
