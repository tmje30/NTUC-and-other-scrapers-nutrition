import { writeFile, readFile, mkdir } from "node:fs/promises";
import { commitAndPushData } from "./git-data-push.js";
import { isUsableScan } from "./stores/shengsiong-file.js";
import { shengsiong } from "./stores/shengsiong.js";
import type { StoreProduct } from "./stores/types.js";
import { sgtDate } from "./sgt.js";

/**
 * The Sheng Siong scan itself — fetch the terms, search, write the file, push it.
 *
 * Lives here rather than in `push-shengsiong.ts` because two callers now need
 * it: the scheduled morning runner, and `ss-on-request.ts` answering a tap on
 * the page's Rescan button. It is the same scan either way; only what starts it
 * differs.
 *
 * ⚠️ Runs ONLY on a residential Singapore address. Sheng Siong answers this
 * laptop and challenges a datacenter, which is why nothing in the cloud calls
 * it — the cloud reads the file this writes. See `shengsiong-file.ts`.
 */

export const SCAN_FILE = "data/shengsiong-latest.json";

const TARGETS_URL_DEFAULT =
	"https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/targets.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScanOptions {
	/** Rescan even when today's file is already usable. */
	force?: boolean;
	/** Commit and push the result. Off for local experiments. */
	push?: boolean;
	/** Which machine produced this, for the commit message and the payload. */
	source?: string;
	targetsUrl?: string;
}

export interface ScanResult {
	status: "skipped" | "written" | "pushed";
	terms: number;
	errors: number;
	generatedAt?: string;
}

async function alreadyFreshToday(today: string): Promise<boolean> {
	try {
		// `isUsableScan`, not `date === today`: a file dated today that searched no
		// terms is the 2026-08-09 failure, and self-gating on one would keep the
		// runner from replacing it for the rest of the day.
		return isUsableScan(JSON.parse(await readFile(SCAN_FILE, "utf8")), today);
	} catch {
		return false;
	}
}

async function fetchTerms(targetsUrl: string): Promise<string[]> {
	const res = await fetch(targetsUrl, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`targets.json ${res.status} from ${targetsUrl}`);
	const data: any = await res.json();
	const terms: unknown = Array.isArray(data) ? data : data?.terms;
	if (!Array.isArray(terms)) throw new Error("targets.json has no terms[] array");
	const unique = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
	// ⚠️ An empty list is a broken targets.json, never a day with nothing to buy.
	// On 2026-08-09 this scanned all zero of them, wrote `{terms: 0, results: {}}`,
	// pushed it, and exited 0 — a green tick on a run that published nothing. The
	// cheapest place to stop that is before the scan, so it never becomes a file.
	if (unique.length === 0) {
		throw new Error(`targets.json lists no terms — refusing to publish an empty scan (${targetsUrl})`);
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
function gitPush(today: string, source: string): Promise<unknown> {
	return commitAndPushData({
		file: SCAN_FILE,
		message: `data: Sheng Siong scan ${today} (${source})`,
	});
}

export async function scanAndPush(opts: ScanOptions = {}): Promise<ScanResult> {
	const { force = false, push = true, source = "laptop" } = opts;
	const targetsUrl = opts.targetsUrl ?? process.env.TARGETS_URL ?? TARGETS_URL_DEFAULT;
	const today = sgtDate();

	if (!force && (await alreadyFreshToday(today))) {
		console.error(`Already fresh for ${today}; nothing to do (use --force to rescan).`);
		return { status: "skipped", terms: 0, errors: 0 };
	}

	const terms = await fetchTerms(targetsUrl);
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
	const generatedAt = new Date().toISOString();
	await writeFile(
		SCAN_FILE,
		JSON.stringify({ date: today, generatedAt, source, terms: terms.length, results }),
		"utf8",
	);
	console.error(`Wrote ${SCAN_FILE} (${terms.length} terms, ${errors} errors).`);

	if (!push) {
		console.error("--no-push: skipping git commit/push.");
		return { status: "written", terms: terms.length, errors, generatedAt };
	}
	await gitPush(today, source);
	return { status: "pushed", terms: terms.length, errors, generatedAt };
}
