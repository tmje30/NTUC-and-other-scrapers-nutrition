import type { StoreModule, StoreProduct } from "./types.js";
import { parseWeight, parseUnitCount } from "./weight.js";
import { DdpClient } from "./ddp.js";

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

	async search(term: string): Promise<StoreProduct[]> {
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
