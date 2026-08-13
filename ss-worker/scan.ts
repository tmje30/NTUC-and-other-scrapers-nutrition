import { parseWeight, parseUnitCount } from "../src/core/stores/weight";
import { WorkerDdpClient } from "./ddp";

/**
 * The Sheng Siong scan, as a Worker.
 *
 * This is a port of two files — `src/core/stores/shengsiong.ts` (the search and
 * the product mapping) and `src/core/ss-scan.ts` (the loop, the guards and the
 * file shape). It is NOT a port of `probe/worker.mjs`, which proved the transport
 * works and said so in its own comments: its `mapProduct` is labelled *"a stand-in
 * for parseWeight"* and it makes one pass per term where the real scan makes two.
 *
 * ⚠️⚠️ **Fidelity is the entire risk in this file.** What it produces becomes
 * `data/shengsiong-latest.json`, which the whole cloud side reads as fact. A
 * mapping that is subtly wrong does not fail — it publishes wrong prices on the
 * deals page, and this project has been bitten by exactly that twice in a week
 * (the comma that made a $1,500 listing cost $1; the zero-term scan that read as
 * fresh). `parseWeight` and `parseUnitCount` are therefore **imported from the
 * real module**, not reimplemented: `weight.ts` has no imports of its own and
 * drops into a Worker unchanged, so there is no excuse for a second copy.
 */

const WS_URL = "https://shengsiong.com.sg/websocket";
const BASE = "https://shengsiong.com.sg";
const PAGE_SIZE = 50;

/** Empty filter scaffolding; only `searchFilter.slug` and the promotion flag vary. */
function filters(term: string, promoOnly: boolean) {
	return {
		categoryFilter: { slugs: [] },
		campaignPageFilter: { slug: "", category: { slug: "" } },
		shoppingListFilter: { slug: "", category: { slug: "" }, search: { slug: "" }, showKeptForLater: false },
		searchFilter: { slug: term, category: { slug: "" } },
		preOrderCampaignFilter: { slug: "", category: { slug: "" } },
		ecommPromotionFilter: { active: promoOnly, category: { slug: "" } },
	};
}

const MISC_FILTERS = {
	brands: { slugs: [] },
	prices: { slugs: [] },
	countryOfOrigins: { slugs: [] },
	dietaryHabits: { slugs: [] },
	tags: { slugs: [] },
	promotionTypes: { slugs: [] },
	sortBy: { slug: "" },
};

/**
 * One DDP product → the shape the cloud reads.
 *
 * ⚠️ Mirrors `mapProduct` in `stores/shengsiong.ts` field for field, minus `raw`.
 * The Node runner builds the product *with* `raw` and then strips it on the way
 * out (`ss-scan.ts:107`, "the cloud reader doesn't use it, and this file is
 * committed daily"); building it without is the same result and one less step.
 * `imageKey` is deliberately kept — the pack-shot series key is used in the cloud.
 */
export function mapProduct(p: any): Record<string, unknown> {
	// Search results carry `packSize` ("4 x 125 ml", "1 kg") but not netWeight.
	const pw = parseWeight(p.packSize);
	const packWeightG = pw?.grams ?? null;
	const unitCount = parseUnitCount(p.packSize);
	const price = Number(p.price);
	const prev = p.prevPrice ? Number(p.prevPrice) : 0;
	// ⚠️ The epsilon is in the original and is not decoration: float prices that
	// are equal can compare as prev > price and flag a permanent fake sale.
	const onSale = prev > price + 1e-9;

	return {
		store: "Sheng Siong",
		name: p.name,
		brand: p.brand,
		priceSgd: price,
		packWeightG,
		volumetric: pw?.volumetric ?? false,
		unitCount,
		// Sheng Siong's search payload exposes no dietary/certification labels, so an
		// "Organic/animal welfare" item can only be satisfied from FairPrice for now.
		dietaryAttributes: [],
		pricePer100g: packWeightG && packWeightG > 0 ? (price / packWeightG) * 100 : null,
		onSale,
		listPriceSgd: onSale ? prev : null,
		saleEndsAt: null, // not exposed in search payload
		url: `${BASE}/product/${p.slug}`,
		imageKey: typeof p.imgKey === "string" ? p.imgKey : null,
	};
}

