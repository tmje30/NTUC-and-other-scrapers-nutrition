import type { StoreModule, StoreProduct } from "./types.js";
import { parseWeight, parseUnitCount } from "./weight.js";
import { DdpClient } from "./ddp.js";
import { cachedCookie, looksBlocked, mintCookie } from "./incapsula.js";

/**
 * Sheng Siong store module (store #2). Uses the Meteor DDP method
 * `Products.getByAllSlugs(filters, miscFilters, page, pageSize)` — the same call
 * the website makes for keyword search. Connection is reused across searches;
 * call `close()` when done. See LEARNINGS 2026-07-27 for the reverse-engineering.
 */

const WS_URL = "wss://shengsiong.com.sg/websocket";
const BASE = "https://shengsiong.com.sg";
const PAGE_SIZE = 50;

// Empty filter scaffolding; only searchFilter.slug and the promotion flag vary.
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

function mapProduct(p: any): StoreProduct {
	// Search results carry `packSize` ("4 x 125 ml", "1 kg") but not netWeight.
	const pw = parseWeight(p.packSize);
	const packWeightG = pw?.grams ?? null;
	const unitCount = parseUnitCount(p.packSize);
	const price = Number(p.price);
	const prev = p.prevPrice ? Number(p.prevPrice) : 0;
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
		raw: p,
	};
}

export class ShengSiong implements StoreModule {
	readonly name = "Sheng Siong";
	private client = new DdpClient(WS_URL);
	private cookieLoaded = false;
	private minting: Promise<void> | null = null;
	/** Set once minting has failed; the rest of the run fails fast on this. */
	private mintFailure: Error | null = null;

	/**
	 * Make sure the connection is up, minting an Incapsula cookie if the WAF turns
	 * us away. The cached cookie is tried first, so an ordinary run launches no
	 * browser: Chrome only comes out when the cookie has actually stopped working.
	 *
	 * Minting happens AT MOST ONCE per process, whether it works or not.
	 * Concurrent searches share the one attempt, and a failure is remembered and
	 * rethrown rather than retried — without that, a mint that can't succeed made
	 * every one of 70 searches launch its own browser. Observed: 42 stray Chrome
	 * processes and a run that had to be killed by hand.
	 */
	private async ensureConnected(): Promise<void> {
		if (this.mintFailure) throw this.mintFailure;
		if (!this.cookieLoaded) {
			this.cookieLoaded = true;
			this.client.setCookie(cachedCookie());
		}
		try {
			await this.client.connect();
			return;
		} catch (e) {
			if (!looksBlocked(e)) throw e;
		}
		// Blocked: one shared attempt to earn a new cookie, then reconnect.
		this.minting ??= (async () => {
			console.error("Sheng Siong: blocked by Incapsula — minting a session cookie.");
			try {
				const cookie = await mintCookie();
				this.client.reset();
				this.client.setCookie(cookie);
			} catch (e: any) {
				this.mintFailure = e instanceof Error ? e : new Error(String(e));
				throw this.mintFailure;
			}
		})();
		await this.minting;
		await this.client.connect();
	}

	private async query(term: string, promoOnly: boolean): Promise<any[]> {
		const result = await this.client.call<any[]>("Products.getByAllSlugs", [
			filters(term, promoOnly),
			MISC_FILTERS,
			1,
			PAGE_SIZE,
		]);
		return Array.isArray(result) ? result : [];
	}

	/**
	 * Search, merging two passes over the same term.
	 *
	 * `ecommPromotionFilter.active` is not a display toggle: with `true` the server
	 * returns ONLY products in a current e-commerce promotion. That was the one
	 * filter we had, so anything Sheng Siong wasn't promoting that day was
	 * invisible — 28 of the 70 daily terms came back empty, "cinnamon" and "lotus
	 * root" among them, even though the shop stocks both.
	 *
	 * Neither pass alone is enough. `false` is the whole catalogue but the server
	 * truncates it by relevance at PAGE_SIZE, which can push the promoted items —
	 * the actual deals — off the end. `true` is a subset that guarantees those are
	 * present. So both run and the results are merged, deduped on `slug`.
	 */
	async search(term: string): Promise<StoreProduct[]> {
		await this.ensureConnected();
		const bySlug = new Map<string, any>();
		for (const promoOnly of [true, false]) {
			for (const p of await this.query(term, promoOnly)) {
				if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
			}
		}
		return [...bySlug.values()].map(mapProduct);
	}

	close(): void {
		this.client.close();
	}
}

/** Shared singleton (reuses one DDP connection). */
export const shengsiong = new ShengSiong();
