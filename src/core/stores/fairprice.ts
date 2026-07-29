import type { StoreModule, StoreProduct } from "./types.js";
import { parseWeight, parseUnitCount } from "./weight.js";

/**
 * FairPrice store module (store #1, reference build).
 *
 * Approach: FairPrice's search page is server-rendered (Next.js). We fetch
 * `/search?query=<term>`, extract the `__NEXT_DATA__` JSON, and read the product
 * collection. No auth required. A lighter direct JSON endpoint exists but its
 * params aren't documented; the SSR route is stable — revisit as an optimization.
 * (See LEARNINGS 2026-07-27.)
 */

const BASE = "https://www.fairprice.com.sg";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function extractNextData(html: string): any | null {
	const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

/** Recursively collect FairPrice product objects (have name + final_price + slug). */
function collectProducts(node: any, seen = new Set<any>(), out: any[] = []): any[] {
	if (!node || typeof node !== "object" || seen.has(node)) return out;
	seen.add(node);
	if (Array.isArray(node)) {
		for (const el of node) collectProducts(el, seen, out);
	} else {
		if ("name" in node && "final_price" in node && "slug" in node) out.push(node);
		for (const k of Object.keys(node)) collectProducts(node[k], seen, out);
	}
	return out;
}

function mapProduct(p: any): StoreProduct {
	const meta = p.metaData ?? {};
	// DisplayUnit is the accurate human size ("1.89L", "830ml", "10 x 100ml").
	const pw = parseWeight(meta.DisplayUnit) ?? parseWeight(meta["Unit Of Weight"]);
	// A count/loose pack ("1 per pack", "1S", "10s") has no meaningful weight.
	const unitCount = parseUnitCount(meta.DisplayUnit) ?? parseUnitCount(meta["Unit Of Weight"]);

	// The `Weight` field is an unreliable placeholder — "1 gm" for a 1-per-pack
	// bunch of bananas, "2 gm" for 2 L milk — so only fall back to it when the
	// reliable fields gave nothing AND this isn't a known count pack. That stops a
	// count item from being priced as a bogus 1 g pack ($545/100g).
	let packWeightG = pw?.grams ?? null;
	let volumetric = pw?.volumetric ?? false;
	if (packWeightG == null && unitCount == null) {
		const w = parseWeight(meta.Weight);
		if (w) {
			packWeightG = w.grams;
			volumetric = w.volumetric;
		}
	}

	const price = Number(p.final_price);
	const ssd = Array.isArray(p.storeSpecificData) ? p.storeSpecificData[0] : undefined;
	const mrp = ssd?.mrp != null ? Number(ssd.mrp) : null;
	const onSale = mrp != null && mrp > price + 1e-9;

	return {
		store: "FairPrice",
		name: p.name,
		brand: p.brand?.name,
		priceSgd: price,
		packWeightG,
		volumetric,
		unitCount,
		pricePer100g: packWeightG && packWeightG > 0 ? (price / packWeightG) * 100 : null,
		onSale,
		listPriceSgd: onSale ? mrp : null,
		saleEndsAt: null, // FairPrice search payload doesn't expose a promo end date
		url: `${BASE}/product/${p.slug}`,
		raw: p,
	};
}

export const fairprice: StoreModule = {
	name: "FairPrice",
	async search(term: string): Promise<StoreProduct[]> {
		const url = `${BASE}/search?query=${encodeURIComponent(term)}`;
		const res = await fetch(url, {
			headers: { "User-Agent": UA, Accept: "text/html" },
		});
		if (!res.ok) throw new Error(`FairPrice search "${term}" → HTTP ${res.status}`);
		const html = await res.text();
		const data = extractNextData(html);
		if (!data) throw new Error(`FairPrice search "${term}": no __NEXT_DATA__`);
		const products = collectProducts(data.props?.pageProps?.data ?? data);
		return products.map(mapProduct);
	},
};
