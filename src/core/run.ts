import { readGroceryTargets, type PlanTarget } from "./notion.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { shengsiongFile, type ShengSiongStatus } from "./stores/shengsiong-file.js";
import { findDeal, findReview, type Deal, type ReviewMiss } from "./compare.js";
import { normSynonyms } from "./match.js";
import { cooldownKey, findCooldown, type CooldownReason } from "./cooldown.js";
import { readCooldowns } from "./cooldown-file.js";
import { readExclusions } from "./exclusions-file.js";
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
/**
 * Exported so the texted-list scan (`new-items.ts`) searches exactly the shops
 * the daily run does, under the same `SHENGSIONG_LIVE` switch. Two lists that can
 * disagree is how one surface quietly stops seeing a shop.
 */
export const STORES: StoreModule[] = [fairprice, ss];
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
	snoozed: {
		name: string;
		until: string;
		days: number;
		/** Cooldown key and ingredient, so the page's Reset/park buttons can act on it. */
		key: string;
		ingredientId: string;
		/** Bought, or dismissed for the week from the page. The two are listed apart. */
		reason: CooldownReason;
	}[];
	/**
	 * Close-but-not-exact matches, shown on the page as recommendations: the item's
	 * defining property wasn't met, so it's never a deal, but it's worth seeing.
	 */
	recommendations: ReviewMiss[];
	/**
	 * Whether this run had Sheng Siong prices at all. Null when the live module is
	 * in use (local runs), where the question doesn't arise.
	 */
	shengsiong: ShengSiongStatus | null;
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
	// Comparable = has a baseline in at least one dimension: a per-100 price (any
	// weight-based row, plus a counted row with a weight in its name) or a per-piece
	// price (every counted row). See the note in compare.ts.
	const withBaseline = targets.filter((t) => t.baselinePer100g != null || t.baselinePerUnit != null);

	// Drop anything bought recently enough to still be in the cupboard. Done here,
	// before search terms are collected, so a snoozed item costs nothing: neither
	// the cloud nor the Sheng Siong runner goes looking for it.
	const cooldowns = await readCooldowns();
	const now = new Date();
	const snoozed: RunResult["snoozed"] = [];
	const comparable = withBaseline.filter((t) => {
		const key = cooldownKey(t.search.searchTerm);
		const hit = findCooldown(cooldowns, key, now);
		if (!hit) return true;
		snoozed.push({
			name: t.name,
			until: hit.until,
			days: hit.days,
			key,
			// The live ingredient row, not the id recorded in the cooldown — the
			// cooldown may have been written for a related item sharing this key.
			ingredientId: t.ingredientId,
			reason: hit.reason ?? "bought",
		});
		return false;
	});
	snoozed.sort((a, b) => a.until.localeCompare(b.until));

	// Both spellings, so the Sheng Siong runner scrapes exactly what we search.
	const searchTerms = [
		...new Set(comparable.flatMap((t) => queryTerms(t.search.searchTerm, t.search.properties)).filter(Boolean)),
	];

	// Corrections the user made from the page — words that must never match this
	// item again, and products blocked outright. Read once for the whole pass.
	const exclusions = await readExclusions();

	const deals: Deal[] = [];
	const errors: RunResult["errors"] = [];
	const reviews: RunResult["reviews"] = [];
	const recommendations: ReviewMiss[] = [];
	for (const target of comparable) {
		const products = await searchAllStores(target, errors);
		const deal = findDeal(target, products, exclusions);
		if (deal) {
			deals.push(deal);
		} else {
			const rev = findReview(target, products, exclusions);
			if (rev) {
				reviews.push({
					target: target.name,
					store: rev.product.store,
					product: rev.product.name,
					score: rev.score,
				});
				// Only recommend a close match that is actually cheaper than the item's
				// own baseline — otherwise it's neither the right product nor a saving.
				// Whichever dimension it was priced in; unpriceable misses are dropped.
				if (rev.baseline != null && rev.productPrice != null && rev.productPrice < rev.baseline) {
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
	// Best (cheapest relative to its own baseline) recommendations first. A ratio, so
	// it ranks per-piece and per-100g misses against each other meaningfully.
	recommendations.sort((a, b) => a.productPrice! / a.baseline! - b.productPrice! / b.baseline!);
	return {
		planDeals,
		otherDeals,
		targetsConsidered: comparable.length,
		searchTerms,
		reviews,
		snoozed,
		recommendations,
		// Only meaningful for the file-backed module the cloud uses; the live module
		// either worked or threw.
		shengsiong: ss === shengsiongFile ? shengsiongFile.status() : null,
		errors,
	};
}
