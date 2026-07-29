import { readGroceryTargets, type PlanTarget } from "./notion.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { shengsiongFile } from "./stores/shengsiong-file.js";
import { findDeal, findReview, type Deal, type ReviewMiss } from "./compare.js";
import { normSynonyms } from "./match.js";
import { cooldownKey, findCooldown } from "./cooldown.js";
import { readCooldowns } from "./cooldown-file.js";
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
	/** Borderline (review-band) near-misses for targets with no confident deal. */
	reviews: { target: string; store: string; product: string; score: number }[];
	/**
	 * Targets skipped because they were recently added to the grocery list — you
	 * already have them in the cupboard. Shown on the page so they don't just
	 * disappear without explanation.
	 */
	snoozed: { name: string; until: string; days: number }[];
	/**
	 * Close-but-not-exact matches, shown on the page as recommendations: the item's
	 * defining property wasn't met, so it's never a deal, but it's worth seeing.
	 */
	recommendations: ReviewMiss[];
	errors: { target: string; store: string; message: string }[];
}

/**
 * Query forms for a target, unioned (the sibling project's `queryCandidates`):
 *   1. the raw base noun          — the spelling the shop most likely indexes
 *   2. its synonym-normalized form — "Frozen Veg" → "Frozen vegetables"
 *   3. base noun + properties      — "Frozen vegetables mixed"
 *
 * Broad-first is still the rule: (1) always runs, and properties are enforced when
 * scoring, not by narrowing the query. But a broad query can simply fail to reach
 * the product — searching "Frozen Veg" returns edamame and broccoli, while the
 * qualified form returns "FairPrice Frozen Fresh Mixed Vegetables" as the top hit.
 * Adding forms can only find MORE; nothing is lost. Capped at 3 to bound requests.
 */
export function queryTerms(searchTerm: string, properties: string[] = []): string[] {
	const raw = (searchTerm || "").trim();
	if (!raw) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (s: string) => {
		const v = s.trim().replace(/\s+/g, " ");
		const k = v.toLowerCase();
		if (v && !seen.has(k) && out.length < 3) {
			seen.add(k);
			out.push(v);
		}
	};
	add(raw);
	add(normSynonyms(raw));
	if (properties.length) add(normSynonyms(`${raw} ${properties.join(" ")}`));
	return out;
}

async function searchAllStores(
	target: PlanTarget,
	errors: RunResult["errors"],
): Promise<StoreProduct[]> {
	const all: StoreProduct[] = [];
	const seen = new Set<string>(); // de-dupe across the two spellings
	for (const store of STORES) {
		for (const term of queryTerms(target.search.searchTerm, target.search.properties)) {
			try {
				for (const p of await store.search(term)) {
					const key = `${p.store}|${p.url || p.name}`;
					if (seen.has(key)) continue;
					seen.add(key);
					all.push(p);
				}
			} catch (e: any) {
				errors.push({ target: target.name, store: store.name, message: e.message });
			}
			await sleep(400); // be polite between store calls
		}
	}
	return all;
}

export async function runOnce(): Promise<RunResult> {
	const targets = await readGroceryTargets();
	const withBaseline = targets.filter((t) => t.baselinePer100g != null); // By-Gram in v1

	// Drop anything bought recently enough to still be in the cupboard. Done here,
	// before search terms are collected, so a snoozed item costs nothing: neither
	// the cloud nor the Sheng Siong runner goes looking for it.
	const cooldowns = await readCooldowns();
	const now = new Date();
	const snoozed: RunResult["snoozed"] = [];
	const comparable = withBaseline.filter((t) => {
		const hit = findCooldown(cooldowns, cooldownKey(t.search.searchTerm), now);
		if (!hit) return true;
		snoozed.push({ name: t.name, until: hit.until, days: hit.days });
		return false;
	});
	snoozed.sort((a, b) => a.until.localeCompare(b.until));

	// Both spellings, so the Sheng Siong runner scrapes exactly what we search.
	const searchTerms = [
		...new Set(comparable.flatMap((t) => queryTerms(t.search.searchTerm, t.search.properties)).filter(Boolean)),
	];

	const deals: Deal[] = [];
	const errors: RunResult["errors"] = [];
	const reviews: RunResult["reviews"] = [];
	const recommendations: ReviewMiss[] = [];
	for (const target of comparable) {
		const products = await searchAllStores(target, errors);
		const deal = findDeal(target, products);
		if (deal) {
			deals.push(deal);
		} else {
			const rev = findReview(target, products);
			if (rev) {
				reviews.push({
					target: target.name,
					store: rev.product.store,
					product: rev.product.name,
					score: rev.score,
				});
				// Only recommend a close match that is actually cheaper than the item's
				// own baseline — otherwise it's neither the right product nor a saving.
				if (
					rev.productPer100g != null &&
					rev.baselinePer100g != null &&
					rev.productPer100g < rev.baselinePer100g
				) {
					recommendations.push(rev);
				}
			}
		}
	}

	ss.close();
	// Plan deals first (by monthly saving); other-inventory deals after (by % off).
	const planDeals = deals
		.filter((d) => d.target.inActivePlan)
		.sort((a, b) => b.monthlySavingSgd - a.monthlySavingSgd);
	const otherDeals = deals
		.filter((d) => !d.target.inActivePlan)
		.sort((a, b) => b.savingPct - a.savingPct);
	// Best (cheapest relative to its own baseline) recommendations first.
	recommendations.sort(
		(a, b) => a.productPer100g! / a.baselinePer100g! - b.productPer100g! / b.baselinePer100g!,
	);
	return {
		planDeals,
		otherDeals,
		targetsConsidered: comparable.length,
		searchTerms,
		reviews,
		snoozed,
		recommendations,
		errors,
	};
}
