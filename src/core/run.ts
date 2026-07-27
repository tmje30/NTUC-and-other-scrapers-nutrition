import { readPlanTargets, type PlanTarget } from "./notion.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { findDeal, type Deal } from "./compare.js";
import type { StoreModule, StoreProduct } from "./stores/types.js";

/**
 * One full daily pass: read the active plan, search every store for each
 * comparable (By-Gram) target, and find the best cross-store per-100g deal.
 * Cross-store is the point — concatenating candidates lets findDeal pick the
 * single cheapest qualifying product across all stores.
 */

const STORES: StoreModule[] = [fairprice, shengsiong];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunResult {
	deals: Deal[];
	targetsConsidered: number;
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
	const targets = readPlanTargets ? await readPlanTargets() : [];
	const comparable = targets.filter((t) => t.baselinePer100g != null); // By-Gram in v1

	const deals: Deal[] = [];
	const errors: RunResult["errors"] = [];
	for (const target of comparable) {
		const products = await searchAllStores(target, errors);
		const deal = findDeal(target, products);
		if (deal) deals.push(deal);
	}

	shengsiong.close();
	// Best savings first.
	deals.sort((a, b) => b.monthlySavingSgd - a.monthlySavingSgd);
	return { deals, targetsConsidered: comparable.length, errors };
}
