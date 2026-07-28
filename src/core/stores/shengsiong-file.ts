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

class ShengSiongFile implements StoreModule {
	readonly name = "Sheng Siong";
	private results: Record<string, StoreProduct[]> = {};
	private fresh = false;
	private loaded = false;

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
		if (raw?.date === today && raw.results && typeof raw.results === "object") {
			this.results = raw.results;
			this.fresh = true;
			const n = Object.values(this.results).reduce((s, a) => s + (a?.length ?? 0), 0);
			console.error(`Sheng Siong: using ${DATA_PATH} (${raw.date}, source ${raw.source ?? "?"}, ${n} products).`);
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

	close(): void {
		/* nothing to close */
	}
}

/** Shared singleton (reads the file once, lazily). */
export const shengsiongFile = new ShengSiongFile();