/**
 * Search one term, merging two passes.
 *
 * ⚠️⚠️ **Both passes are required, and this is the single easiest thing to get
 * wrong in the port.** `ecommPromotionFilter.active` is not a display toggle:
 * `true` returns ONLY products in a current e-commerce promotion, and `false`
 * returns the whole catalogue truncated by relevance at `PAGE_SIZE` — which can
 * push the promoted items, *the actual deals*, off the end. Running only `false`
 * looks like a working scan and quietly loses the thing the system exists to
 * find. Deduped on `slug`, first pass wins, exactly as `shengsiong.ts:143` does.
 */
async function searchTerm(client: WorkerDdpClient, term: string): Promise<Record<string, unknown>[]> {
	const bySlug = new Map<string, any>();
	for (const promoOnly of [true, false]) {
		const result = await client.call<any[]>("Products.getByAllSlugs", [
			filters(term, promoOnly),
			MISC_FILTERS,
			1,
			PAGE_SIZE,
		]);
		for (const p of Array.isArray(result) ? result : []) {
			if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
		}
	}
	return [...bySlug.values()].map(mapProduct);
}

export interface ScanFile {
	date: string;
	generatedAt: string;
	source: string;
	terms: number;
	results: Record<string, Record<string, unknown>[]>;
}

/**
 * Today's date in SGT.
 *
 * ⚠️ Not `toISOString().slice(0,10)`. This scan runs at 01:00–03:00 UTC, which is
 * the *previous day* in UTC — a UTC stamp would date every morning scan yesterday
 * and `isUsableScan` would reject all of them. Mirrors `core/sgt.ts`.
 */
export function sgtDate(now: Date = new Date()): string {
	return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export async function fetchTerms(targetsUrl: string): Promise<string[]> {
	const res = await fetch(targetsUrl, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`targets.json ${res.status} from ${targetsUrl}`);
	const data: any = await res.json();
	const terms: unknown = Array.isArray(data) ? data : data?.terms;
	if (!Array.isArray(terms)) throw new Error("targets.json has no terms[] array");
	const unique = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
	// ⚠️ An empty list is a broken targets.json, never a day with nothing to buy.
	// On 2026-08-09 the runner scanned all zero of them, wrote `{terms: 0,
	// results: {}}`, pushed it and exited 0 — a green tick on a run that published
	// nothing. Stop before the scan, so it never becomes a file.
	if (unique.length === 0) {
		throw new Error(`targets.json lists no terms — refusing to publish an empty scan (${targetsUrl})`);
	}
	return unique;
}

export interface RunScanOptions {
	targetsUrl: string;
	source: string;
	/** Politeness pause between terms, ms. The runner uses 400. */
	pauseMs?: number;
	/** Cap the term list. Testing only — a partial scan must never be published. */
	limit?: number;
	/**
	 * Scan these terms instead of targets.json. **Testing only**, and the reason it
	 * exists: proving this port matches the Node runner means scanning the SAME
	 * terms as a known-good file, and those terms are scattered through the target
	 * list rather than sitting at the front where `limit` could reach them.
	 */
	termsOverride?: string[];
	now?: Date;
}

/**
 * Scan every term and return the file the cloud reads.
 *
 * ⚠️ Throws rather than returning a bad file. Both guards are inherited from
 * `ss-scan.ts` and both exist because a file that *looks* like a scan is worse
 * than no file: the reader treats it as today's truth and the page shows no
 * warning.
 */
export async function runScan(opts: RunScanOptions): Promise<ScanFile> {
	const { targetsUrl, source, pauseMs = 400, limit, termsOverride, now = new Date() } = opts;
	const all = termsOverride?.length ? termsOverride : await fetchTerms(targetsUrl);
	const terms = limit ? all.slice(0, limit) : all;

	const client = new WorkerDdpClient(WS_URL);
	const results: Record<string, Record<string, unknown>[]> = {};
	let errors = 0;

	try {
		for (const term of terms) {
			try {
				results[term] = await searchTerm(client, term);
			} catch {
				errors++;
				results[term] = [];
			}
			if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
		}
	} finally {
		client.close();
	}

	// ⚠️ Every search failing is a blocked or offline run, not a day with no
	// products. Writing it would replace a good file with an empty one.
	if (errors === terms.length && terms.length > 0) {
		throw new Error(`All ${terms.length} searches failed — not writing (likely blocked/offline).`);
	}

	return {
		date: sgtDate(now),
		generatedAt: now.toISOString(),
		source,
		terms: terms.length,
		results,
	};
}
