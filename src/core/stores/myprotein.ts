import type { StoreModule, StoreProduct } from "./types.js";
import { marketplaceSize } from "../marketplace-size.js";

/**
 * MyProtein — the shop tagged on `whey, essential [MyProtein]`.
 *
 * Server-rendered JSON-LD, no anti-bot, no browser. The catch is one the probe already
 * found and this module exists to solve properly: **the search payload states no pack
 * size**. Its products are named "Impact Whey Protein + Collagen", and the size lives in
 * the on-page variant selector.
 *
 * ⚠️ **And the search price cannot simply be paired with a size read from the page.**
 * Measured 2026-08-09 on `impact-whey-protein`: the product page is a `ProductGroup` with
 * **42 variants priced from $36.91 to $611**. There is no single "price of this product".
 * Taking the search page's one price and attaching whatever size the page mentions would
 * be wrong by up to 16×, in the direction that looks like a bargain — the same failure
 * family as the 32 g serving read as 100 g.
 *
 * So each VARIANT is its own product here, with its own price and its own size, and:
 *
 * ⚠️ **A variant that does not state a weight is dropped.** Only 20 of those 42 carry a
 * `weight` field; the rest are real, in-stock, purchasable variants whose size is simply
 * not published ("Impact Whey Protein Powder Vanilla — $138"). No size is not a cheap
 * price, it is **no data**, which is this project's rule everywhere else and is what keeps
 * a $138 tub of unknown size from being priced against a 2.7 kg one.
 */

const BASE = "https://www.myprotein.com.sg";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS: Record<string, string> = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-SG,en;q=0.9",
};

/**
 * How many search hits get their product page fetched.
 *
 * Each one is a ~1.2 MB request, and the search is relevance-ordered, so the answer is
 * almost always in the first few. The cap is what stops one search turning into 28
 * megabyte-scale fetches against a shop that has been nothing but cooperative.
 */
const MAX_PRODUCT_PAGES = 5;

/** Politeness between product-page fetches. */
const DELAY_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, timeoutMs = 30_000): Promise<string> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: ctl.signal });
		if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(t);
	}
}

/** Every JSON-LD block in a page, parsed. A block that won't parse is skipped, not fatal. */
function jsonLdBlocks(html: string): any[] {
	const out: any[] = [];
	for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {
			/* a broken block is not worth a repair ladder */
		}
	}
	return out;
}

/** Walk a JSON-LD tree collecting nodes of a given `@type`. */
function collectType(node: any, type: string, out: any[] = [], seen = new Set<any>()): any[] {
	if (!node || typeof node !== "object" || seen.has(node)) return out;
	seen.add(node);
	if (Array.isArray(node)) {
		for (const n of node) collectType(n, type, out, seen);
		return out;
	}
	const t = node["@type"];
	if (t === type || (Array.isArray(t) && t.includes(type))) out.push(node);
	for (const v of Object.values(node)) collectType(v, type, out, seen);
	return out;
}

const firstOffer = (n: any): any => (Array.isArray(n?.offers) ? n.offers[0] : n?.offers);

function offerPrice(n: any): number | null {
	const o = firstOffer(n);
	const v = Number(o?.price ?? o?.lowPrice);
	return Number.isFinite(v) && v > 0 ? v : null;
}

const inStock = (n: any): boolean => {
	const a = String(firstOffer(n)?.availability ?? "");
	// Absent availability is treated as sellable — never reject for missing data.
	return !a || a.endsWith("InStock");
};

/**
 * A variant's pack size.
 *
 * The shop's own `weight` field first — it is structured and unambiguous. The variant
 * NAME is only a fallback, and it goes through `marketplaceSize` rather than a local
 * regex so the multi-size and range rejections apply here too.
 */
/**
 * **The size the page shows but the JSON-LD leaves out.**
 *
 * ⚠️ The module's rule is unchanged — a variant whose size is not PUBLISHED is still
 * dropped. This only widens where the published size is looked for. Measured 2026-09-08
 * on `essential-whey-protein`: of ten in-stock variants, three carry a `weight` field
 * (the 2.25 kg ones) and the other seven are named "Essential Whey Protein Unflavoured"
 * with no size anywhere in the JSON-LD — while the page's own variant list names them
 * in full, "Essential Whey Protein - 375G - 15servings - Unflavoured".
 *
 * ⚠️⚠️ **Dropping them is not neutral, it is biased toward the big pack.** The user's
 * rule is cheapest per kg or litre and a smaller pack is perfectly acceptable — the size
 * ceiling exists to stop packs being too BIG, never too small. Reading only the variants
 * that happen to publish a `weight` meant this shop could only ever offer its bulk tubs,
 * so a 375 g pack at a better rate per kilo would never have been seen.
 *
 * Keyed by the image id, which is the variant sku — the only place the two are joined in
 * this blob. A variant whose flavour the page did not ship images for is simply absent,
 * and falls back to the JSON-LD as before.
 */
