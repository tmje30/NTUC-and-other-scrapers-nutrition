import { readGroceryTargets, type PlanTarget } from "./notion.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { shengsiongFile } from "./stores/shengsiong-file.js";
import { findDeal, type Deal } from "./compare.js";
import type { StoreModule, StoreProduct } from "./stores/types.js";

/**
 * One full daily pass: read the whole grocery inventory, search every store for
 * each comparable (By-Gram) target, find the best cross-store per-100g deal, and
 * split results into active-plan deals vs. other-inventory deals.
 */

// Sheng Siong is blocked from datacenter IPs, so the cloud reads a residential
// runner's committed file. Set SHENGSIONG_LIVE=1 to hit the live DDP API instead
// (local use only). The runner script itself (push-shengsiong.ts) always uses live.
const ss = process.env.SHENGSIONG_LIVE === "1" ? shengsiong : shengsiongFile;
const STORES: StoreModule[] = [fairprice, ss];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunResult {
	/** Deals on ingredients used in the active plan (sorted by monthly saving). */
	planDeals: Deal[];
	/** Deals on the rest of the inventory (sorted by % saving). */
	otherDeals: Deal[];
	targetsConsidered: number;
	/** Unique store search terms scanned (for publishing to runners). */
	searchTerms: string[];
	errors: { target: string; store: string; message: string }[];
}

async function searchAllStores(
	target: PlanTarget,
	errors: RunResult["errors"],
): Promise<StoreProduct[]> {
	const all: StoreProduct[] = [];
	for (const store of STORES) {
		try {
			all.push(...(await store.search(target.search.searchTerm)));
		} catch (e: any) {
			errors.push({ target: target.name, store: store.name, message: e.message });
		}
		await sleep(400); // be polite between store calls
	}
	return all;
}

export async function runOnce(): Promise<RunResult> {
	const targets = await readGroceryTargets();
	const comparable = targets.filter((t) => t.baselinePer100g != null); // By-Gram in v1
	const searchTerms = [
		...new Set(comparable.map((t) => t.search.searchTerm).filter(Boolean)),
	];

	const deals: Deal[] = [];
	const errors: RunResult["errors"] = [];
	for (const target of comparable) {
		const products = await searchAllStores(target, errors);
		const deal = findDeal(target, products);
		if (deal) deals.push(deal);
	}

	ss.close();
	// Plan deals first (by monthly saving); other-inventory deals after (by % off).
	const planDeals = deals
		.filter((d) => d.target.inActivePlan)
		.sort((a, b) => b.monthlySavingSgd - a.monthlySavingSgd);
	const otherDeals = deals
		.filter((d) => !d.target.inActivePlan)
		.sort((a, b) => b.savingPct - a.savingPct);
	return { planDeals, otherDeals, targetsConsidered: comparable.length, searchTerms, errors };
}
