import type { StoreModule, StoreProduct } from "./types.js";
import { marketplaceSize } from "../marketplace-size.js";

/**
 * Guardian Pharmacy — the shop tagged in `Vendor n` on the toothpaste and skincare rows.
 *
 * ⚠️ **Everything the older docs say about how to read this site is out of date.**
 * `docs/vendor-scoping.md` (2026-08-04) has it as 🟠 AMBER — "pure SPA, every URL returns
 * the identical 136,929-byte shell, needs the browser tier" — and `vendor-probe.ts` still
 * probes `/catalogsearch/result/?q=`. Measured again 2026-08-09:
 *
 *   - `/catalogsearch/result/?q=` **302s to the homepage**. It is not a search URL any
 *     more, which is why a browser-rendered probe found zero products and reported an
 *     empty SPA: the page was never the search page.
 *   - The storefront is **Magento PWA Studio**, and its `/graphql` endpoint answers an
 *     ordinary anonymous `fetch` — no browser, no cookies, no WAF.
 *
 * So this is the cheapest adapter in the project after FairPrice: one POST, structured
 * JSON, no Chrome. The browser tier is not needed and deliberately not used — see
 * LEARNINGS on not building a rendering tier for a site that only needed the right URL.
 *
 * ⚠️ **The pack size is in the product NAME, not a field** — "Sensodyne Toothpaste Fresh
 * Mint 2X100G", "CeraVe Moisturising Lotion 1L", "…75ML". That is why this module parses
 * with `marketplaceSize` rather than `weight.ts`: the latter reads a size a shop published
 * as its own field, while these are free text inside a title, complete with multipacks
 * ("2X100G" is 200 g, not 100) and the occasional two-sizes-in-one-name that must be
 * REJECTED rather than half-read. Both hazards are already handled there.
 */

const BASE = "https://www.guardian.com.sg";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** How many results to ask for. Guardian returns relevance-ordered results. */
const PAGE_SIZE = 30;

const QUERY = `query Search($term: String!, $pageSize: Int!) {
  products(search: $term, pageSize: $pageSize) {
    total_count
    items {
      name
      sku
      url_key
      stock_status
      price_range {
        minimum_price {
          regular_price { value }
          final_price { value }
          discount { percent_off }
        }
      }
    }
  }
}`;

interface GuardianItem {
	name?: string;
	sku?: string;
	url_key?: string;
	stock_status?: string;
	price_range?: {
		minimum_price?: {
			regular_price?: { value?: number } | null;
			final_price?: { value?: number } | null;
			discount?: { percent_off?: number } | null;
		} | null;
	} | null;
}

function mapProduct(item: GuardianItem): StoreProduct | null {
	const name = String(item.name ?? "").trim();
	const min = item.price_range?.minimum_price;
	const price = Number(min?.final_price?.value);
	if (!name || !Number.isFinite(price) || price <= 0) return null;

	// A size that cannot be read, or that names two sizes at once, yields NO product.
	// A price with no size is not cheap or dear, it is unknown — and the whole price
	// book rests on price-per-size, so half a record is worse than none.
	const size = marketplaceSize(name);
	const packWeightG = size.ok ? size.grams : null;
	const volumetric = size.ok ? size.volumetric : false;

	const regular = Number(min?.regular_price?.value);
	const pctOff = Number(min?.discount?.percent_off ?? 0);
	const onSale = Number.isFinite(pctOff) && pctOff > 0;

	return {
		store: "Guardian",
		name,
		packWeightG,
		volumetric,
		// Guardian's titles state weights and volumes, never piece counts.
		unitCount: null,
		priceSgd: price,
		pricePer100g: packWeightG && packWeightG > 0 ? (price / packWeightG) * 100 : null,
		dietaryAttributes: [],
		onSale,
		listPriceSgd: onSale && Number.isFinite(regular) && regular > price ? regular : null,
		saleEndsAt: null,
		url: item.url_key ? `${BASE}/${item.url_key}.html` : BASE,
		raw: item,
	};
}

export class Guardian implements StoreModule {
	readonly name = "Guardian";

	async search(term: string): Promise<StoreProduct[]> {
		const res = await fetch(`${BASE}/graphql`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": UA,
			},
			body: JSON.stringify({
				query: QUERY,
				variables: { term, pageSize: PAGE_SIZE },
			}),
		});
		if (!res.ok) throw new Error(`Guardian graphql → HTTP ${res.status}`);

		const body: any = await res.json();
		// GraphQL answers 200 with an `errors` array, so a bad response is not an HTTP
		// failure. Surfaced rather than swallowed: silently returning [] here would look
		// exactly like "this shop doesn't stock it".
		if (body?.errors?.length) {
			throw new Error(`Guardian graphql: ${body.errors.map((e: any) => e?.message).join("; ")}`);
		}

		const items: GuardianItem[] = body?.data?.products?.items ?? [];
		const out: StoreProduct[] = [];
		for (const item of items) {
			// Nothing that cannot be bought today should compete on price.
			if (item.stock_status && item.stock_status !== "IN_STOCK") continue;
			const p = mapProduct(item);
			if (p) out.push(p);
		}
		return out;
	}
}

export const guardian = new Guardian();
