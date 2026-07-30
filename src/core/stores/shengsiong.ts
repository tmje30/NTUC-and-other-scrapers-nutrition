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
const PAGE_SIZE = 20;

// Empty filter scaffolding; only searchFilter.slug varies per query.
function filters(term: string) {
	return {
		categoryFilter: { slugs: [] },
		campaignPageFilter: { slug: "", category: { slug: "" } },
		shoppingListFilter: { slug: "", category: { slug: "" }, search: { slug: "" }, showKeptForLater: false },
		searchFilter: { slug: term, category: { slug: "" } },
		preOrderCampaignFilter: { slug: "", category: { slug: "" } },
		ecommPromotionFilter: { active: true, category: { slug: "" } },
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

	/**
	 * Make sure the connection is up, minting an Incapsula cookie if the WAF turns
	 * us away. The cached cookie is tried first, so an ordinary run launches no
	 * browser: Chrome only comes out when the cookie has actually stopped working.
	 *
	 * Concurrent searches share one mint (`this.minting`) — 70 searches must not
	 * each open a browser.
	 */
	private async ensureConnected(): Promise<void> {
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
			const cookie = await mintCookie();
			this.client.reset();
			this.client.setCookie(cookie);
		})();
		try {
			await this.minting;
		} finally {
			this.minting = null;
		}
		await this.client.connect();
	}

	async search(term: string): Promise<StoreProduct[]> {
		await this.ensureConnected();
		const result = await this.client.call<any[]>("Products.getByAllSlugs", [
			filters(term),
			MISC_FILTERS,
			1,
			PAGE_SIZE,
		]);
		const list = Array.isArray(result) ? result : [];
		return list.map(mapProduct);
	}

	close(): void {
		this.client.close();
	}
}

/** Shared singleton (reuses one DDP connection). */
export const shengsiong = new ShengSiong();