export function variantTitleSizes(html: string): Map<string, string> {
	const flat = html.replace(/\s+/g, " ");
	const out = new Map<string, string>();
	const re = new RegExp("\"title\":\"([^\"]{4,160})\",[^\"]{0,20}\"images\":[^\"]{0,20}\"original\":\"[^\"]*?productimg.original.([0-9]{6,10})", "g");
	for (const m of flat.matchAll(re)) if (!out.has(m[2]!)) out.set(m[2]!, m[1]!);
	return out;
}

function variantSize(
	v: any,
	titles: Map<string, string> = new Map(),
): { grams: number; volumetric: boolean } | null {
	const value = Number(v?.weight?.value);
	const unit = String(v?.weight?.unitText ?? "").trim();
	if (Number.isFinite(value) && value > 0 && unit) {
		const parsed = marketplaceSize(`${value}${unit}`);
		if (parsed.ok) return { grams: parsed.grams, volumetric: parsed.volumetric };
	}
	const fromName = marketplaceSize(String(v?.name ?? ""));
	if (fromName.ok) return { grams: fromName.grams, volumetric: fromName.volumetric };
	// Last, and only for a variant the two sources above could not size: the page's own
	// display title for this sku.
	const shown = titles.get(String(v?.sku ?? ""));
	if (!shown) return null;
	const fromShown = marketplaceSize(shown);
	return fromShown.ok ? { grams: fromShown.grams, volumetric: fromShown.volumetric } : null;
}

/** Flatten one product page's ProductGroup into one StoreProduct per usable variant. */
function productsFromPage(html: string, pageUrl: string): StoreProduct[] {
	const blocks = jsonLdBlocks(html);
	const titles = variantTitleSizes(html);
	const out: StoreProduct[] = [];

	for (const block of blocks) {
		for (const group of collectType(block, "ProductGroup")) {
			const brand =
				typeof group?.brand === "string" ? group.brand : (group?.brand?.name ?? "Myprotein");
			const variants: any[] = Array.isArray(group.hasVariant) ? group.hasVariant : [];

			for (const v of variants) {
				if (!inStock(v)) continue;
				const price = offerPrice(v);
				if (price == null) continue;
				const size = variantSize(v, titles);
				if (!size) continue; // ⚠️ no stated weight → no data. See the module note.

				const name = String(v.name ?? group.name ?? "").trim();
				if (!name) continue;

				out.push({
					store: "My Protein",
					name,
					brand,
					priceSgd: price,
					packWeightG: size.grams,
					volumetric: size.volumetric,
					unitCount: null,
					pricePer100g: (price / size.grams) * 100,
					dietaryAttributes: [],
					onSale: false,
					listPriceSgd: null,
					saleEndsAt: null,
					// Variants carry no URL of their own; the group page plus the variation
					// id is the stable deep link to the exact tub this price belongs to.
					url: v.sku ? `${pageUrl}?variation=${v.sku}` : pageUrl,
					raw: v,
				});
			}
		}
	}
	return out;
}

export class MyProtein implements StoreModule {
	readonly name = "My Protein";

	async search(term: string): Promise<StoreProduct[]> {
		const html = await get(`${BASE}/search/?q=${encodeURIComponent(term)}`);

		// The search payload gives name + price + url and NO size — which is why it is
		// used only to find the pages worth opening, never as a source of prices.
		const hits: { url: string }[] = [];
		for (const block of jsonLdBlocks(html)) {
			for (const p of collectType(block, "Product")) {
				const href = String(p.url ?? "").trim();
				if (!href) continue;
				const abs = href.startsWith("http") ? href : `${BASE}${href}`;
				if (!hits.some((h) => h.url === abs)) hits.push({ url: abs });
			}
		}

		const out: StoreProduct[] = [];
		for (const [i, hit] of hits.slice(0, MAX_PRODUCT_PAGES).entries()) {
			if (i) await sleep(DELAY_MS);
			try {
				out.push(...productsFromPage(await get(hit.url), hit.url));
			} catch (e) {
				// One unreadable product page must not lose the other four.
				console.error(`  MyProtein: ${hit.url} — ${(e as Error).message}`);
			}
		}
		return out;
	}
}

export const myprotein = new MyProtein();
