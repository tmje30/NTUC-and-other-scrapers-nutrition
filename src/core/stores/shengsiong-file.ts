import { readFileSync } from "node:fs";
import type { StoreModule, StoreProduct } from "./types.js";

/**
 * File-backed Sheng Siong source for the CLOUD. Sheng Siong's Incapsula blocks
 * datacenter IPs, so the live DDP module (`./shengsiong.ts`) can't run there.
 * Instead a residential runner (phone/laptop) scans SS and commits
 * `data/shengsiong-latest.json`; this reads that file.
 *
 * Fallback is deliberate: if the file is missing, unreadable, or not dated today
 * (SGT), SS contributes nothing and the page is FairPrice-only. It never attempts
 * a live call. The live module is still used locally (see `run.ts`,
 * SHENGSIONG_LIVE=1) and by the runner itself (`push-shengsiong.ts`).
 */

const DATA_PATH = process.env.SHENGSIONG_DATA_PATH ?? "data/shengsiong-latest.json";

/** Today's date in Singapore (UTC+8, no DST) as YYYY-MM-DD. */
function sgtDate(): string {
	return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Whether this run actually had Sheng Siong prices, and how old they are.
 *
 * Reported rather than only logged because a runner that stops working is
 * otherwise invisible: the scan carries on, the page still lists FairPrice deals,
 * and nothing says half the shops fell out. That is exactly how a scan failure
 * went unnoticed for a day.
 */
export interface ShengSiongStatus {
	fresh: boolean;
	/** Date stamped on the file (SGT), or null when there's no readable file. */
	date: string | null;
	/** Whole days between that date and today, null when there's no file. */
	staleDays: number | null;
	products: number;
}

/**
 * How many terms a scan file claims to have searched.
 *
 * `terms` is written as a count by `push-shengsiong.ts`; the fallback to the
 * number of result keys is for any file written before that field existed.
 */
export function scanTermCount(raw: any): number {
	if (typeof raw?.terms === "number" && Number.isFinite(raw.terms)) return raw.terms;
	return raw?.results && typeof raw.results === "object" ? Object.keys(raw.results).length : 0;
}

/**
 * Whether a scan file is today's and is an actual scan.
 *
 * ⚠️ **A file dated today that searched ZERO terms is not a scan, and the date
 * alone used to be enough.** On 2026-08-09 the runner fetched a `targets.json`
 * that listed no terms, "scanned" all zero of them, and wrote
 * `{date: today, terms: 0, results: {}}` — which this reader would have called
 * fresh, reported as "0 products", and published with **no ⚠️ banner**, while
 * every Sheng Siong lookup silently returned nothing. Both ends are now guarded:
 * the runner refuses to write such a file, and this refuses to trust one.
 */
export function isUsableScan(raw: any, today: string): boolean {
	if (raw?.date !== today) return false;
	if (!raw?.results || typeof raw.results !== "object") return false;
	return scanTermCount(raw) > 0;
}

/** Whole days between two YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number | null {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.round((b - a) / 86_400_000);
}

class ShengSiongFile implements StoreModule {
	readonly name = "Sheng Siong";
	private results: Record<string, StoreProduct[]> = {};
	private fresh = false;
	private loaded = false;
	private fileDate: string | null = null;

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		let raw: any;
		try {
			raw = JSON.parse(readFileSync(DATA_PATH, "utf8"));
		} catch {
			console.error(`Sheng Siong: no readable ${DATA_PATH} — skipping SS (FairPrice only).`);
			return;
		}
		const today = sgtDate();
		this.fileDate = typeof raw?.date === "string" ? raw.date : null;
		if (isUsableScan(raw, today)) {
			this.results = raw.results;
			this.fresh = true;
			const n = Object.values(this.results).reduce((s, a) => s + (a?.length ?? 0), 0);
			console.error(`Sheng Siong: using ${DATA_PATH} (${raw.date}, source ${raw.source ?? "?"}, ${n} products).`);
		} else if (raw?.date === today) {
			console.error(
				`Sheng Siong: ${DATA_PATH} is dated today but searched no terms — treating it as missing (FairPrice only).`,
			);
		} else {
			console.error(
				`Sheng Siong: ${DATA_PATH} not fresh (file ${raw?.date ?? "?"} vs today ${today}) — skipping SS (FairPrice only).`,
			);
		}
	}

	async search(term: string): Promise<StoreProduct[]> {
		this.load();
		if (!this.fresh) return [];
		return this.results[term] ?? [];
	}

	/** Freshness of the runner's file, for the page and the daily message. */
	status(): ShengSiongStatus {
		this.load();
		return {
			fresh: this.fresh,
			date: this.fileDate,
			staleDays: this.fileDate ? daysBetween(this.fileDate, sgtDate()) : null,
			products: Object.values(this.results).reduce((s, a) => s + (a?.length ?? 0), 0),
		};
	}

	close(): void {
		/* nothing to close */
	}
}

/** Shared singleton (reads the file once, lazily). */
export const shengsiongFile = new ShengSiongFile();
